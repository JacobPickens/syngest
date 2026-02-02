// --- src/routes/dashboard.js ---
// Express router for the dashboard UI + API.
//
// This router is wired to the rest of the project:
// - Scheduler state + run spawning is handled by src/lib/scheduler.js
// - Run console output + tailing is handled by src/lib/run-output.js
// - Run metadata + rows are read from the project's SQLite DB (default: ./online.sqlite)
//
// NOTE: DB access is best-effort and supports either `better-sqlite3` (sync) or `sqlite3` (async)
// if either dependency is installed.

'use strict';

const path = require('path');
const express = require('express');

const scheduler = require('../lib/scheduler');
const runOutput = require('../lib/run-output');

const router = express.Router();

// ---------------------------
// Paths (project-root relative)
// ---------------------------

// __dirname is: <project>/src/routes
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'online.sqlite');

// allow override via env; accept absolute or project-root relative
const DB_PATH = process.env.DB_PATH
  ? (path.isAbsolute(process.env.DB_PATH) ? process.env.DB_PATH : path.resolve(PROJECT_ROOT, process.env.DB_PATH))
  : DEFAULT_DB_PATH;

// For display only (tailing uses runOutput.OUTPUT_TXT_PATH)
const OUTPUT_PATH = runOutput.OUTPUT_TXT_PATH;

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

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function safeTableName(input) {
  const s = String(input || '');
  // allow run_YYYYMMDD_HHMMSS_xxxxxx
  const cleaned = s.replace(/[^a-zA-Z0-9_]/g, '');
  return cleaned;
}

// ---------------------------
// Page route (pug render)
// ---------------------------

router.get(['/', '/dashboard'], (req, res) => {
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
//
// Client expects: { text, source, running, ... }

router.get('/api/tail', (req, res) => {
  const key = String(req.query.key || 'global');
  const reset = String(req.query.reset || '0') === '1';

  try {
    const out = runOutput.tail(key, reset);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------------------------
// Run + DB endpoints
// ---------------------------

// Expected by client: /api/run/latest -> { meta, block, firstEverCreatedAt }
router.get('/api/run/latest', async (req, res) => {
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

    let block = null;
    if (meta && meta.run_table) {
      block = await dbGet(
        `SELECT ip_block, picked_at, ip_block_namespace, ip_block_file
         FROM run_block
         WHERE run_table = ?
         ORDER BY picked_at DESC
         LIMIT 1`,
        [meta.run_table]
      ).catch(() => null);
    } else {
      // fallback: latest block overall
      block = await dbGet(
        `SELECT ip_block, picked_at, ip_block_namespace, ip_block_file, run_table
         FROM run_block
         ORDER BY picked_at DESC
         LIMIT 1`
      ).catch(() => null);
    }

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
  const run = safeTableName(req.params.run);
  if (!run) return res.status(400).json({ ok: false, error: 'missing run' });

  try {
    const base = await dbGet(
      `SELECT
         COUNT(DISTINCT ip) AS unique_ips,
         COUNT(1) AS total_observations,
         MIN(first_seen) AS first_seen,
         MAX(last_seen) AS last_seen
       FROM "${run}"`
    );

    const nowSec = Math.floor(Date.now() / 1000);
    const hot = await dbGet(
      `SELECT COUNT(DISTINCT ip) AS hot_unique_ips
       FROM "${run}"
       WHERE last_seen >= ?`,
      [nowSec - 60]
    ).catch(() => ({ hot_unique_ips: 0 }));

    return res.json({
      unique_ips: base?.unique_ips ?? 0,
      total_observations: base?.total_observations ?? 0,
      hot_unique_ips: hot?.hot_unique_ips ?? 0,
      first_seen: base?.first_seen ?? null,
      last_seen: base?.last_seen ?? null
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Expected by client: /api/run/:run/rows?limit=50 -> array of rows
router.get('/api/run/:run/rows', async (req, res) => {
  const run = safeTableName(req.params.run);
  const limit = clamp(Number(req.query.limit || 50), 1, 500);

  if (!run) return res.status(400).json({ ok: false, error: 'missing run' });

  try {
    const rows = await dbAll(
      `SELECT
         ip,
         port,
         source,
         first_seen,
         last_seen,
         seen_count,
         "${run}" AS _run
       FROM "${run}"
       ORDER BY last_seen DESC
       LIMIT ?`,
      [limit]
    ).catch(() => []);

    return res.json(Array.isArray(rows) ? rows : []);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------------------------
// Scheduler endpoints (persisted state)
// ---------------------------

// Client expects: /api/schedule/status -> { armed, delaySec, nextRunAtMs, running, ... }
router.get('/api/schedule/status', (req, res) => {
  res.json(scheduler.getState());
});

// POST { delaySec }
router.post('/api/schedule/arm', express.json(), (req, res) => {
  const delaySec = Number(req.body && req.body.delaySec);

  if (!Number.isFinite(delaySec) || delaySec < 1) {
    return res.status(400).json({ ok: false, error: 'delaySec must be >= 1' });
  }

  const out = scheduler.arm(delaySec, 'dashboard');
  return res.json(out.state);
});

// POST (no body)
router.post('/api/schedule/disarm', (req, res) => {
  const out = scheduler.cancel('dashboard');
  return res.json(out.state);
});

// Alias for older UIs that send “cancel”
router.post('/api/schedule/cancel', (req, res) => {
  const out = scheduler.cancel('dashboard');
  return res.json(out.state);
});

// POST (no body)
router.post('/api/schedule/run-now', (req, res) => {
  const out = scheduler.runNow('dashboard');
  return res.json(out.state);
});

module.exports = router;
