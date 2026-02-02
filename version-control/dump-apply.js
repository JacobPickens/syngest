// scripts/dump-apply.js
const fs = require("fs");
const path = require("path");
const { validateDumpText, TOOLCHAIN_VERSION } = require("./dump-validator");

const ROOT = process.cwd();
const STATE_PATH = path.join(ROOT, ".repo_state.json");
const VERSIONS_DIR = path.join(ROOT, "versions");
const README_DIR = path.join(VERSIONS_DIR, "readme");

const SCRIPTS_DIR = path.join(ROOT, "scripts");
const CHITCONFIG_PATH = path.join(ROOT, ".chitconfig");

// Toolchain scripts written from embedded dump (authoritative)
const TOOLCHAIN_SCRIPTS = new Set([
  "generate-dump.js",
  "dump-validator.js",
  "dump-apply.js",
  "dump-undo.js",
  "print-active.js",
]);

// Never delete/manage these as “repo files”
const HARD_IGNORE_PREFIXES = ["node_modules/", ".git/", "versions/"];
const HARD_IGNORE_EXACT = new Set([".repo_state.json", "dump.txt"]);
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
    return { active: null, history: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function writeAtomic(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

function normalizeLF(s) {
  return String(s || "").replace(/\r\n/g, "\n");
}

function extractReadmeRaw(text) {
  const start = text.indexOf("---README---\n");
  if (start === -1) return null;
  const end = text.indexOf("---__META__---", start);
  return text.slice(start + 13, end === -1 ? undefined : end).trimEnd();
}

function safeScriptName(name) {
  const n = String(name || "").trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(n)) return null;
  return n;
}

function isProtectedFromDelete(rel) {
  const r = rel.replace(/\\/g, "/");
  if (HARD_IGNORE_EXACT.has(r)) return true;
  if (SPECIAL_MANAGED_EXACT.has(r)) return true;
  for (const pref of HARD_IGNORE_PREFIXES) {
    if (r.startsWith(pref)) return true;
  }
  return false;
}

function tryRemoveEmptyDirsUpwards(startDirAbs) {
  let current = startDirAbs;
  const root = ROOT;

  while (current && current.startsWith(root) && current !== root) {
    try {
      const entries = fs.readdirSync(current);
      if (entries.length) break;
      fs.rmdirSync(current);
      current = path.dirname(current);
    } catch {
      break;
    }
  }
}

function applyDumpFile(dumpPath) {
  ensureDir(VERSIONS_DIR);
  ensureDir(README_DIR);
  ensureDir(SCRIPTS_DIR);

  const dumpText = fs.readFileSync(dumpPath, "utf8");
  const parsed = validateDumpText(dumpText);

  for (const w of parsed.warnings) {
    console.warn(`[chit:apply] WARN: ${w}`);
  }

  if (
    typeof parsed.meta.toolchainVersion === "string" &&
    parsed.meta.toolchainVersion !== TOOLCHAIN_VERSION
  ) {
    console.warn(
      `[chit:apply] WARN: Applying dump toolchainVersion=${parsed.meta.toolchainVersion} using local toolchainVersion=${TOOLCHAIN_VERSION}. (OK; toolchain will be overwritten.)`
    );
  }

  const prevState = loadState();
  const prevManifest = Array.isArray(prevState?.active?.manifest)
    ? prevState.active.manifest
    : null;

  // (1) Overwrite local .chitconfig using embedded section
  writeAtomic(CHITCONFIG_PATH, normalizeLF(parsed.chitconfigText).trimEnd() + "\n");

  // (2) Overwrite toolchain scripts from embedded dump (authoritative)
  for (const [scriptNameRaw, content] of parsed.dumpScripts.entries()) {
    const scriptName = safeScriptName(scriptNameRaw);
    if (!scriptName) continue;
    if (!TOOLCHAIN_SCRIPTS.has(scriptName)) continue;

    const outPath = path.join(SCRIPTS_DIR, scriptName);
    writeAtomic(outPath, normalizeLF(content).trimEnd() + "\n");
  }

  // (3) Apply repo files from dump
  for (const rel of parsed.fileOrder) {
    const content = parsed.files.get(rel);
    const r = String(rel || "").replace(/\\/g, "/");
    if (!r) continue;

    // Managed/toolchain files are blocked by validator, but keep a safety belt.
    if (isProtectedFromDelete(r)) continue;

    const outPath = path.join(ROOT, r);
    ensureDir(path.dirname(outPath));
    writeAtomic(outPath, String(content || ""));
  }

  // (4) Delete stale files from previous manifest missing in new manifest
  if (Array.isArray(prevManifest)) {
    const nowSet = new Set(parsed.fileOrder.map((x) => String(x).replace(/\\/g, "/")));
    for (const oldRelRaw of prevManifest) {
      const oldRel = String(oldRelRaw || "").replace(/\\/g, "/");
      if (!oldRel) continue;
      if (isProtectedFromDelete(oldRel)) continue;
      if (nowSet.has(oldRel)) continue;

      const abs = path.join(ROOT, oldRel);
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          fs.unlinkSync(abs);
          console.warn(`[chit:apply] Removed stale file: ${oldRel}`);
          tryRemoveEmptyDirsUpwards(path.dirname(abs));
        }
      } catch (e) {
        console.warn(`[chit:apply] WARN: Failed removing ${oldRel}: ${e.message}`);
      }
    }
  }

  // (5) README sidecar (optional)
  const readme = parsed.readmeText || extractReadmeRaw(dumpText);
  if (readme) {
    const out = path.join(README_DIR, `README_${parsed.meta.version}.md`);
    writeAtomic(out, readme + "\n");
  }

  // (6) Update repo state
  const state = loadState();
  const entry = {
    version: parsed.meta.version,
    toolchainVersion: parsed.meta.toolchainVersion || null,
    appliedAt: new Date().toISOString(),
    fileCount: parsed.fileOrder.length,
    manifest: parsed.fileOrder.slice(),
    validatorConfig: parsed.validatorConfig || null,
  };

  state.active = entry;
  state.history = Array.isArray(state.history) ? state.history : [];
  state.history.push({
    version: entry.version,
    toolchainVersion: entry.toolchainVersion,
    appliedAt: entry.appliedAt,
    fileCount: entry.fileCount,
    validatorMode: entry.validatorConfig?.validatorMode || "default",
  });
  saveState(state);

  return entry;
}

if (require.main === module) {
  const dumpPath = process.argv[2] || "dump.txt";
  const res = applyDumpFile(dumpPath);
  console.log(`Applied ${res.version}`);
}

module.exports = { applyDumpFile };
