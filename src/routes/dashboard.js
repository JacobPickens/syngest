// --- src/routes/dashboard.js ---
// Dashboard UI + API.
//
// Schema summary:
// - runs(run_id, started_at, ended_at, initiated_by, status, blocks_scanned, ips_found)
// - run_blocks(run_id, ip_block, picked_at, ip_block_namespace, ip_block_file)
// - ips(run_id, ip, port, source, first_seen, last_seen, seen_count)

'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const scheduler = require('../lib/scheduler');
const runOutput = require('../lib/run-output');

const router = express.Router();

// ---------------------------
// Paths (project-root relative)
// ---------------------------

// __dirname is: <project>/src/routes
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'db', 'online.sqlite');

// allow override via env; accept absolute or project-root relative
const DB_PATH = process.env.DB_PATH
  ? (path.isAbsolute(process.env.DB_PATH) ? process.env.DB_PATH : path.resolve(PROJECT_ROOT, process.env.DB_PATH))
  : DEFAULT_DB_PATH;

// Ensure the DB directory exists before we try to open it.
try {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
} catch (_) {}

// For display only (tailing uses runOutput.OUTPUT_TXT_PATH)
const OUTPUT_PATH = runOutput.OUTPUT_TXT_PATH;

// ---------------------------
// Optional SQLite (best-effort)
// ---------------------------

let sqlite = null;
let db = null;


// Seed allowed_blocks from bin/allowed_blocks.txt if the DB table is empty.
// (DB is source of truth at runtime; the file is just a bootstrap.)
function seedAllowedBlocksIfEmpty(dbc, sqliteKind, projectRoot) {
  try {
    const blocksFile = path.join(projectRoot, 'bin', 'allowed_blocks.txt');
    if (!fs.existsSync(blocksFile)) return;
    const lines = fs.readFileSync(blocksFile, 'utf8')
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return;

    const now = Math.floor(Date.now() / 1000);

    if (sqliteKind === 'better-sqlite3') {
      const n = dbc.prepare('SELECT COUNT(1) AS n FROM allowed_blocks').get() || { n: 0 };
      if (Number(n.n || 0) > 0) return;
      const ins = dbc.prepare('INSERT OR IGNORE INTO allowed_blocks(ip_block, added_at, enabled) VALUES(?,?,1)');
      const tx = dbc.transaction((rows) => { for (const b of rows) ins.run(b, now); });
      tx(lines);
      return;
    }

    // sqlite3: best-effort async seeding
    dbc.get('SELECT COUNT(1) AS n FROM allowed_blocks', [], (err, row) => {
      if (err) return;
      if (Number(row?.n || 0) > 0) return;
      const stmt = dbc.prepare('INSERT OR IGNORE INTO allowed_blocks(ip_block, added_at, enabled) VALUES(?,?,1)');
      for (const b of lines) stmt.run(b, now);
      stmt.finalize?.();
    });
  } catch (_) {
    // ignore
  }
}


// Support either better-sqlite3 or sqlite3 if installed.
function tryInitDb() {
  if (db) return db;

  const initSchemaSql = `
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      initiated_by TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'running', -- running|completed|failed
      blocks_scanned INTEGER NOT NULL DEFAULT 0,
      ips_found INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS run_blocks (
      run_id TEXT NOT NULL,
      ip_block TEXT NOT NULL,
      picked_at INTEGER NOT NULL,
      ip_block_namespace TEXT NOT NULL,
      ip_block_file TEXT NOT NULL,
      PRIMARY KEY (run_id, ip_block, picked_at)
    );

    CREATE TABLE IF NOT EXISTS ips (
      run_id TEXT NOT NULL,
      ip TEXT NOT NULL,
      port INTEGER NOT NULL,
      source TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      seen_count INTEGER NOT NULL,
      PRIMARY KEY (run_id, ip, port, source)
    );

    CREATE TABLE IF NOT EXISTS block_ips (
      run_id TEXT NOT NULL,
      ip_block TEXT NOT NULL,
      ip TEXT NOT NULL,
      port INTEGER NOT NULL,
      source TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      seen_count INTEGER NOT NULL,
      PRIMARY KEY (run_id, ip_block, ip, port, source)
    );

    CREATE TABLE IF NOT EXISTS allowed_blocks (
      ip_block TEXT PRIMARY KEY,
      added_at INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_ips_ip ON ips(ip);
    CREATE INDEX IF NOT EXISTS idx_block_ips_block ON block_ips(ip_block);
    CREATE INDEX IF NOT EXISTS idx_block_ips_last_seen ON block_ips(last_seen);
    CREATE INDEX IF NOT EXISTS idx_ips_last_seen ON ips(last_seen);
    CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
  `;

  // better-sqlite3 (sync)
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const BetterSqlite3 = require('better-sqlite3');
    sqlite = { kind: 'better-sqlite3' };
    db = new BetterSqlite3(DB_PATH);
    db.exec(initSchemaSql);
    seedAllowedBlocksIfEmpty(db, sqlite.kind, PROJECT_ROOT);
    return db;
  } catch (_) {}

  // sqlite3 (async)
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const sqlite3 = require('sqlite3');
    sqlite = { kind: 'sqlite3', sqlite3 };
    db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
    db.serialize();
    db.exec(initSchemaSql);
    seedAllowedBlocksIfEmpty(db, sqlite.kind, PROJECT_ROOT);
    return db
  } catch (_) {}

  return null;
}

try { tryInitDb(); } catch (_) {}

function dbAll(sql, params = []) {
  const dbc = tryInitDb();
  if (!dbc) return Promise.reject(new Error('No sqlite driver found (install better-sqlite3 or sqlite3)'));

  if (sqlite.kind === 'better-sqlite3') {
    try {
      const stmt = dbc.prepare(sql);
      return Promise.resolve(stmt.all(params));
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
      return Promise.resolve(stmt.get(params));
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

function safeRunId(input) {
  const s = String(input || '');
  // allow simple ids like run_YYYY..._hex
  return s.replace(/[^a-zA-Z0-9_]/g, '');
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
// Summary / pills
// ---------------------------

router.get('/api/pills', async (_req, res) => {
  try {
    const st = scheduler.getState();
    const runState = runOutput.peekState();

    const totalFound = await dbGet(`SELECT COUNT(DISTINCT ip) AS n FROM ips`).catch(() => ({ n: 0 }));
    const firstHit = await dbGet(`SELECT MIN(first_seen) AS t FROM ips`).catch(() => ({ t: null }));
    const lastHit = await dbGet(`SELECT MAX(last_seen) AS t FROM ips`).catch(() => ({ t: null }));

    const lastRunRow = await dbGet(
      `SELECT run_id FROM runs WHERE status='completed' ORDER BY ended_at DESC, started_at DESC LIMIT 1`
    ).catch(() => null);

    const lastRunCount = lastRunRow
      ? await dbGet(`SELECT COUNT(DISTINCT ip) AS n FROM ips WHERE run_id=?`, [lastRunRow.run_id]).catch(() => ({ n: 0 }))
      : { n: 0 };

    let thisRun = { running: false, run_id: null, n: 0 };
    if (runState && runState.running && runState.meta && runState.meta.runId) {
      const rid = safeRunId(runState.meta.runId);
      if (rid) {
        const c = await dbGet(`SELECT COUNT(DISTINCT ip) AS n FROM ips WHERE run_id=?`, [rid]).catch(() => ({ n: 0 }));
        thisRun = { running: true, run_id: rid, n: c.n || 0 };
      }
    }

    return res.json({
      ok: true,
      totalFound: Number(totalFound.n || 0),
      lastRun: Number(lastRunCount.n || 0),
      thisRun,
      firstHit: firstHit.t ? Number(firstHit.t) : null,
      lastHit: lastHit.t ? Number(lastHit.t) : null,
      scheduler: st,
      runState: runState || null
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------------------------
// Allowed blocks summary
// ---------------------------

router.get('/api/allowed-blocks', async (_req, res) => {
  try {
    const rows = await dbAll(
      "SELECT ab.ip_block AS ip_block, ab.enabled AS enabled, ab.added_at AS added_at,\n              COALESCE(rb.times_scanned, 0) AS times_scanned,\n              rb.last_scanned_at AS last_scanned_at,\n              COALESCE(bi.ips_found, 0) AS ips_found\n       FROM allowed_blocks ab\n       LEFT JOIN (\n         SELECT ip_block, COUNT(1) AS times_scanned, MAX(picked_at) AS last_scanned_at\n         FROM run_blocks\n         GROUP BY ip_block\n       ) rb ON rb.ip_block = ab.ip_block\n       LEFT JOIN (\n         SELECT ip_block, COUNT(DISTINCT ip) AS ips_found\n         FROM block_ips\n         GROUP BY ip_block\n       ) bi ON bi.ip_block = ab.ip_block\n       WHERE ab.enabled = 1\n       ORDER BY (rb.last_scanned_at IS NULL) ASC, rb.last_scanned_at DESC, ab.added_at DESC"
    );

    const totals = rows.reduce((acc, r) => {
      acc.blocks += 1;
      acc.scans += Number(r.times_scanned || 0);
      acc.ips += Number(r.ips_found || 0);
      return acc;
    }, { blocks: 0, scans: 0, ips: 0 });

    return res.json({ ok: true, rows: rows.map((r) => ({
      ip_block: r.ip_block,
      times_scanned: Number(r.times_scanned || 0),
      last_scanned_at: r.last_scanned_at ? Number(r.last_scanned_at) : null,
      ips_found: Number(r.ips_found || 0),
      scanned_before: Number(r.times_scanned || 0) > 0
    })), totals });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------------------------
// Runs
// ---------------------------

router.get('/api/runs', async (req, res) => {
  const limit = clamp(Number(req.query.limit || 20), 1, 200);
  try {
    const rows = await dbAll(
      `SELECT run_id, started_at, ended_at, initiated_by, status, blocks_scanned, ips_found
       FROM runs
       ORDER BY started_at DESC
       LIMIT ?`,
      [limit]
    ).catch(() => []);
    return res.json(Array.isArray(rows) ? rows : []);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/api/runs/:runId/ips', async (req, res) => {
  const runId = safeRunId(req.params.runId);
  const limit = clamp(Number(req.query.limit || 500), 1, 5000);
  if (!runId) return res.status(400).json({ ok: false, error: 'missing run id' });

  try {
    const rows = await dbAll(
      `SELECT ip, port, source, first_seen, last_seen, seen_count
       FROM ips
       WHERE run_id=?
       ORDER BY last_seen DESC
       LIMIT ?`,
      [runId, limit]
    ).catch(() => []);
    return res.json(Array.isArray(rows) ? rows : []);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

router.get('/api/run/latest', async (_req, res) => {
  try {
    const meta = await dbGet(
      `SELECT run_id, started_at, ended_at, initiated_by, status, blocks_scanned, ips_found
       FROM runs
       ORDER BY started_at DESC
       LIMIT 1`
    ).catch(() => null);

    let block = null;
    if (meta && meta.run_id) {
      block = await dbGet(
        `SELECT ip_block, picked_at, ip_block_namespace, ip_block_file
         FROM run_blocks
         WHERE run_id=?
         ORDER BY picked_at DESC
         LIMIT 1`,
        [meta.run_id]
      ).catch(() => null);
    }

    return res.json({ meta, block });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------------------------
// Recent blocks (grazing log)
// ---------------------------

router.get('/api/blocks/recent', async (req, res) => {
  const limit = clamp(Number(req.query.limit || 8), 1, 50);
  try {
    const rows = await dbAll(
      `SELECT ip_block, picked_at, run_id, ip_block_namespace, ip_block_file
       FROM run_blocks
       ORDER BY picked_at DESC
       LIMIT ?`,
      [limit]
    ).catch(() => []);
    return res.json(Array.isArray(rows) ? rows : []);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------------------------
// Scheduler endpoints
// ---------------------------

router.get('/api/schedule/status', (req, res) => {
  res.json(scheduler.getState());
});

router.post('/api/schedule/arm', express.json(), (req, res) => {
  const delaySec = Number(req.body && req.body.delaySec);
  if (!Number.isFinite(delaySec) || delaySec < 1) {
    return res.status(400).json({ ok: false, error: 'delaySec must be >= 1' });
  }
  const out = scheduler.arm(delaySec, 'dashboard');
  return res.json(out.state);
});

router.post('/api/schedule/disarm', (req, res) => {
  const out = scheduler.cancel('dashboard');
  return res.json(out.state);
});

router.post('/api/schedule/cancel', (req, res) => {
  const out = scheduler.cancel('dashboard');
  return res.json(out.state);
});

router.post('/api/schedule/run-now', (req, res) => {
  const out = scheduler.runNow('dashboard');
  return res.json(out.state);
});

module.exports = router;
