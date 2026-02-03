// version-control/collect-files.js
import fs from "fs";
import path from "path";

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
  "dump.txt",
  "middleware/fingerer.js"
]);

/**
 * Collect all candidate repo files relative to ROOT.
 * Intentionally simple:
 * - hard excludes only
 * - lexicographic output
 */
export function collectFiles(rootDir) {
  const files = [];

  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (HARD_EXCLUDE_DIRS.has(name)) continue;
      if (HARD_EXCLUDE_FILES.has(name)) continue;

      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        const rel = path.relative(rootDir, fullPath).replace(/\\/g, "/");
        // secondary safety (leave toolchain in-tree so it can be versioned by dumps)
        if (rel === "middleware/fingerer.js") continue;
        files.push(rel);
      }
    }
  }

  walk(rootDir);
  files.sort(); // deterministic ordering
  return files;
}

export default collectFiles;
