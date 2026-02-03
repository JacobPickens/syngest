// version-control/print-active.js
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

const STATE_PATH = path.join(process.cwd(), ".repo_state.json");

export function printActive() {
  if (!fs.existsSync(STATE_PATH)) {
    console.log("No active dump.");
    return;
  }

  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    console.log("No active dump (state file corrupt).");
    return;
  }

  console.log("Active dump:", state.active || "none");
  if (Array.isArray(state.history)) {
    console.log("History:", state.history.length, "applied dumps");
  }
}

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_MAIN) printActive();
