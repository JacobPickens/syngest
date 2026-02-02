const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(process.cwd(), ".repo_state.json");

function printActive() {
  if (!fs.existsSync(STATE_PATH)) {
    console.log("No active dump.");
    return;
  }

  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  console.log("Active dump:", state.active || "none");
}

if (require.main === module) printActive();

module.exports = { printActive };
