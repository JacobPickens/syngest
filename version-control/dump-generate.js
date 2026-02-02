const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execSync } = require("child_process");
const { TOOLCHAIN_VERSION } = require("./toolchain-version");

const FILE_MARKER = "\n---FILE---\n";
const MAX_PART_BYTES = 2 * 1024 * 1024; // 2MB

function generateMultipartDump(files, options = {}) {
  const version = options.version || "v0.0.0";
  const root = process.cwd();
  const dumpDirName = `dump_${version}`;
  const outDir = path.join(root, "versions", dumpDirName);
  fs.mkdirSync(outDir, { recursive: true });

  let partIndex = 1;
  let currentSize = 0;
  const parts = [];

  function openPart() {
    const name = `dump.part_${String(partIndex).padStart(4, "0")}.txt`;
    parts.push(name);
    partIndex++;
    currentSize = 0;
    return fs.createWriteStream(path.join(outDir, name), { encoding: "utf8" });
  }

  let stream = openPart();

  for (const file of files) {
    if (
      file.startsWith("version-control/") ||
      file.startsWith("bin/") ||
      file.startsWith("versions/")
    ) continue;

    let content = fs.readFileSync(file, "utf8").replace(/[ \t]+$/gm, "");
    const entry = { path: file, content };
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(entry), "utf8"));
    const encoded = FILE_MARKER + gz.toString("base64");

    if (currentSize + encoded.length > MAX_PART_BYTES) {
      stream.end();
      stream = openPart();
    }

    stream.write(encoded);
    currentSize += encoded.length;
  }

  stream.end();

  const meta = {
    format: "chitdump-multipart-v1",
    transport: "zip",
    version,
    toolchainVersion: TOOLCHAIN_VERSION,
    createdAt: Date.now(),
    instructions: {
      howToUse: [
        "Unzip the archive",
        "Read dump.meta.json first",
        "Apply dump parts in listed order",
        "Each dump.part_XXXX.txt contains FILE blocks",
        "Each FILE block is base64 + gzip JSON: { path, content }"
      ]
    },
    parts
  };

  fs.writeFileSync(
    path.join(outDir, "dump.meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8"
  );

  // 🔒 ZIP IT (final artifact)
  const zipPath = path.join(root, "versions", `${dumpDirName}.zip`);
  execSync(`tar -a -c -f "${zipPath}" "${dumpDirName}"`, {
    cwd: path.join(root, "versions")
  });

  return zipPath;
}

/* CLI */
if (require.main === module) {
  const versionArg = process.argv.find(a => a.startsWith("--version="));
  const version = versionArg ? versionArg.split("=")[1] : "v0.0.0";

  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "versions"].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      e.isDirectory() ? walk(full, out) : out.push(full);
    }
    return out;
  }

  const files = walk(process.cwd());
  const zip = generateMultipartDump(files, { version });
  console.log(`✔ Dump ZIP generated: ${zip}`);
}

module.exports = { generateMultipartDump };
