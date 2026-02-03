import { extractSingleFileZip } from "./zip-util.js";

const HEADER = "CHITDUMPv1\n";
const PAYLOAD_MARKER = "\n---PAYLOAD---\n";

/**
 * Lightweight structural validation.
 * Does not touch filesystem.
 */
export function validateDump(dumpText) {
  if (!dumpText.startsWith(HEADER)) {
    throw new Error("Invalid dump header");
  }

  const body = dumpText.slice(HEADER.length);
  const splitIndex = body.indexOf(PAYLOAD_MARKER);

  if (splitIndex === -1) {
    throw new Error("Missing payload marker");
  }

  let meta;
  try {
    meta = JSON.parse(body.slice(0, splitIndex));
  } catch {
    throw new Error("Invalid META JSON");
  }

  if (!meta.toolchainVersion) {
    throw new Error("META missing toolchainVersion");
  }

  if (!meta.version || typeof meta.version !== "string") {
    throw new Error("META missing version");
  }

  if (!/^v\d+\.\d+\.\d+$/.test(meta.version)) {
    throw new Error("META version must match vX.Y.Z");
  }

  return true;
}

/**
 * Validate ZIP shape (single file dump.txt) and then validate dump contents.
 * Accepts a Buffer.
 */
export function validateZipDump(zipBuffer) {
  if (!Buffer.isBuffer(zipBuffer)) {
    throw new Error("validateZipDump expects a Buffer");
  }

  // PK\x03\x04
  if (
    zipBuffer.length < 4 ||
    zipBuffer[0] !== 0x50 ||
    zipBuffer[1] !== 0x4b ||
    zipBuffer[2] !== 0x03 ||
    zipBuffer[3] !== 0x04
  ) {
    throw new Error("Not a ZIP file");
  }

  const { data } = extractSingleFileZip(zipBuffer, "dump.txt");
  return validateDump(data.toString("utf8"));
}
