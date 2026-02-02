const fs = require("fs");
const path = require("path");

function validateMultipartDump(dir) {
  const metaPath = path.join(dir, "dump.meta.json");
  if (!fs.existsSync(metaPath)) throw new Error("Missing dump.meta.json");

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  if (!Array.isArray(meta.parts)) throw new Error("Invalid parts list");

  for (const p of meta.parts) {
    if (!fs.existsSync(path.join(dir, p))) {
      throw new Error(`Missing part: ${p}`);
    }
  }

  return true;
}

module.exports = { validateMultipartDump };
