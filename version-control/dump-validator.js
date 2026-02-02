// scripts/dump-validator.js
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Local toolchain version (warn comparison only)
const TOOLCHAIN_VERSION = "tc-2026-02-02-7";

const ROOT = process.cwd();
const CHITCONFIG_PATH = path.join(ROOT, ".chitconfig");

// Embedded sections
const CHITCONFIG_SECTION = "__CHITCONFIG__";
const DUMP_SCRIPTS_PREFIX = "__DUMP_SCRIPTS__/";

// Required embedded scripts
const REQUIRED_DUMP_SCRIPTS = new Set([
  "generate-dump.js",
  "dump-validator.js",
  "dump-apply.js",
  "dump-undo.js",
  "print-active.js",
]);

// Hard exclusions/ignores
const HARD_EXCLUDE_EXACT = new Set(["middleware/fingerer.js"]);
const HARD_IGNORE_PREFIXES = ["node_modules/", ".git/", "versions/"];
const HARD_IGNORE_EXACT = new Set([".repo_state.json", "dump.txt"]);

// Managed/toolchain files must not appear as repo file sections
const SPECIAL_MANAGED_EXACT = new Set([
  ".chitconfig",
  "scripts/generate-dump.js",
  "scripts/dump-validator.js",
  "scripts/dump-apply.js",
  "scripts/dump-undo.js",
  "scripts/print-active.js",
]);

const CHECK_IDS = {
  CONFIG_INVALID_JSON: "configInvalidJson",
  LOCAL_CHITCONFIG_DIFF: "localChitconfigDiff",
  TOOLCHAIN_MISMATCH: "toolchainVersionMismatch",
  ORDERING: "ordering",
  IGNORED_FILES_PRESENT: "ignoredFilesPresent",
  MISSING_TOOLCHAIN_VERSION_FIELD: "missingToolchainVersionField",
  ALLOWLIST_VIOLATION: "allowlistViolation",
};

function normalizeLF(s) {
  return String(s || "").replace(/\r\n/g, "\n");
}

function isBoundaryLine(line) {
  return /^---[^-\n].*---$/.test(line.trim());
}

function boundaryName(line) {
  return line.trim().slice(3, -3);
}

function normalizeRel(p) {
  return String(p).replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function computeSha256Hex(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function globToRegExp(glob) {
  let g = String(glob);
  g = g.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  g = g.replace(/\\\*\\\*/g, ".*");
  g = g.replace(/\\\*/g, "[^/]*");
  g = g.replace(/\\\?/g, "[^/]");
  return new RegExp(`^${g}$`);
}

function compilePatternList(patterns) {
  const lines = normalizeLF(
    Array.isArray(patterns) ? patterns.join("\n") : String(patterns || "")
  )
    .split("\n")
    .map((l) => l.trimEnd());

  const rules = [];

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;

    let neg = false;
    let pat = trimmed;
    if (pat.startsWith("!")) {
      neg = true;
      pat = pat.slice(1);
      if (!pat) continue;
    }

    pat = pat.replace(/\\/g, "/");

    const dirOnly = pat.endsWith("/");
    if (dirOnly) pat = pat.slice(0, -1);

    const anchored = pat.startsWith("/");
    if (anchored) pat = pat.slice(1);

    const hasSlash = pat.includes("/");
    const re = globToRegExp(pat);

    rules.push({ neg, dirOnly, anchored, hasSlash, re });
  }

  function matchesRule(rule, relPath) {
    const p = relPath;

    if (rule.dirOnly) {
      if (rule.hasSlash) {
        const parts = p.split("/");
        let acc = "";
        for (let i = 0; i < parts.length; i++) {
          acc = i === 0 ? parts[i] : acc + "/" + parts[i];
          if (rule.re.test(acc)) return true;
        }
        return false;
      } else {
        const parts = p.split("/");
        for (const seg of parts.slice(0, -1)) {
          if (rule.re.test(seg)) return true;
        }
        return false;
      }
    }

    if (rule.anchored) return rule.re.test(p);
    if (rule.hasSlash) return rule.re.test(p) || rule.re.test(`x/${p}`);

    const parts = p.split("/");
    for (const seg of parts) {
      if (rule.re.test(seg)) return true;
    }
    return false;
  }

  function matches(relPath) {
    const p = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    let result = false;
    let saw = false;

    for (const rule of rules) {
      if (matchesRule(rule, p)) {
        saw = true;
        result = !rule.neg;
      }
    }
    return saw ? result : false;
  }

  return { matches, hasRules: rules.length > 0 };
}

function defaultValidatorConfig() {
  return {
    validatorMode: "default",
    checks: {
      [CHECK_IDS.CONFIG_INVALID_JSON]: "default",
      [CHECK_IDS.LOCAL_CHITCONFIG_DIFF]: "default",
      [CHECK_IDS.TOOLCHAIN_MISMATCH]: "default",
      [CHECK_IDS.ORDERING]: "default",
      [CHECK_IDS.IGNORED_FILES_PRESENT]: "default",
      [CHECK_IDS.MISSING_TOOLCHAIN_VERSION_FIELD]: "default",
      [CHECK_IDS.ALLOWLIST_VIOLATION]: "default",
    },
    filters: { allow: [], ignore: [] },
  };
}

function normalizeValidatorConfig(obj) {
  const base = defaultValidatorConfig();

  const mode = obj?.validatorMode;
  base.validatorMode = mode === "strict" ? "strict" : "default";

  const checks = obj?.checks && typeof obj.checks === "object" ? obj.checks : {};
  for (const k of Object.keys(base.checks)) {
    const v = checks[k];
    base.checks[k] = v === "strict" ? "strict" : "default";
  }

  if (obj?.filters && typeof obj.filters === "object") {
    base.filters.allow = obj.filters.allow ?? base.filters.allow;
    base.filters.ignore = obj.filters.ignore ?? base.filters.ignore;
  }

  return base;
}

function parseChitconfig(raw) {
  const txt = normalizeLF(raw || "").trim();
  if (!txt) return { config: defaultValidatorConfig(), invalidJson: false };

  try {
    const obj = JSON.parse(txt);
    return { config: normalizeValidatorConfig(obj), invalidJson: false };
  } catch {
    return { config: defaultValidatorConfig(), invalidJson: true };
  }
}

function shouldPromoteWarning(checkId, validatorCfg) {
  const cfg = validatorCfg || defaultValidatorConfig();

  if (cfg.validatorMode === "strict") {
    return cfg.checks?.[checkId] !== "default";
  }
  return cfg.checks?.[checkId] === "strict";
}

function isHardIgnored(relNorm) {
  if (HARD_EXCLUDE_EXACT.has(relNorm)) return true;
  if (HARD_IGNORE_EXACT.has(relNorm)) return true;
  for (const pref of HARD_IGNORE_PREFIXES) {
    if (relNorm.startsWith(pref)) return true;
  }
  return false;
}

function validateDumpText(dumpText) {
  const warnings = [];
  const warningsMeta = [];

  function addWarning(checkId, message) {
    warnings.push(message);
    warningsMeta.push({ checkId, message });
  }

  if (typeof dumpText !== "string" || !dumpText.length) {
    throw new Error("dump is empty or invalid");
  }

  const metaBoundary = "---__META__---\n";
  const idx = dumpText.lastIndexOf(metaBoundary);
  if (idx === -1) throw new Error("Missing __META__ footer");

  const aboveMeta = dumpText.slice(0, idx) + metaBoundary;
  const metaText = dumpText.slice(idx + metaBoundary.length);

  let meta;
  try {
    meta = JSON.parse(metaText.trim());
  } catch {
    throw new Error("Invalid __META__ JSON");
  }

  if (!meta.version || typeof meta.version !== "string") {
    throw new Error("__META__.version is required");
  }
  if (!Array.isArray(meta.manifest)) {
    throw new Error("__META__.manifest is required and must be an array");
  }
  if (!meta.sha256 || typeof meta.sha256 !== "string") {
    throw new Error("__META__.sha256 is required and must be a string");
  }

  if (!("toolchainVersion" in meta)) {
    addWarning(CHECK_IDS.MISSING_TOOLCHAIN_VERSION_FIELD, "__META__.toolchainVersion missing");
  } else if (typeof meta.toolchainVersion !== "string") {
    throw new Error("__META__.toolchainVersion must be a string");
  }

  const lines = normalizeLF(aboveMeta).split("\n");

  let chitconfigText = null;
  const dumpScripts = new Map();
  const files = [];
  const fileMap = new Map();
  let readmeText = null;

  let mode = "none";
  let currentName = null;
  let buf = [];
  let readmeBuf = [];

  let firstBoundarySeen = false;
  let seenChitconfig = false;
  let readmeStarted = false;

  function flush() {
    const content = buf.join("\n");
    if (mode === "chitconfig") chitconfigText = content;
    else if (mode === "script") dumpScripts.set(currentName, content);
    else if (mode === "file") {
      files.push(currentName);
      fileMap.set(currentName, content);
    }
    mode = "none";
    currentName = null;
    buf = [];
  }

  for (const line of lines) {
    if (isBoundaryLine(line)) {
      const name = normalizeRel(boundaryName(line));

      if (!firstBoundarySeen) {
        firstBoundarySeen = true;
        if (name !== CHITCONFIG_SECTION) {
          throw new Error(`First section must be ${CHITCONFIG_SECTION}`);
        }
      }

      if (mode !== "none") flush();

      if (name === CHITCONFIG_SECTION) {
        if (seenChitconfig) throw new Error(`Duplicate ${CHITCONFIG_SECTION} section`);
        seenChitconfig = true;
        mode = "chitconfig";
        continue;
      }

      if (name === "README") {
        readmeStarted = true;
        mode = "readme";
        continue;
      }

      if (name.startsWith(DUMP_SCRIPTS_PREFIX)) {
        if (!seenChitconfig) throw new Error(`Toolchain sections must appear after ${CHITCONFIG_SECTION}`);
        const scriptName = name.slice(DUMP_SCRIPTS_PREFIX.length);
        if (!scriptName) throw new Error("Empty dump script name");
        if (dumpScripts.has(scriptName)) throw new Error(`Duplicate dump script: ${scriptName}`);
        mode = "script";
        currentName = scriptName;
        continue;
      }

      if (!seenChitconfig) throw new Error(`Repo files must appear after ${CHITCONFIG_SECTION}`);
      if (readmeStarted) throw new Error("File found after README");
      if (HARD_EXCLUDE_EXACT.has(name)) throw new Error(`Forbidden file: ${name}`);
      if (SPECIAL_MANAGED_EXACT.has(name)) throw new Error(`Disallowed managed file in repo sections: ${name}`);
      if (fileMap.has(name)) throw new Error(`Duplicate file: ${name}`);
      if (isHardIgnored(name)) throw new Error(`Disallowed hard-ignored file in dump: ${name}`);

      mode = "file";
      currentName = name;
      continue;
    }

    if (mode === "readme") {
      readmeBuf.push(line);
      continue;
    }

    if (mode === "none") {
      if (line.trim() !== "") throw new Error("Content before first section boundary");
      continue;
    }

    buf.push(line);
  }

  if (mode !== "none") flush();
  if (readmeBuf.length) readmeText = readmeBuf.join("\n").trimEnd();

  if (chitconfigText === null) throw new Error(`Missing ${CHITCONFIG_SECTION} section`);

  for (const req of REQUIRED_DUMP_SCRIPTS) {
    if (!dumpScripts.has(req)) throw new Error(`Missing embedded dump script: ${req}`);
  }

  const parsedCfg = parseChitconfig(chitconfigText);
  const validatorCfg = parsedCfg.config;

  if (parsedCfg.invalidJson) {
    addWarning(CHECK_IDS.CONFIG_INVALID_JSON, "Embedded .chitconfig is invalid JSON; defaulting to validatorMode=default");
  }

  const computedSha = computeSha256Hex(aboveMeta);
  if (computedSha !== meta.sha256) {
    throw new Error(`sha256 mismatch: meta=${meta.sha256} computed=${computedSha}`);
  }

  const lexSorted = [...files].slice().sort();
  const isLex = files.every((v, i) => v === lexSorted[i]);
  if (!isLex) addWarning(CHECK_IDS.ORDERING, "Repo file sections are not lexicographically ordered");

  const manifest = meta.manifest.map((x) => normalizeRel(x));
  const manifestMatches =
    manifest.length === files.length &&
    manifest.every((v, i) => v === files[i]);

  if (!manifestMatches) {
    throw new Error("manifest does not match repo file sections exactly (names + order)");
  }

  const allowMatcher = compilePatternList(validatorCfg.filters?.allow || []);
  const ignoreMatcher = compilePatternList(validatorCfg.filters?.ignore || []);

  const ignoredButNotAllowed = files.filter((f) => {
    const ignored = ignoreMatcher.hasRules ? ignoreMatcher.matches(f) : false;
    if (!ignored) return false;
    const allowed = allowMatcher.hasRules ? allowMatcher.matches(f) : true;
    return !allowed;
  });

  if (ignoredButNotAllowed.length) {
    addWarning(
      CHECK_IDS.IGNORED_FILES_PRESENT,
      `.chitconfig filters.ignore would exclude files present in dump (and not re-allowed): ${ignoredButNotAllowed.join(", ")}`
    );
  }

  if (allowMatcher.hasRules) {
    const notAllowed = files.filter((f) => !allowMatcher.matches(f));
    if (notAllowed.length) {
      addWarning(
        CHECK_IDS.ALLOWLIST_VIOLATION,
        `.chitconfig filters.allow does not allow some files present in dump: ${notAllowed.join(", ")}`
      );
    }
  }

  if (typeof meta.toolchainVersion === "string" && meta.toolchainVersion !== TOOLCHAIN_VERSION) {
    addWarning(
      CHECK_IDS.TOOLCHAIN_MISMATCH,
      `Dump toolchainVersion (${meta.toolchainVersion}) differs from local toolchainVersion (${TOOLCHAIN_VERSION}) (local will be overwritten on apply)`
    );
  }

  const localCfgRaw = normalizeLF(fs.existsSync(CHITCONFIG_PATH) ? fs.readFileSync(CHITCONFIG_PATH, "utf8") : "");
  if (normalizeLF(localCfgRaw).trimEnd() !== normalizeLF(chitconfigText).trimEnd()) {
    addWarning(
      CHECK_IDS.LOCAL_CHITCONFIG_DIFF,
      "Local .chitconfig differs from embedded __CHITCONFIG__ (local will be overwritten on apply)"
    );
  }

  const promote = warningsMeta.filter((w) => shouldPromoteWarning(w.checkId, validatorCfg));
  if (promote.length) {
    throw new Error(
      `validator strictness triggered: ${promote.map((p) => `[${p.checkId}] ${p.message}`).join(" | ")}`
    );
  }

  return {
    files: fileMap,
    fileOrder: files,
    meta,
    readmeText,
    warnings,
    warningsMeta,
    chitconfigText,
    dumpScripts,
    validatorConfig: validatorCfg,
    localToolchainVersion: TOOLCHAIN_VERSION,
  };
}

module.exports = { validateDumpText, TOOLCHAIN_VERSION, CHECK_IDS };
