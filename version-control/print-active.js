// scripts/print-active.js
const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(process.cwd(), ".repo_state.json");

function printActive() {
  if (!fs.existsSync(STATE_PATH)) {
    console.log("No repo state found. No dump has been applied yet.");
    process.exit(0);
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    console.error("Failed to read .repo_state.json (corrupt JSON)");
    process.exit(1);
  }

  if (!state.active) {
    console.log("Repo state exists, but no active dump is set.");
    process.exit(0);
  }

  const a = state.active;

  console.log("Active repo dump");
  console.log("----------------");
  console.log(`Version    : ${a.version}`);
  if (a.sha256) console.log(`SHA256     : ${a.sha256}`);
  console.log(`Applied at : ${a.appliedAt}`);
  console.log(`Files      : ${a.fileCount}`);

  if (Array.isArray(state.history)) {
    console.log(`History    : ${state.history.length} total applied dumps`);
  }
}

if (require.main === module) {
  printActive();
}

module.exports = { printActive };

