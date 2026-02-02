// scripts/generate-dump.js
const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const STATE_PATH = path.join(ROOT, ".repo_state.json");
const VERSIONS_DIR = path.join(ROOT, "versions");

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

function loadAllowed() {
  const p = path.join(__dirname, "ALLOWED.txt");
  if (!fs.existsSync(p)) throw new Error("Missing scripts/ALLOWED.txt");

  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith("#"));
}

function collectFiles(list) {
  const out = [];

  for (const entry of list) {
    const abs = path.join(ROOT, entry);
    if (!fs.existsSync(abs)) continue;

    const st = fs.statSync(abs);
    if (st.isFile()) out.push(entry);
    else if (st.isDirectory()) walk(abs, entry, out);
  }

  return out.sort();
}

function walk(abs, rel, out) {
  for (const name of fs.readdirSync(abs)) {
    const a = path.join(abs, name);
    const r = path.posix.join(rel, name);
    const st = fs.statSync(a);
    if (st.isDirectory()) walk(a, r, out);
    else if (st.isFile()) out.push(r);
  }
}

function generateDump() {
  ensureDir(VERSIONS_DIR);

  const state = loadState();
  const version =
    process.env.npm_config_version ||
    state.active?.version ||
    "v0.0.0";

  const allowed = loadAllowed();
  const files = collectFiles(allowed);

  let body = "";
  const manifest = [];

  for (const rel of files) {
    const content = fs.readFileSync(path.join(ROOT, rel), "utf8");
    body += `---${rel}---\n${content}\n`;
    manifest.push(rel);
  }

  const rollbackTarget =
    state.active?.version && state.active.version !== version
      ? String(state.active.version)
      : '';

  const dump =
    body +
    `---README---
` +
    `# Dump README

` +
    `Version: ${version}
` +
    `State: grazing
` +
    (rollbackTarget ? `Rollback target: ${rollbackTarget}
` : ``) +
    `
Generated snapshot.

` +
    `---__META__---
` +
    JSON.stringify(
      {
        version,
        manifest,
      },
      null,
      2
    ) +
    "
";

  const outPath = path.join(VERSIONS_DIR, `dump_${version}.txt`);
  fs.writeFileSync(outPath, dump, "utf8");

  console.log(`Generated ${path.relative(ROOT, outPath)}`);
}

if (require.main === module) {
  generateDump();
}

module.exports = { generateDump };

