const path = require("path");
const { applyDumpFile } = require("./dump-apply");

const dumpPath = process.argv[2];
if (!dumpPath) {
  console.error("Usage: npm run dump:undo <dump-file>");
  process.exit(1);
}

applyDumpFile(path.resolve(dumpPath));
