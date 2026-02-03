// version-control/dump-apply.js
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { pathToFileURL } from "url";
import { TOOLCHAIN_VERSION } from "./toolchain-version.js";
import { extractSingleFileZip } from "./zip-util.js";

const HEADER = "CHITDUMPv1\n";
const PAYLOAD_MARKER = "\n---PAYLOAD---\n";

/**
 * Apply a chit dump to the local filesystem.
 * - Validates header
 * - Enforces exact toolchain version match
 * - Enforces META.version presence/shape
 * - Transparently handles gzipped payloads
 * - Writes .repo_state.json (active + history)
 */
export function applyDump(dumpText) {
  if (!dumpText.startsWith(HEADER)) {
    throw new Error("Invalid dump header");
  }

  const body = dumpText.slice(HEADER.length);
  const splitIndex = body.indexOf(PAYLOAD_MARKER);

  if (splitIndex === -1) {
    throw new Error("Missing payload marker");
  }

  const metaText = body.slice(0, splitIndex);
  const payloadText = body.slice(splitIndex + PAYLOAD_MARKER.length);

  const meta = JSON.parse(metaText);

  if (!meta.toolchainVersion) {
    throw new Error("Dump missing toolchainVersion");
  }

  if (!meta.version || typeof meta.version !== "string") {
    throw new Error("Dump missing version");
  }
  if (!/^v\d+\.\d+\.\d+$/.test(meta.version)) {
    throw new Error("Dump version must match vX.Y.Z");
  }

  if (meta.toolchainVersion !== TOOLCHAIN_VERSION) {
    throw new Error(
      `Toolchain version mismatch.\n` +
        `Dump:  ${meta.toolchainVersion}\n` +
        `Local: ${TOOLCHAIN_VERSION}`
    );
  }

  let payloadBuffer = Buffer.from(payloadText, "base64");

  // transparent gzip detection
  if (payloadBuffer[0] === 0x1f && payloadBuffer[1] === 0x8b) {
    payloadBuffer = zlib.gunzipSync(payloadBuffer);
  }

  const payload = JSON.parse(payloadBuffer.toString("utf8"));
  const { dirs, exts, files } = payload;

  for (const entry of files) {
    const [dirIdx, base, extIdx, content] = entry;

    const fullPath = path.join(dirs[dirIdx], base + exts[extIdx]);

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }

  // Persist active dump metadata
  const statePath = path.join(process.cwd(), ".repo_state.json");
  let state = { active: null, history: [] };
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    // ignore
  }

  const appliedAt = new Date().toISOString();
  const active = {
    version: meta.version,
    toolchainVersion: meta.toolchainVersion,
    appliedAt,
    fileCount: Array.isArray(files) ? files.length : 0
  };

  const history = Array.isArray(state.history) ? state.history : [];
  history.push(active);

  fs.writeFileSync(statePath, JSON.stringify({ active, history }, null, 2) + "\n", "utf8");
  return active;
}

/**
 * Apply a ZIP containing EXACTLY one file: dump.txt
 * (Multipart zips are forbidden.)
 */
export function applyDumpZip(zipBuffer) {
  if (!Buffer.isBuffer(zipBuffer)) {
    throw new Error("applyDumpZip expects a Buffer");
  }
  const { data } = extractSingleFileZip(zipBuffer, "dump.txt");
  return applyDump(data.toString("utf8"));
}

/**
 * Auto-detect raw dump vs ZIP buffer.
 */
export function applyDumpAuto(input) {
  if (Buffer.isBuffer(input)) {
    // ZIP signature: PK\x03\x04
    if (input.length >= 4 && input[0] === 0x50 && input[1] === 0x4b && input[2] === 0x03 && input[3] === 0x04) {
      return applyDumpZip(input);
    }
    return applyDump(input.toString("utf8"));
  }

  if (typeof input === "string") {
    if (input.startsWith(HEADER)) return applyDump(input);
    throw new Error("applyDumpAuto: string input must be dump text");
  }

  throw new Error("applyDumpAuto: unsupported input type");
}

/**
 * Compatibility helper: apply by file path (zip or raw dump).
 *
 * Accepts paths with or without a .zip extension.
 */
export function applyDumpFile(filePath) {
  const abs = path.resolve(String(filePath));

  // If the caller omitted ".zip", transparently try the zip form.
  // This makes: `npm run dump:apply -- versions/dump_v0.2.7` work.
  let resolved = abs;
  if (!fs.existsSync(resolved) && !resolved.toLowerCase().endsWith(".zip")) {
    const withZip = resolved + ".zip";
    if (fs.existsSync(withZip)) resolved = withZip;
  }

  const buf = fs.readFileSync(resolved);
  return applyDumpAuto(buf);
}

/* ------------------------------ CLI ------------------------------ */

const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node dump-apply.js <dump_vX.Y.Z[.zip]>");
    process.exit(1);
  }

  try {
    const res = applyDumpFile(filePath);
    if (res && res.version) {
      console.log(`[dump:apply] active is now ${res.version}`);
    } else {
      console.log("[dump:apply] applied");
    }
  } catch (e) {
    console.error(`[dump:apply] ${e && e.message ? e.message : String(e)}`);
    process.exit(1);
  }
}
