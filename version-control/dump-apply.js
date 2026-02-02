const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const readline = require("readline");
const { execSync } = require("child_process");

const FILE_MARKER = "---FILE---";

/**
 * Apply a multipart dump directory
 */
async function applyMultipartDir(dir) {
  const metaPath = path.join(dir, "dump.meta.json");
  if (!fs.existsSync(metaPath)) {
    throw new Error("Missing dump.meta.json");
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  if (!Array.isArray(meta.parts)) {
    throw new Error("Invalid dump.meta.json (missing parts)");
  }

  for (const part of meta.parts) {
    const partPath = path.join(dir, part);
    if (!fs.existsSync(partPath)) {
      throw new Error(`Missing dump part: ${part}`);
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(partPath, { encoding: "utf8" }),
      crlfDelay: Infinity
    });

    let buffer = "";

    for await (const line of rl) {
      if (line === FILE_MARKER) {
        buffer = "";
        continue;
      }

      buffer += line;

      try {
        let buf = Buffer.from(buffer, "base64");
        if (buf[0] === 0x1f && buf[1] === 0x8b) {
          buf = zlib.gunzipSync(buf);
        }

        const entry = JSON.parse(buf.toString("utf8"));
        const fullPath = path.join(process.cwd(), entry.path);

        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, entry.content, "utf8");

        buffer = "";
      } catch {
        // buffer incomplete, keep accumulating
      }
    }
  }
}

/**
 * Apply a dump given a path (zip or directory)
 */
async function applyDump(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error("Dump path does not exist");
  }

  let dumpDir = inputPath;
  let cleanup = null;

  if (inputPath.endsWith(".zip")) {
    // unzip to temp dir
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chitdump-"));
    execSync(`tar -xf "${inputPath}"`, { cwd: tmp });
    const entries = fs.readdirSync(tmp);
    if (entries.length !== 1) {
      throw new Error("ZIP must contain exactly one dump directory");
    }
    dumpDir = path.join(tmp, entries[0]);
    cleanup = tmp;
  }

  await applyMultipartDir(dumpDir);

  if (cleanup) {
    fs.rmSync(cleanup, { recursive: true, force: true });
  }
}

/* ===========================
   CLI ENTRY
   =========================== */
if (require.main === module) {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: node dump-apply.js <dump.zip | dump_directory>");
    process.exit(1);
  }

  applyDump(path.resolve(input))
    .then(() => {
      console.log("✔ Dump applied successfully");
    })
    .catch(err => {
      console.error("✖ Apply failed:", err.message);
      process.exit(1);
    });
}

module.exports = {
  applyDump
};
