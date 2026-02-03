// version-control/dump-undo.js
import path from "path";
import { pathToFileURL } from "url";
import { applyDumpFile } from "./dump-apply.js";

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN) {
  const dumpPath = process.argv[2];
  if (!dumpPath) {
    console.error("Usage: npm run dump:undo -- <dump_vX.Y.Z[.zip]>");
    process.exit(1);
  }

  try {
    applyDumpFile(path.resolve(dumpPath));
    console.log("[dump:undo] applied");
  } catch (e) {
    console.error(`[dump:undo] ${e && e.message ? e.message : String(e)}`);
    process.exit(1);
  }
}
