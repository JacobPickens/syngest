// version-control/collect-files.js
const fs = require("fs");
const path = require("path");

/**
 * Hard excludes — NEVER part of a dump
 */
const HARD_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "versions"
]);

const HARD_EXCLUDE_FILES = new Set([
  ".repo_state.json",
  "dump.txt"
]);

/**
 * Collect all candidate repo files relative to ROOT.
 * This is intentionally dumb for now:
 * - no chitignore
 * - no chitconfig
 * - hard excludes only
 */
function collectFiles(rootDir) {
  const files = [];

  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (HARD_EXCLUDE_DIRS.has(name)) continue;
      if (HARD_EXCLUDE_FILES.has(name)) continue;

      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath);
      } else {
        files.push(path.relative(rootDir, fullPath));
      }
    }
  }

  walk(rootDir);
  return files;
}

module.exports = collectFiles;
