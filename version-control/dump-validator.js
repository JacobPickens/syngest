// scripts/dump-validator.js
const path = require("path");
const fs = require("fs");

const ROOT = process.cwd();
const ALLOWED_PATH = path.join(__dirname, "ALLOWED.txt");

const FORBIDDEN = new Set(["middleware/fingerer.js"]);

function isBoundaryLine(line) {
  return /^---[^-\n].*---$/.test(line.trim());
}

function boundaryName(line) {
  return line.trim().slice(3, -3);
}

function normalizeRel(p) {
  return String(p).replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function compareLex(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ================= ALLOW POLICY ================= */

function loadAllowPolicy() {
  if (!fs.existsSync(ALLOWED_PATH)) {
    return { enabled: false };
  }

  const lines = fs
    .readFileSync(ALLOWED_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith("#"));

  const exact = new Set();
  const dirs = [];

  for (const l of lines) {
    if (l.endsWith("/")) {
      dirs.push(l);
    } else {
      exact.add(l);
    }
  }

  return { enabled: true, exact, dirs };
}

function isAllowed(rel, policy) {
  if (FORBIDDEN.has(rel)) return false;
  if (!policy.enabled) return true;
  if (policy.exact.has(rel)) return true;
  return policy.dirs.some((d) => rel.startsWith(d));
}

/* ================= DUMP VALIDATION ================= */

function validateDumpText(dumpText) {
  const warnings = [];

  if (typeof dumpText !== "string" || !dumpText.length) {
    throw new Error("dump is empty or invalid");
  }

  const metaBoundary = "---__META__---\n";
  const idx = dumpText.lastIndexOf(metaBoundary);
  if (idx === -1) throw new Error("Missing __META__ footer");

  const headerText = dumpText.slice(0, idx);
  const metaText = dumpText.slice(idx + metaBoundary.length);

  let meta;
  try {
    meta = JSON.parse(metaText.trim());
  } catch {
    throw new Error("Invalid __META__ JSON");
  }

  if (!meta.version || typeof meta.version !== "string") {
    throw new Error("__META__.version is required");
  }

  if ("sha256" in meta) {
    warnings.push("__META__.sha256 ignored (hashing removed)");
  }

  const lines = headerText.split("\n");
  const files = new Map();

  let current = null;
  let buf = [];
  let inReadme = false;
  let readmeBuf = [];

  function flush() {
    if (current) files.set(current, buf.join("\n"));
    current = null;
    buf = [];
  }

  for (const line of lines) {
    if (isBoundaryLine(line)) {
      const name = normalizeRel(boundaryName(line));

      if (name === "README") {
        flush();
        inReadme = true;
        continue;
      }

      if (inReadme) throw new Error("File found after README");

      if (files.has(name)) throw new Error(`Duplicate file: ${name}`);
      if (FORBIDDEN.has(name)) throw new Error(`Forbidden file: ${name}`);

      flush();
      current = name;
      continue;
    }

    if (inReadme) {
      readmeBuf.push(line);
    } else if (current) {
      buf.push(line);
    } else if (line.trim() !== "") {
      throw new Error("Content before first file boundary");
    }
  }

  flush();

  if (!files.size) throw new Error("No files in dump");

  if (Array.isArray(meta.manifest)) {
    const actual = [...files.keys()];
    if (meta.manifest.length !== actual.length) {
      warnings.push("manifest length mismatch (warn-only)");
    }
  } else {
    warnings.push("__META__.manifest missing/invalid (warn-only)");
  }

  const policy = loadAllowPolicy();
  if (policy.enabled) {
    for (const rel of files.keys()) {
      if (!isAllowed(rel, policy)) {
        throw new Error(`File not allowed by ALLOWED.txt: ${rel}`);
      }
    }
  }

  const readmeText = readmeBuf.length ? readmeBuf.join("\n").trimEnd() : null;

  function parseReadmeFields(text) {
    if (!text) return { fields: {}, ok: false };

    const fields = {};
    const lines = String(text).split(/\r?\n/);

    for (const line of lines) {
      // Simple "Key: Value" extraction (kept intentionally strict & readable)
      const m = line.match(/^\s*([A-Za-z][A-Za-z _-]{1,40})\s*:\s*(.+?)\s*$/);
      if (!m) continue;

      const keyRaw = m[1].trim().toLowerCase().replace(/[-\s]+/g, " ");
      const value = m[2].trim();

      if (keyRaw === "rollback target") fields.rollbackTarget = value;
      else if (keyRaw === "version") fields.version = value;
      else if (keyRaw === "state") fields.state = value;
    }

    return { fields, ok: Object.keys(fields).length > 0 };
  }

  const readmeValidation = parseReadmeFields(readmeText);

  return {
    files,
    meta,
    readmeText,
    readmeValidation,
    warnings,
  };
}

module.exports = { validateDumpText };
