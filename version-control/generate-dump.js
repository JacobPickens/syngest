// scripts/generate-dump.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = process.cwd();
const STATE_PATH = path.join(ROOT, ".repo_state.json");
const VERSIONS_DIR = path.join(ROOT, "versions");

const CHITCONFIG_PATH = path.join(ROOT, ".chitconfig");

// Toolchain version
const TOOLCHAIN_VERSION = "tc-2026-02-02-7";

// Special embedded sections (not repo files)
const CHITCONFIG_SECTION = "__CHITCONFIG__";
const DUMP_SCRIPTS_PREFIX = "__DUMP_SCRIPTS__/";

// Embedded toolchain scripts (fixed order)
const DUMP_SCRIPT_FILES = [
  "generate-dump.js",
  "dump-validator.js",
  "dump-apply.js",
  "dump-undo.js",
  "print-active.js",
];

// Hard exclusions (cannot be overridden by allow/ignore)
const HARD_EXCLUDE_EXACT = new Set(["middleware/fingerer.js"]);

// Built-in ignores (cannot be overridden)
const HARD_IGNORE_PREFIXES = ["node_modules/", ".git/", "versions/"];
const HARD_IGNORE_EXACT = new Set([".repo_state.json", "dump.txt"]);

// Do not include these as repo file sections (managed separately)
const SPECIAL_MANAGED_EXACT = new Set([
  ".chitconfig",
  "scripts/generate-dump.js",
  "scripts/dump-validator.js",
  "scripts/dump-apply.js",
  "scripts/dump-undo.js",
  "scripts/print-active.js",
]);

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { active: null };
  }
}

function readUtf8IfExists(p, fallback = "") {
  try {
    if (!fs.existsSync(p)) return fallback;
    return fs.readFileSync(p, "utf8");
  } catch {
    return fallback;
  }
}

function normalizeLF(s) {
  return String(s || "").replace(/\r\n/g, "\n");
}

function safeSectionBoundary(name) {
  return String(name).replace(/\r?\n/g, "").trim();
}

function readFileUtf8(p) {
  return fs.readFileSync(p, "utf8");
}

function computeSha256Hex(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * gitignore-like pattern engine, used for BOTH ignore and allow lists.
 * - supports: comments (#), blanks, negation (!), globs (*, ?, **), trailing / (dir),
 *             leading / anchored to root.
 * - rule order matters; last match wins.
 */
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

function globToRegExp(glob) {
  let g = String(glob);
  g = g.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  g = g.replace(/\\\*\\\*/g, ".*");
  g = g.replace(/\\\*/g, "[^/]*");
  g = g.replace(/\\\?/g, "[^/]");
  return new RegExp(`^${g}$`);
}

function parseChitconfig(raw) {
  const txt = normalizeLF(raw || "").trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function defaultChitconfigRaw() {
  // IMPORTANT:
  // This is a *self-documenting* template so users can see every editable field + allowed values.
  // The validator ignores unknown keys; "docs" is informational only.
  const template = {
    validatorMode: "default", // "default" | "strict"
    checks: {
      // Each check value: "default" | "strict"
      configInvalidJson: "default",
      localChitconfigDiff: "default",
      toolchainVersionMismatch: "default",
      ordering: "default",
      ignoredFilesPresent: "default",
      missingToolchainVersionField: "default",
      allowlistViolation: "default",
    },
    filters: {
      // Pattern syntax is gitignore-like:
      // - "*" matches within a path segment
      // - "**" matches across directories
      // - "?" single char within a segment
      // - leading "/" anchors to repo root
      // - trailing "/" targets directories
      // - leading "!" negates (re-include)
      //
      // Semantics:
      // - allow empty => allow ALL files (except hard excludes/ignores)
      // - allow non-empty => include ONLY files that match allow
      // - ignore always excludes unless allow explicitly matches (allow overrides ignore)
      allow: [],
      ignore: [],
    },
    docs: {
      allowedValues: {
        validatorMode: ["default", "strict"],
        checkLevel: ["default", "strict"],
      },
      checkIds: [
        "configInvalidJson",
        "localChitconfigDiff",
        "toolchainVersionMismatch",
        "ordering",
        "ignoredFilesPresent",
        "missingToolchainVersionField",
        "allowlistViolation",
      ],
      checkMeanings: {
        configInvalidJson:
          "Embedded .chitconfig in the dump was invalid JSON; validator fell back to defaults.",
        localChitconfigDiff:
          "Local .chitconfig differs from the embedded __CHITCONFIG__ section (local will be overwritten on apply).",
        toolchainVersionMismatch:
          "Dump toolchainVersion differs from local toolchainVersion (apply overwrites toolchain anyway).",
        ordering:
          "Repo file sections are not lexicographically ordered (required by contract).",
        ignoredFilesPresent:
          "Dump contains repo files that filters.ignore would exclude AND they are not re-allowed by filters.allow.",
        missingToolchainVersionField:
          "__META__.toolchainVersion missing (current contract expects it).",
        allowlistViolation:
          "If filters.allow is non-empty: dump contains files not matched by allow patterns.",
      },
      patternExamples: {
        allow_src_only: ["src/**", "package.json", "scripts/**"],
        ignore_logs_and_dist: ["*.log", "dist/**"],
        reinclude_one_file: ["dist/**", "!dist/keep.txt"],
        anchor_to_root: ["/views/**"],
        directory_only: ["build/"],
      },
      hardRules: {
        hardExcludeExact: ["middleware/fingerer.js"],
        hardIgnorePrefixes: ["node_modules/", ".git/", "versions/"],
        hardIgnoreExact: [".repo_state.json", "dump.txt"],
        managedNotRepoSections: [
          ".chitconfig",
          "scripts/generate-dump.js",
          "scripts/dump-validator.js",
          "scripts/dump-apply.js",
          "scripts/dump-undo.js",
          "scripts/print-active.js",
        ],
      },
      effectiveInclusionLogic: [
        "1) hard excludes/ignores always excluded",
        "2) if allow list empty => allowed=true for all (subject to hard rules)",
        "3) if allow list non-empty => allowed=true only if allow matches",
        "4) if ignore matches and allow does NOT match => excluded",
        "5) allow overrides ignore (unless hard-excluded)",
      ],
    },
  };

  return JSON.stringify(template, null, 2) + "\n";
}

function loadChitconfigRaw() {
  const raw = readUtf8IfExists(CHITCONFIG_PATH, "");
  return raw.trim() ? normalizeLF(raw) : defaultChitconfigRaw();
}

function isHardIgnored(relNorm) {
  if (HARD_EXCLUDE_EXACT.has(relNorm)) return true;
  if (HARD_IGNORE_EXACT.has(relNorm)) return true;
  for (const pref of HARD_IGNORE_PREFIXES) {
    if (relNorm.startsWith(pref)) return true;
  }
  return false;
}

function shouldInclude(relNorm, allowMatcher, ignoreMatcher) {
  if (isHardIgnored(relNorm)) return false;
  if (SPECIAL_MANAGED_EXACT.has(relNorm)) return false;

  const allowHas = allowMatcher.hasRules;
  const allowed = allowHas ? allowMatcher.matches(relNorm) : true; // empty allow => allow all
  if (!allowed) return false;

  const ignored = ignoreMatcher.hasRules ? ignoreMatcher.matches(relNorm) : false;
  // allow overrides ignore (unless hard ignored above)
  return ignored ? allowed : true;
}

function walkAllRepoFiles(absDir, relDir, out, allowMatcher, ignoreMatcher) {
  for (const name of fs.readdirSync(absDir)) {
    const abs = path.join(absDir, name);
    const rel = relDir ? path.posix.join(relDir, name) : name;
    const relNorm = rel.replace(/\\/g, "/");

    // Directory hard-ignore short-circuit (performance)
    if (HARD_IGNORE_PREFIXES.some((p) => relNorm.startsWith(p))) continue;

    const st = fs.statSync(abs);

    if (st.isDirectory()) {
      walkAllRepoFiles(abs, relNorm, out, allowMatcher, ignoreMatcher);
    } else if (st.isFile()) {
      if (shouldInclude(relNorm, allowMatcher, ignoreMatcher)) {
        out.push(relNorm);
      }
    }
  }
}

function collectRepoFiles(allowMatcher, ignoreMatcher) {
  const out = [];
  walkAllRepoFiles(ROOT, "", out, allowMatcher, ignoreMatcher);
  return out.sort();
}

function generateDump() {
  ensureDir(VERSIONS_DIR);

  const state = loadState();
  const version =
    process.env.npm_config_version || state.active?.version || "v0.0.0";

  const chitconfigRaw = loadChitconfigRaw();
  const cfgObj = parseChitconfig(chitconfigRaw) || {};

  const allowPatterns = cfgObj?.filters?.allow || [];
  const ignorePatterns = cfgObj?.filters?.ignore || [];

  const allowMatcher = compilePatternList(allowPatterns);
  const ignoreMatcher = compilePatternList(ignorePatterns);

  const repoFiles = collectRepoFiles(allowMatcher, ignoreMatcher);

  let body = "";

  // (1) __CHITCONFIG__ always first
  body += `---${safeSectionBoundary(CHITCONFIG_SECTION)}---\n`;
  body += chitconfigRaw;
  if (!body.endsWith("\n")) body += "\n";

  // (2) toolchain scripts
  for (const name of DUMP_SCRIPT_FILES) {
    const p = path.join(__dirname, name);
    if (!fs.existsSync(p)) {
      throw new Error(`Missing required dump script: scripts/${name}`);
    }
    const content = readFileUtf8(p);
    const sectionName = `${DUMP_SCRIPTS_PREFIX}${name}`;
    body += `---${safeSectionBoundary(sectionName)}---\n`;
    body += content;
    if (!body.endsWith("\n")) body += "\n";
  }

  // (3) repo files (lexicographic)
  const manifest = [];
  for (const rel of repoFiles) {
    if (HARD_EXCLUDE_EXACT.has(rel)) continue;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;

    const content = readFileUtf8(abs);
    body += `---${safeSectionBoundary(rel)}---\n`;
    body += content;
    if (!body.endsWith("\n")) body += "\n";
    manifest.push(rel);
  }

  // (4) README stub
  body += `---README---\n`;
  body += `# Dump README\n\nGenerated snapshot.\n\n`;

  // sha256 over bytes above META boundary (including boundary line)
  const metaBoundary = "---__META__---\n";
  const sha256 = computeSha256Hex(body + metaBoundary);

  body += metaBoundary;
  body +=
    JSON.stringify(
      {
        version,
        toolchainVersion: TOOLCHAIN_VERSION,
        manifest,
        sha256,
      },
      null,
      2
    ) + "\n";

  const outPath = path.join(VERSIONS_DIR, `dump_${version}.txt`);
  fs.writeFileSync(outPath, body, "utf8");
  console.log(`Generated ${path.relative(ROOT, outPath)}`);
}

if (require.main === module) {
  generateDump();
}

module.exports = { generateDump, TOOLCHAIN_VERSION };
