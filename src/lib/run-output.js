// --- src/lib/run-output.js ---
'use strict';

const fs = require('fs');
const path = require('path');

// Plain-text run output (one console line == one file line)
// This module can be required from anywhere (server started from src/, project root, etc.).
// Default paths must always resolve to the project root.
// __dirname is: <project>/src/lib
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// All runtime artifacts should live in <project>/bin
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');

const OUTPUT_TXT_PATH = process.env.RUN_OUTPUT_TXT_PATH
  ? (path.isAbsolute(process.env.RUN_OUTPUT_TXT_PATH)
      ? process.env.RUN_OUTPUT_TXT_PATH
      : path.resolve(PROJECT_ROOT, process.env.RUN_OUTPUT_TXT_PATH))
  : path.join(BIN_DIR, 'runOutput.txt');

// Small JSON state for status/meta/stats (NOT a log)
const STATE_PATH = process.env.RUN_STATE_PATH
  ? (path.isAbsolute(process.env.RUN_STATE_PATH)
      ? process.env.RUN_STATE_PATH
      : path.resolve(PROJECT_ROOT, process.env.RUN_STATE_PATH))
  : path.join(BIN_DIR, 'runState.json');

const MAX_STATE_BYTES = Number(process.env.RUN_STATE_MAX_BYTES || 64 * 1024);

// per-client tail cursor for OUTPUT_TXT_PATH
const tailTxtByKey = new Map(); // key -> { byteOffset: number }

function ensureDir(p) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
}

function defaultState() {
  return { running: false, meta: {}, stats: {}, updatedAtMs: 0 };
}

function readStateSafe() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaultState();
    return {
      running: !!parsed.running,
      meta: (parsed.meta && typeof parsed.meta === 'object') ? parsed.meta : {},
      stats: (parsed.stats && typeof parsed.stats === 'object') ? parsed.stats : {},
      updatedAtMs: Number(parsed.updatedAtMs || 0) || 0
    };
  } catch {
    return defaultState();
  }
}

function writeStateSafe(state) {
  const safe = {
    running: !!state.running,
    meta: state.meta && typeof state.meta === 'object' ? state.meta : {},
    stats: state.stats && typeof state.stats === 'object' ? state.stats : {},
    updatedAtMs: Date.now()
  };
  try {
    ensureDir(STATE_PATH);
    const out = JSON.stringify(safe);
    if (Buffer.byteLength(out, 'utf8') <= MAX_STATE_BYTES) {
      fs.writeFileSync(STATE_PATH, out, 'utf8');
    }
  } catch {
    // ignore
  }
  return safe;
}

function peekState() {
  return readStateSafe();
}

/**
 * Tail OUTPUT_TXT_PATH as plain text.
 * - Uses per-key byte offsets
 * - `reset=1` jumps to EOF (UI clears and only shows fresh content)
 */
function tail(key, reset = false) {
  const k = String(key || 'global');
  const state = readStateSafe();

  ensureDir(OUTPUT_TXT_PATH);

  let st;
  try {
    st = fs.statSync(OUTPUT_TXT_PATH);
  } catch {
    // file missing => nothing to tail
    tailTxtByKey.set(k, { byteOffset: 0 });
    return {
      ok: true,
      running: !!state.running,
      stats: state.stats || {},
      meta: state.meta || {},
      text: '',
      source: 'runOutput.txt',
      output_path: OUTPUT_TXT_PATH,
      totalBytes: 0
    };
  }

  if (reset || !tailTxtByKey.has(k)) {
    tailTxtByKey.set(k, { byteOffset: st.size });
    return {
      ok: true,
      running: !!state.running,
      stats: state.stats || {},
      meta: state.meta || {},
      text: '',
      source: 'runOutput.txt',
      output_path: OUTPUT_TXT_PATH,
      totalBytes: st.size
    };
  }

  const cur = tailTxtByKey.get(k);
  const from = Math.max(0, Number(cur.byteOffset || 0));
  const to = st.size;

  // handle truncation/rotation
  const safeFrom = from > to ? 0 : from;

  let text = '';
  if (to > safeFrom) {
    const fd = fs.openSync(OUTPUT_TXT_PATH, 'r');
    try {
      const len = to - safeFrom;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, safeFrom);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  cur.byteOffset = to;

  return {
    ok: true,
    running: !!state.running,
    stats: state.stats || {},
    meta: state.meta || {},
    text,
    source: 'runOutput.txt',
    output_path: OUTPUT_TXT_PATH,
    totalBytes: to
  };
}

/* ------------------- writer helpers ------------------- */

function clearOutputFile() {
  try {
    ensureDir(OUTPUT_TXT_PATH);
    fs.writeFileSync(OUTPUT_TXT_PATH, '', 'utf8');
  } catch {
    // ignore
  }
  // reset all client cursors so they don't “seek past” the new empty file
  tailTxtByKey.clear();
}

function appendLine(line) {
  const s = String(line ?? '');
  try {
    ensureDir(OUTPUT_TXT_PATH);
    fs.appendFileSync(OUTPUT_TXT_PATH, s.endsWith('\n') ? s : (s + '\n'), 'utf8');
  } catch {
    // ignore
  }
}

function beginRun(meta = {}) {
  // requirement: new run clears run output
  clearOutputFile();

  writeStateSafe({
    running: true,
    meta: { ...meta, startedAtMs: Date.now() },
    stats: {}
  });

  appendLine(`[dashboard] starting scan: ${meta.cmd || ''}`.trim());
}

function setStats(stats = {}) {
  const st = readStateSafe();
  writeStateSafe({ running: !!st.running, meta: st.meta || {}, stats: stats || {} });
}

function endRun(result = {}) {
  const st = readStateSafe();
  appendLine(
    `[dashboard] scan ended: code=${result.code} signal=${result.signal}` +
    (result.error ? ` error=${result.error}` : '')
  );
  writeStateSafe({
    running: false,
    meta: { ...(st.meta || {}), endedAtMs: Date.now(), result },
    stats: st.stats || {}
  });
}

module.exports = {
  OUTPUT_TXT_PATH,
  STATE_PATH,
  peekState,
  tail,
  beginRun,
  appendLine,
  setStats,
  endRun
};

