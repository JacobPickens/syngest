/*
  One-time migration: normalize any TEXT timestamps in the SQLite DB to America/Chicago.

  IMPORTANT:
  - Epoch timestamps stored as INTEGER (seconds/ms) represent an absolute moment in time and
    are timezone-neutral. Shifting them would corrupt your data.
  - This script only rewrites values where SQLite reports typeof(column) == 'text'.

  Usage:
    node src/scripts/migrate_db_timestamps_to_central.js

  Optional:
    DB_PATH=... (absolute or repo-root relative)
*/

'use strict';

const fs = require('fs');
const path = require('path');

const CHI_TZ = 'America/Chicago';

const CHI_DTF = new Intl.DateTimeFormat('en-US', {
  timeZone: CHI_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

function fmtCentral(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const parts = CHI_DTF.formatToParts(d);
  const pick = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

function resolveProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 20; i++) {
    const p = path.join(dir, 'package.json');
    if (fs.existsSync(p)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(startDir);
}

const PROJECT_ROOT = resolveProjectRoot(__dirname);
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, 'db', 'online.sqlite');

const DB_PATH = process.env.DB_PATH
  ? (path.isAbsolute(process.env.DB_PATH) ? process.env.DB_PATH : path.resolve(PROJECT_ROOT, process.env.DB_PATH))
  : DEFAULT_DB_PATH;

try {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
} catch (_) {}

function openDb() {
  // Prefer better-sqlite3 if available.
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const BetterSqlite3 = require('better-sqlite3');
    const db = new BetterSqlite3(DB_PATH);
    return { kind: 'better-sqlite3', db };
  } catch (_) {}

  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const sqlite3 = require('sqlite3');
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
    return { kind: 'sqlite3', db, sqlite3 };
  } catch (_) {}

  throw new Error('No sqlite driver found. Install better-sqlite3 or sqlite3.');
}

function runAllSqlite3(dbc, sql, params) {
  return new Promise((resolve, reject) => {
    dbc.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function runExecSqlite3(dbc, sql, params) {
  return new Promise((resolve, reject) => {
    dbc.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      return resolve(this?.changes || 0);
    });
  });
}

async function migrateTableColumn(conn, table, column) {
  const selectSql = `SELECT rowid AS rid, ${column} AS v FROM ${table} WHERE typeof(${column})='text'`;
  const rows = conn.kind === 'better-sqlite3'
    ? conn.db.prepare(selectSql).all()
    : await runAllSqlite3(conn.db, selectSql, []);

  if (!rows.length) return { scanned: 0, updated: 0 };

  let updated = 0;
  for (const r of rows) {
    const raw = r && r.v != null ? String(r.v) : '';
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) continue;
    const out = fmtCentral(ms);
    if (!out) continue;

    const updSql = `UPDATE ${table} SET ${column}=? WHERE rowid=?`;
    if (conn.kind === 'better-sqlite3') {
      const info = conn.db.prepare(updSql).run(out, r.rid);
      updated += info?.changes ? Number(info.changes) : 0;
    } else {
      updated += await runExecSqlite3(conn.db, updSql, [out, r.rid]);
    }
  }

  return { scanned: rows.length, updated };
}

async function main() {
  console.log(`[migrate] DB_PATH=${DB_PATH}`);

  const conn = openDb();

  // These are the columns we care about for the dashboard.
  const targets = [
    { table: 'runs', columns: ['started_at', 'ended_at'] },
    { table: 'ips', columns: ['first_seen', 'last_seen'] },
    { table: 'run_blocks', columns: ['picked_at'] }
  ];

  let totalScanned = 0;
  let totalUpdated = 0;

  for (const t of targets) {
    for (const col of t.columns) {
      try {
        const res = await migrateTableColumn(conn, t.table, col);
        totalScanned += res.scanned;
        totalUpdated += res.updated;
        if (res.scanned) {
          console.log(`[migrate] ${t.table}.${col}: scanned ${res.scanned} text rows, updated ${res.updated}`);
        }
      } catch (e) {
        // Table may not exist yet on a fresh DB.
        console.log(`[migrate] skip ${t.table}.${col}: ${String(e?.message || e)}`);
      }
    }
  }

  if (totalScanned === 0) {
    console.log('[migrate] No TEXT timestamps found. If your timestamps are stored as INTEGER epoch values, no conversion is needed.');
  }

  console.log(`[migrate] done. updated=${totalUpdated}`);

  if (conn.kind === 'sqlite3') {
    conn.db.close();
  }
}

main().catch((e) => {
  console.error(`[migrate] failed: ${String(e?.message || e)}`);
  process.exitCode = 1;
});
