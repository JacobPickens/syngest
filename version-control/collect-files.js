// version-control/collect-files.js
import fs from "fs";
import path from "path";

/**
 * Hard excludes — NEVER part of a dump
 */
const HARD_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "db", // runtime data (never dump)
  "versions",
  "version-control" // toolchain dir must not be dumped
]);

const HARD_EXCLUDE_FILES = new Set([
  ".repo_state.json",
  "dump.txt",
  // runtime outputs (never dump)
  "runOutput.txt",
  "runState.json",
  "src/scripts/runOutput.txt",
  "src/scripts/allowed_blocks.txt",
  "middleware/fingerer.js"
]);

/**
 * Root allow-list.
 *
 * The repo has migrated to a /src layout. To prevent legacy dumps from
 * re-creating the old top-level structure (routes/, views/, public/, etc.),
 * we only include:
 *   - src/** (all application code)
 *   - a small set of root config/tool files
 *   - dl_data/** (if present)
 */
const ALLOW_ROOT_DIRS = new Set(["src", "dl_data"]);

const ALLOW_ROOT_FILES = new Set([
  ".env",
  ".gitignore",
  ".gitattributes",
  "package.json",
  "package-lock.json",
  // toolchain scripts (kept at repo root)
  "dump-apply.js",
  "dump-generate.js",
  "dump-undo.js",
  "dump-validator.js",
  "print-active.js",
  "zip-util.js",
  "toolchain-version.js",
  "collect-files.js"
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

      // Root-only allow-list enforcement to avoid dumping legacy top-level layout.
      // Everything must live under /src (plus a few root config/tool files).
      if (path.resolve(dir) === path.resolve(rootDir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          if (!ALLOW_ROOT_DIRS.has(name)) continue;
        } else if (st.isFile()) {
          if (!ALLOW_ROOT_FILES.has(name)) continue;
        }
      }

      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        const rel = path.relative(rootDir, fullPath).replace(/\\/g, "/");
        // secondary safety
        if (rel.startsWith("version-control/")) continue;
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
