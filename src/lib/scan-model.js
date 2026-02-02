// --- scan-model.js ---
'use strict';

const { openDb, get, all, isSafeIdent } = require('./db');

/**
 * Defensive helpers so the dashboard never dies when:
 * - runs_meta exists but the per-run table was deleted / never created
 * - DB is fresh and tables don't exist yet
 */

async function tableExists(db, tableName) {
  try {
    const row = await get(db, `
      SELECT name
      FROM sqlite_master
      WHERE type='table' AND name = ?
      LIMIT 1
    `, [tableName]);
    return !!(row && row.name);
  } catch {
    return false;
  }
}

async function safeHasCoreTables(db) {
  // If the DB is new or schema not created yet, avoid throwing
  const hasRuns = await tableExists(db, 'runs_meta');
  const hasBlock = await tableExists(db, 'run_block');
  return { hasRuns, hasBlock };
}

/**
 * Returns the newest run that actually has a backing per-run table.
 * If no valid run exists, returns null.
 */
async function getLatestRunMeta() {
  const db = openDb();
  try {
    const { hasRuns } = await safeHasCoreTables(db);
    if (!hasRuns) return null;

    // Grab a small window of recent runs and pick the first whose table exists
    const rows = await all(db, `
      SELECT run_table, created_at, port, source,
             (SELECT MIN(created_at) FROM runs_meta) AS first_ever_created_at
      FROM runs_meta
      ORDER BY created_at DESC
      LIMIT 25
    `);

    for (const r of rows || []) {
      if (!r || !r.run_table) continue;
      if (!isSafeIdent(r.run_table)) continue;
      const ok = await tableExists(db, r.run_table);
      if (ok) return r;
    }

    return null;
  } catch (e) {
    // Never crash the dashboard due to schema or missing tables
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

async function getRunBlock(runTable) {
  if (!isSafeIdent(runTable)) return null;

  const db = openDb();
  try {
    const { hasBlock } = await safeHasCoreTables(db);
    if (!hasBlock) return null;

    const row = await get(db, `
      SELECT
        run_table,
        ip_block,
        ip_block_start,
        ip_block_end,
        ip_block_file,
        ip_block_namespace,
        picked_at
      FROM run_block
      WHERE run_table = ?
      LIMIT 1
    `, [runTable]);

    return row || null;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * Stats shape matches the current client usage in /public/js/dashboard.js:
 * - unique_ips
 * - total_observations
 * - ips_seen_last_60s
 * - first_seen_min
 * - last_seen_max
 */
async function getRunStats(runTable) {
  if (!isSafeIdent(runTable)) return null;

  const db = openDb();
  try {
    // If the per-run table doesn’t exist, return null (client will keep pills as-is)
    if (!(await tableExists(db, runTable))) return null;

    const stats = await get(db, `
      SELECT
        COUNT(*) AS unique_ips,
        COALESCE(SUM(seen_count), 0) AS total_observations,
        COALESCE(MIN(first_seen), 0) AS first_seen_min,
        COALESCE(MAX(last_seen), 0) AS last_seen_max
      FROM "${runTable}"
    `);

    const nowSec = Math.floor(Date.now() / 1000);

    const hot = await get(db, `
      SELECT COUNT(*) AS ips_seen_last_60s
      FROM "${runTable}"
      WHERE last_seen >= ?
    `, [nowSec - 60]);

    return {
      unique_ips: Number(stats?.unique_ips || 0) || 0,
      total_observations: Number(stats?.total_observations || 0) || 0,
      first_seen_min: Number(stats?.first_seen_min || 0) || 0,
      last_seen_max: Number(stats?.last_seen_max || 0) || 0,
      ips_seen_last_60s: Number(hot?.ips_seen_last_60s || 0) || 0
    };
  } catch (e) {
    // If meta points to a table that was never created (or got cleaned up), don't crash the dashboard.
    if (e && (e.code === 'SQLITE_ERROR' || e.code === 'SQLITE_MISUSE')) return null;
    throw e;
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * Latest rows for the run.
 * Returned row shape matches client table rendering:
 * ip, seen_count, last_seen, first_seen, source, port
 */
async function getLatestRows(runTable, limit = 200) {
  if (!isSafeIdent(runTable)) return [];

  const lim = Math.max(1, Math.min(500, Number(limit) || 200));
  const db = openDb();
  try {
    if (!(await tableExists(db, runTable))) return [];

    const rows = await all(db, `
      SELECT ip, seen_count, last_seen, first_seen, source, port
      FROM "${runTable}"
      ORDER BY last_seen DESC
      LIMIT ?
    `, [lim]);

    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    if (e && (e.code === 'SQLITE_ERROR' || e.code === 'SQLITE_MISUSE')) return [];
    throw e;
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * Convenience bundle for your /api/latest-run route:
 * { meta, block, first_ever_created_at }
 */
async function getLatestRunBundle() {
  const meta = await getLatestRunMeta();
  if (!meta) {
    return { meta: null, block: null, first_ever_created_at: null };
  }
  const block = await getRunBlock(meta.run_table);
  const firstEver = Number(meta.first_ever_created_at || 0) || null;

  return {
    meta: {
      run_table: meta.run_table,
      created_at: Number(meta.created_at || 0) || 0,
      port: Number(meta.port || 0) || 0,
      source: meta.source || ''
    },
    block,
    first_ever_created_at: firstEver
  };
}

module.exports = {
  getLatestRunMeta,
  getRunBlock,
  getRunStats,
  getLatestRows,
  getLatestRunBundle
};
