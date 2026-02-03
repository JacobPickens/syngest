// version-control/dump-generate.js
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { pathToFileURL } from "url";
import { TOOLCHAIN_VERSION } from "./toolchain-version.js";
import { createSingleFileZip } from "./zip-util.js";
import { collectFiles } from "./collect-files.js";

const HEADER = "CHITDUMPv1\n";
const PAYLOAD_MARKER = "\n---PAYLOAD---\n";

const ROOT = process.cwd();
const STATE_PATH = path.join(ROOT, ".repo_state.json");
const VERSIONS_DIR = path.join(ROOT, "versions");

/**
 * Generate a chit dump file.
 * - Excludes hard toolchain/system paths (via collect-files)
 * - Dictionary-encodes directories and extensions
 * - Optionally gzips payload (default: on)
 * - Splits META and PAYLOAD streams
 */
export function generateDump(files, options = {}) {
  if (!options.version || typeof options.version !== "string") {
    throw new Error("generateDump: options.version is required (e.g. v0.2.1)");
  }
  if (!/^v\d+\.\d+\.\d+$/.test(options.version)) {
    throw new Error("generateDump: options.version must match vX.Y.Z");
  }

  const useGzip = options.gzip !== false;

  const dirDict = [];
  const extDict = [];
  const dirIndex = new Map();
  const extIndex = new Map();

  function intern(map, arr, value) {
    if (!map.has(value)) {
      map.set(value, arr.length);
      arr.push(value);
    }
    return map.get(value);
  }

  const payloadFiles = [];

  for (const relFile of files) {
    const norm = String(relFile).replace(/\\/g, "/");

    // hard safety: never include toolchain/system paths even if passed explicitly
    if (
      norm.startsWith("version-control/") ||
      norm.startsWith("scripts/") ||
      norm.startsWith("bin/") ||
      norm.startsWith("node_modules/") ||
      norm.startsWith(".git/") ||
      norm.startsWith("versions/") ||
      norm === ".repo_state.json" ||
      norm === "dump.txt" ||
      norm === "middleware/fingerer.js"
    ) {
      continue;
    }

    const absFile = path.join(ROOT, norm);
    const dir = path.dirname(norm);
    const ext = path.extname(norm);
    const base = path.basename(norm, ext);

    const d = intern(dirIndex, dirDict, dir);
    const e = intern(extIndex, extDict, ext);

    let content = fs.readFileSync(absFile, "utf8");

    // ✂ non-semantic whitespace trimming
    content = content.replace(/[ \t]+$/gm, "");

    payloadFiles.push([d, base, e, content]);
  }

  const meta = {
    version: options.version,
    toolchainVersion: TOOLCHAIN_VERSION,
    createdAt: Date.now(),
    validatorMode: options.validatorMode || "default",
    encoding: {
      dictionary: true,
      gzip: useGzip
    }
  };

  const payload = {
    dirs: dirDict,
    exts: extDict,
    files: payloadFiles
  };

  let payloadBuffer = Buffer.from(JSON.stringify(payload), "utf8");

  if (useGzip) {
    payloadBuffer = zlib.gzipSync(payloadBuffer);
  }

  return HEADER + JSON.stringify(meta) + PAYLOAD_MARKER + payloadBuffer.toString("base64");
}

/**
 * Generate a single-file ZIP (dump.txt) containing the dump output.
 */
export function generateDumpZip(files, options = {}) {
  const dumpText = generateDump(files, options);
  const dumpBuf = Buffer.from(dumpText, "utf8");
  return createSingleFileZip("dump.txt", dumpBuf, { compress: true });
}

/* ------------------------------ CLI ------------------------------ */

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    if (a.startsWith("--version=")) args.version = a.slice("--version=".length);
    else if (a.startsWith("--out=")) args.out = a.slice("--out=".length);
    else if (a === "--no-gzip") args.gzip = false;
    else if (a.startsWith("--validatorMode=")) args.validatorMode = a.slice("--validatorMode=".length);
    else args._.push(a);
  }
  return args;
}

function readActiveVersion() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    const v = state && state.active && state.active.version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function parseSemver(v) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(v || ""));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function cmpSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Enforce strict version bump against the current applied dump recorded in .repo_state.json.
 * If there is no active version yet, this check is skipped.
 */
function ensureVersionBump(nextVersion) {
  const active = readActiveVersion();
  if (!active) return;

  const a = parseSemver(active);
  const n = parseSemver(nextVersion);
  if (!a || !n) return;

  if (cmpSemver(n, a) <= 0) {
    throw new Error(
      `Version bump required.\n` +
        `Active: ${active}\n` +
        `Next  : ${nextVersion}\n` +
        `Provide a version strictly greater than active.`
    );
  }
}

// Reliable ESM main detection (Windows-safe)
const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.version) {
      console.error("[dump:generate] Missing --version=vX.Y.Z");
      process.exit(1);
    }

    ensureVersionBump(args.version);

    fs.mkdirSync(VERSIONS_DIR, { recursive: true });

    const outPath = args.out || path.join(VERSIONS_DIR, `dump_${args.version}.zip`);
    const files = args._.length ? args._ : collectFiles(ROOT);

    const zipBuf = generateDumpZip(files, {
      version: args.version,
      gzip: args.gzip,
      validatorMode: args.validatorMode
    });

    fs.writeFileSync(outPath, zipBuf);
    console.log(`[dump:generate] wrote ${path.relative(ROOT, outPath)} (${zipBuf.length} bytes)`);
  } catch (e) {
    console.error(`[dump:generate] ${e && e.message ? e.message : String(e)}`);
    process.exit(1);
  }
}
