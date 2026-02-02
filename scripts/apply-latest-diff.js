#!/usr/bin/env node
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DIFF_DIR = "diffs";
const LEGACY_DIR = path.join(DIFF_DIR, "legacy");

function run(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

// sanity checks
try {
  run("git rev-parse --is-inside-work-tree");
} catch {
  console.error("Error: not inside a git repository");
  process.exit(1);
}

if (!fs.existsSync(DIFF_DIR)) {
  console.error(`Error: ${DIFF_DIR}/ does not exist`);
  process.exit(1);
}

const diffs = fs.readdirSync(DIFF_DIR)
  .filter(f => f.endsWith(".diff"))
  .map(f => path.join(DIFF_DIR, f));

if (diffs.length === 0) {
  console.error("Error: no diff file found in diffs/");
  process.exit(1);
}

if (diffs.length > 1) {
  console.error("Error: more than one diff found in diffs/:");
  diffs.forEach(d => console.error(" -", d));
  process.exit(1);
}

const diffFile = diffs[0];
const diffName = path.basename(diffFile);

run(`git apply --check "${diffFile}"`);
run(`git apply "${diffFile}"`);
run("git add -A");
run(`git commit -m "${diffName}"`);

fs.mkdirSync(LEGACY_DIR, { recursive: true });
fs.renameSync(diffFile, path.join(LEGACY_DIR, diffName));

console.log("Done ✔");
