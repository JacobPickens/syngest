// scripts/dump-undo.js
const fs = require("fs");
const path = require("path");
const { validateDumpText } = require("./dump-validator");
const { applyDumpFile } = require("./dump-apply");

const ROOT = process.cwd();
const STATE_PATH = path.join(ROOT, ".repo_state.json");

const VERSIONS_DIR = path.join(ROOT, "versions");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { active: null, history: [] };
  }
}

function dumpPathForVersion(version) {
  return path.join(VERSIONS_DIR, `dump_${version}.txt`);
}

function warn(msg) {
  console.warn(`[dump:undo] ${msg}`);
}

function info(msg) {
  console.log(`[dump:undo] ${msg}`);
}

/**
 * Roll back the codebase to the rollback target declared by the current ACTIVE version's README.
 * If the rollback target can't be determined or the target dump file can't be found, do nothing and warn.
 */
function undoToActiveRollbackTarget() {
  const state = loadState();

  if (!state.active || !state.active.version) {
    warn("No active version found in .repo_state.json. Nothing to undo.");
    return { didUndo: false, reason: "no-active" };
  }

  const activeVersion = String(state.active.version);
  const activeDumpPath = dumpPathForVersion(activeVersion);

  if (!fs.existsSync(activeDumpPath)) {
    warn(`Active dump file not found: ${path.relative(ROOT, activeDumpPath)}. Nothing to undo.`);
    return { didUndo: false, reason: "active-dump-missing" };
  }

  // Read active dump and extract README rollback target (legacy-friendly)
  let parsed;
  try {
    const dumpText = fs.readFileSync(activeDumpPath, "utf8");
    parsed = validateDumpText(dumpText);
  } catch (e) {
    warn(`Failed to parse active dump (${path.relative(ROOT, activeDumpPath)}): ${e.message}`);
    warn("Nothing to undo.");
    return { didUndo: false, reason: "active-dump-invalid" };
  }

  function extractRollbackTarget(parsed) {
  // Primary: validator-parsed fields
  if (parsed && parsed.readmeValidation && parsed.readmeValidation.fields) {
    const v = String(parsed.readmeValidation.fields.rollbackTarget || '').trim();
    if (v) return v;
  }

  // Fallback: raw README text
  const text = parsed && parsed.readmeText ? String(parsed.readmeText) : '';
  const line = text.split(/\r?\n/).find((l) => /^\s*Rollback target\s*:/i.test(l));
  if (!line) return '';
  const m = line.match(/Rollback target\s*:\s*(.+)\s*$/i);
  return m ? String(m[1]).trim() : '';
}

  const rollbackTarget = extractRollbackTarget(parsed);
  if (!rollbackTarget) {
    warn(`Active version ${activeVersion} README is missing Rollback target. Nothing to undo.`);
    return { didUndo: false, reason: "no-rollback-target" };
  }

  const targetDumpPath = dumpPathForVersion(rollbackTarget);

  if (!fs.existsSync(targetDumpPath)) {
    warn(
      `Rollback target dump not found: ${path.relative(ROOT, targetDumpPath)}. ` +
        `No changes applied.`
    );
    return { didUndo: false, reason: "target-dump-missing", rollbackTarget };
  }

  info(`Active version: ${activeVersion}`);
  info(`Rollback target: ${rollbackTarget}`);
  info(`Applying: ${path.relative(ROOT, targetDumpPath)}`);

  // Apply the target dump (this updates .repo_state.json and extracts README sidecar per your rules)
  const result = applyDumpFile(targetDumpPath, { allowDelete: false });

  info(`Rollback complete. Active is now ${result.version}`);
  return { didUndo: true, from: activeVersion, to: result.version };
}

// CLI:
// node scripts/dump-undo.js
// npm run dump:undo
if (require.main === module) {
  try {
    const res = undoToActiveRollbackTarget();
    if (!res.didUndo) process.exitCode = 0;
  } catch (e) {
    warn(e.message || String(e));
    process.exitCode = 1;
  }
}

module.exports = { undoToActiveRollbackTarget };

