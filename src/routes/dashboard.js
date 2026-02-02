// --- routes/dashboard.js ---
// Recovered Express router (server-side) for the dashboard.
// Provides: page render + tailing output + DB-backed run/rows/stats + in-memory scheduler that can spawn scan script.
//
// NOTE: This file is intentionally defensive:
// - It will NOT interfere with an already-running scan process.
// - If DB/table names differ, it will fall back gracefully with ok=false + error messages.

'use strict';

const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const express = require('express');

const router = express.Router();

// ---------------------------
// Config (env + sensible defaults)
// ---------------------------

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(ROOT, 'data', 'scan.db');
const DEFAULT_OUTPUT_PATH = path.join(ROOT, 'output.txt');

// If you have a dedicated scan script, set SCAN_SCRIPT to it (absolute or relative to project root).
// Example: SCAN_SCRIPT=./safe_scan.js
const DB_PATH = process.env.DB_PATH ? path.resolve(ROOT, process.env.DB_PATH) : DEFAULT_DB_PATH;
const OUTPUT_PATH = process.env.OUTPUT_PATH ? path.resolve(ROOT, process.env.OUTPUT_PATH) : DEFAULT_OUTPUT_PATH;

const NODE_BIN = process.env.NODE_BIN || process.execPath;
const SCAN_SCRIPT = process.env.SCAN_SCRIPT ? path.resolve(ROOT, process.env.SCAN_SCRIPT) : null;

// These are optional knobs; they only apply to *new* runs started from the dashboard.
const SCAN_CWD = process.env.SCAN_CWD ? path.resolve(ROOT, process.env.SCAN_CWD) : ROOT;

// default blocks if not set elsewhere
let scanNBlocks = Number(process.env.SCAN_N_BLOCKS || 1);
if (!Number.isFinite(scanNBlocks) || scanNBlocks < 1) scanNBlocks = 1;

// ---------------------------
// Optional SQLite (best-effort)
// ---------------------------

let sqlite = null;
let db = null;

// Support either better-sqlite3 or sqlite3 if installed.
function tryInitDb() {
  if (db) return db;

  // better-sqlite3 (sync)
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const BetterSqlite3 = require('better-sqlite3');
    sqlite = { kind: 'better-sqlite3' };
    db = new BetterSqlite3(DB_PATH, { readonly: true });
    return db;
  } catch (_) {}

  // sqlite3 (async)
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const sqlite3 = require('sqlite3');
    sqlite = { kind: 'sqlite3', sqlite3 };
    db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
    return db;
  } catch (_) {}

  return null;
}

function dbAll(sql, params = []) {
  const dbc = tryInitDb();
  if (!dbc) return Promise.reject(new Error('No sqlite driver found (install better-sqlite3 or sqlite3)'));

  if (sqlite.kind === 'better-sqlite3') {
    try {
      const stmt = dbc.prepare(sql);
      const rows = stmt.all(params);
      return Promise.resolve(rows);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  return new Promise((resolve, reject) => {
    dbc.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function dbGet(sql, params = []) {
  const dbc = tryInitDb();
  if (!dbc) return Promise.reject(new Error('No sqlite driver found (install better-sqlite3 or sqlite3)'));

  if (sqlite.kind === 'better-sqlite3') {
    try {
      const stmt = dbc.prepare(sql);
      const row = stmt.get(params);
      return Promise.resolve(row);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  return new Promise((resolve, reject) => {
    dbc.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

// ---------------------------
// Tail state for output.txt
// ---------------------------

const tailState = new Map(); // key -> { pos:number }
async function readTailChunk(key, reset) {
  const st = tailState.get(key) || { pos: 0 };
  if (reset) st.pos = 0;

  let fh;
  try {
    fh = await fsp.open(OUTPUT_PATH, 'a+');
    const stat = await fh.stat();
    const size = stat.size || 0;

    // if file truncated
    if (st.pos > size) st.pos = 0;

    const maxChunk = 64 * 1024; // 64kb per poll
    const start = st.pos;
    const toRead = Math.min(maxChunk, Math.max(0, size - start));

    let text = '';
    if (toRead > 0) {
      const buf = Buffer.alloc(toRead);
      const { bytesRead } = await fh.read(buf, 0, toRead, start);
      text = buf.slice(0, bytesRead).toString('utf8');
      st.pos = start + bytesRead;
    }

    tailState.set(key, st);
    return { text };
  } finally {
    try { await fh?.close(); } catch (_) {}
  }
}

// ---------------------------
// Scan process + scheduler (in-memory)
// ---------------------------

const sched = {
  armed: false,
  delaySec: null,
  nextRunAtMs: null,
  timer: null
};

let runningProc = null;
let runningStartedAt = null;
let startedByDashboard = false;

function isRunning() {
  return !!runningProc;
}

async function ensureOutputFile() {
  try {
    await fsp.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await fsp.appendFile(OUTPUT_PATH, '');
  } catch (_) {}
}

function spawnScanOnce({ byDashboard }) {
  if (!SCAN_SCRIPT) {
    return { ok: false, error: 'SCAN_SCRIPT is not configured (set SCAN_SCRIPT env var)' };
  }
  if (runningProc) {
    return { ok: false, error: 'scan already running' };
  }

  startedByDashboard = !!byDashboard;
  runningStartedAt = Date.now();

  // Append a run banner
  ensureOutputFile().then(() => {
    fs.appendFileSync(
      OUTPUT_PATH,
      `\n[dashboard] === RUN START ${new Date().toISOString()} === (SCAN_N_BLOCKS=${scanNBlocks})\n`
    );
  }).catch(() => {});

  const env = { ...process.env, SCAN_N_BLOCKS: String(scanNBlocks) };

  // Keep scan isolated; DO NOT inherit stdio; we capture and append to output file.
  const child = spawn(
    NODE_BIN,
    [SCAN_SCRIPT],
    { cwd: SCAN_CWD, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  runningProc = child;

  const writeOut = (chunk) => {
    try {
      fs.appendFileSync(OUTPUT_PATH, chunk);
    } catch (_) {}
  };

  child.stdout.on('data', (d) => writeOut(d));
  child.stderr.on('data', (d) => writeOut(d));

  child.on('close', (code, signal) => {
    const ended = new Date().toISOString();
    const msg = `\n[dashboard] === RUN END ${ended} === code=${code} signal=${signal || 'none'}\n`;
    try { fs.appendFileSync(OUTPUT_PATH, msg); } catch (_) {}
    runningProc = null;
    runningStartedAt = null;
    startedByDashboard = false;

    // If scheduler still armed, compute the next run again (interval behavior)
    if (sched.armed && typeof sched.delaySec === 'number' && sched.delaySec > 0) {
      sched.nextRunAtMs = Date.now() + sched.delaySec * 1000;
    }
  });

  return { ok: true };
}

function clearScheduleTimer() {
  if (sched.timer) clearInterval(sched.timer);
  sched.timer = null;
}

function armScheduler(delaySec) {
  const d = Number(delaySec);
  if (!Number.isFinite(d) || d < 1) return { ok: false, error: 'delaySec must be >= 1' };

  sched.armed = true;
  sched.delaySec = Math.floor(d);
  sched.nextRunAtMs = Date.now() + sched.delaySec * 1000;

  if (!sched.timer) {
    sched.timer = setInterval(() => {
      if (!sched.armed) return;
      if (isRunning()) return;

      const now = Date.now();
      if (sched.nextRunAtMs && now >= sched.nextRunAtMs) {
        // reset terminal on the UI side via /api/tail reset param, not here.
        spawnScanOnce({ byDashboard: true });
        // nextRunAtMs will be advanced when process exits; but also set a provisional next tick to avoid rapid-fire
        sched.nextRunAtMs = now + sched.delaySec * 1000;
      }
    }, 250);
  }

  return { ok: true };
}

function disarmScheduler() {
  sched.armed = false;
  sched.delaySec = null;
  sched.nextRunAtMs = null;
  clearScheduleTimer();
  return { ok: true };
}

function scheduleStatus() {
  return {
    armed: !!sched.armed,
    delaySec: sched.delaySec,
    nextRunAtMs: sched.nextRunAtMs,
    running: isRunning(),
    startedByDashboard: !!startedByDashboard,
    runningStartedAt
  };
}

// ---------------------------
// Page route (pug render)
// ---------------------------

router.get(['/', '/dashboard'], async (req, res) => {
  // We only provide minimal locals; your existing pug should use whatever it needs.
  // Ensure output file exists (avoid 404s in tail).
  await ensureOutputFile();

  res.render('dashboard', {
    cfg: {
      dbPath: DB_PATH,
      outputPath: OUTPUT_PATH
    }
  });
});

// ---------------------------
// Tail endpoint (live console)
// ---------------------------

// Client expects: { text, source? }
router.get('/api/tail', async (req, res) => {
  const key = String(req.query.key || 'global');
  const reset = String(req.query.reset || '0') === '1';

  try {
    const { text } = await readTailChunk(key, reset);
    return res.json({
      ok: true,
      text,
      source: path.basename(OUTPUT_PATH),
      running: isRunning()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------------------------
// Run + DB endpoints
// ---------------------------

// Expected by client: /api/run/latest -> { meta, block? , firstEverCreatedAt? }
router.get('/api/run/latest', async (req, res) => {
  // Try common patterns:
  // - runs_meta table with created_at, run_table, source, port
  // - ip_blocks table with last picked block
  try {
    const meta = await dbGet(
      `SELECT run_table, created_at, source, port
       FROM runs_meta
       ORDER BY created_at DESC
       LIMIT 1`
    ).catch(() => null);

    const firstEver = await dbGet(
      `SELECT MIN(created_at) AS first_ever_created_at FROM runs_meta`
    ).catch(() => null);

    const block = await dbGet(
      `SELECT ip_block, picked_at, ip_block_namespace, ip_block_file
       FROM ip_blocks
       ORDER BY picked_at DESC
       LIMIT 1`
    ).catch(() => null);

    return res.json({
      meta: meta || null,
      block: block || null,
      firstEverCreatedAt: firstEver ? firstEver.first_ever_created_at : null
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Expected by client: /api/run/:run/stats -> stats object
router.get('/api/run/:run/stats', async (req, res) => {
  const run = String(req.params.run || '');
  if (!run) return res.status(400).json({ ok: false, error: 'missing run' });

  // This is best-effort; adjust table names if yours differ.
  // stats expected by client:
  // unique_ips, total_observations, hot_unique_ips, first_seen, last_seen
  try {
    // rows table is assumed to be run-specific (table name = run_table) OR a shared table keyed by run_table.
    // We'll try run-named table first, then fallback.
    let rowTable = run.replace(/[^a-zA-Z0-9_]/g, '');
    if (!rowTable) rowTable = run;

    let stats = null;

    // Attempt: run table exists with ip, first_seen, last_seen
    try {
      const base = await dbGet(
        `SELECT
           COUNT(DISTINCT ip) AS unique_ips,
           COUNT(1) AS total_observations,
           MIN(first_seen) AS first_seen,
           MAX(last_seen) AS last_seen
         FROM "${rowTable}"`
      );

      // hot_unique_ips: seen within last 60s
      const nowSec = Math.floor(Date.now() / 1000);
      const hot = await dbGet(
        `SELECT COUNT(DISTINCT ip) AS hot_unique_ips
         FROM "${rowTable}"
         WHERE last_seen >= ?`,
        [nowSec - 60]
      );

      stats = {
        unique_ips: base?.unique_ips ?? 0,
        total_observations: base?.total_observations ?? 0,
        hot_unique_ips: hot?.hot_unique_ips ?? 0,
        first_seen: base?.first_seen ?? null,
        last_seen: base?.last_seen ?? null
      };
    } catch (_) {
      // Fallback: shared table online_ips keyed by run_table
      const base = await dbGet(
        `SELECT
           COUNT(DISTINCT ip) AS unique_ips,
           SUM(seen_count) AS total_observations,
           MIN(first_seen) AS first_seen,
           MAX(last_seen) AS last_seen
         FROM online_ips
         WHERE run_table = ?`,
        [run]
      ).catch(() => null);

      const nowSec = Math.floor(Date.now() / 1000);
      const hot = await dbGet(
        `SELECT COUNT(DISTINCT ip) AS hot_unique_ips
         FROM online_ips
         WHERE run_table = ? AND last_seen >= ?`,
        [run, nowSec - 60]
      ).catch(() => null);

      stats = {
        unique_ips: base?.unique_ips ?? 0,
        total_observations: base?.total_observations ?? 0,
        hot_unique_ips: hot?.hot_unique_ips ?? 0,
        first_seen: base?.first_seen ?? null,
        last_seen: base?.last_seen ?? null
      };
    }

    return res.json(stats || { unique_ips: 0, total_observations: 0, hot_unique_ips: 0, first_seen: null, last_seen: null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Expected by client: /api/run/:run/rows?limit=50 -> array of rows
router.get('/api/run/:run/rows', async (req, res) => {
  const run = String(req.params.run || '');
  const limit = clamp(Number(req.query.limit || 50), 1, 500);

  if (!run) return res.status(400).json({ ok: false, error: 'missing run' });

  try {
    let rowTable = run.replace(/[^a-zA-Z0-9_]/g, '');
    if (!rowTable) rowTable = run;

    // Prefer run-named table
    try {
      const rows = await dbAll(
        `SELECT
           ip,
           port,
           source,
           first_seen,
           last_seen,
           COALESCE(seen_count, 1) AS seen_count,
           "${run}" AS _run
         FROM "${rowTable}"
         ORDER BY last_seen DESC
         LIMIT ?`,
        [limit]
      );

      return res.json(Array.isArray(rows) ? rows : []);
    } catch (_) {
      // Fallback shared table
      const rows = await dbAll(
        `SELECT
           ip,
           port,
           source,
           first_seen,
           last_seen,
           seen_count,
           run_table AS _run
         FROM online_ips
         WHERE run_table = ?
         ORDER BY last_seen DESC
         LIMIT ?`,
        [run, limit]
      ).catch(() => []);

      return res.json(Array.isArray(rows) ? rows : []);
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------------------------
// Scheduler endpoints
// ---------------------------

// Client expects: /api/schedule/status -> { armed, delaySec, nextRunAtMs, running, ... }
router.get('/api/schedule/status', (req, res) => {
  const reset = String(req.query.reset || '0') === '1';
  if (reset) {
    // when UI wants a clean countdown baseline, just respond with current state
  }
  res.json(scheduleStatus());
});

// POST { delaySec }
router.post('/api/schedule/arm', express.json(), async (req, res) => {
  await ensureOutputFile();

  const delaySec = req.body && req.body.delaySec;
  const out = armScheduler(delaySec);
  if (!out.ok) return res.status(400).json(out);

  // Log schedule change
  try {
    fs.appendFileSync(
      OUTPUT_PATH,
      `[dashboard] scheduler armed: delaySec=${sched.delaySec} next=${new Date(sched.nextRunAtMs).toISOString()}\n`
    );
  } catch (_) {}

  res.json(scheduleStatus());
});

router.post('/api/schedule/disarm', async (req, res) => {
  await ensureOutputFile();
  disarmScheduler();

  try {
    fs.appendFileSync(OUTPUT_PATH, `[dashboard] scheduler disarmed\n`);
  } catch (_) {}

  res.json(scheduleStatus());
});

router.post('/api/schedule/run-now', async (req, res) => {
  await ensureOutputFile();

  // Do not interfere with running scan
  if (isRunning()) return res.status(409).json({ ok: false, error: 'scan already running' });

  const out = spawnScanOnce({ byDashboard: true });
  if (!out.ok) return res.status(400).json(out);

  res.json(scheduleStatus());
});

// ---------------------------
// Optional: allow UI to update scan blocks count (styling-only elsewhere)
// ---------------------------

router.get('/api/config', (req, res) => {
  res.json({ ok: true, scanNBlocks });
});

router.post('/api/config/scan-n-blocks', express.json(), async (req, res) => {
  const n = Number(req.body && req.body.nBlocks);
  if (!Number.isFinite(n) || n < 1 || n > 100000) {
    return res.status(400).json({ ok: false, error: 'nBlocks must be a number >= 1' });
  }
  scanNBlocks = Math.floor(n);

  await ensureOutputFile();
  try {
    fs.appendFileSync(OUTPUT_PATH, `[dashboard] SCAN_N_BLOCKS set to ${scanNBlocks}\n`);
  } catch (_) {}

  res.json({ ok: true, scanNBlocks });
});

module.exports = router;
