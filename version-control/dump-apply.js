// scripts/dump-apply.js
const fs = require("fs");
const path = require("path");
const { validateDumpText } = require("./dump-validator");

const ROOT = process.cwd();
const STATE_PATH = path.join(ROOT, ".repo_state.json");
const VERSIONS_DIR = path.join(ROOT, "versions");
const README_DIR = path.join(VERSIONS_DIR, "readme");

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

function extractReadmeRaw(text) {
  const start = text.indexOf("---README---\n");
  if (start === -1) return null;
  const end = text.indexOf("---__META__---", start);
  return text
    .slice(start + 13, end === -1 ? undefined : end)
    .trimEnd();
}

function applyDumpFile(dumpPath) {
  ensureDir(VERSIONS_DIR);
  ensureDir(README_DIR);

  const dumpText = fs.readFileSync(dumpPath, "utf8");
  const parsed = validateDumpText(dumpText);

  for (const w of parsed.warnings) {
    console.warn(`[dump:apply] WARN: ${w}`);
  }

  for (const [rel, content] of parsed.files.entries()) {
    const outPath = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content, "utf8");
  }

  const readme =
    parsed.readmeText || extractReadmeRaw(dumpText);

  if (readme) {
    const out = path.join(
      README_DIR,
      `README_${parsed.meta.version}.md`
    );
    fs.writeFileSync(out, readme + "\n");
  }

  const state = loadState();
  const entry = {
    version: parsed.meta.version,
    appliedAt: new Date().toISOString(),
    fileCount: parsed.files.size,
  };

  state.active = entry;
  state.history.push(entry);
  saveState(state);

  return entry;
}

if (require.main === module) {
  const dumpPath = process.argv[2] || "dump.txt";
  const res = applyDumpFile(dumpPath);
  console.log(`Applied ${res.version}`);
}

module.exports = { applyDumpFile };

