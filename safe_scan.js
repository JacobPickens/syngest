#!/usr/bin/env node
'use strict';

/**
README — Streaming IP Ingest → SQLite (per-run tables)

Plain-text logging:
- All script logs are appended to ./runOutput.txt
- Each console line = one log line
- No JSON, no stdout interference
*/

//
// CONFIGURATION
//

const DB_PATH = './online.sqlite';

const PORT = 80;
const SOURCE = 'authorized';

const BLOCKS_FILE = './allowed_blocks.txt';
const BLOCKS_NAMESPACE = 'allowed_blocks_v1';

const RUN_OUTPUT_PATH = './runOutput.txt';

const TTL_DAYS = 7;
const DROP_RUNS_OLDER_THAN_DAYS = 30;

const BATCH_SIZE = 5000;
const ENABLE_STRICT_IP_VALIDATION = true;
const MAX_LINE_LENGTH = 512;

const ENABLE_BLOOM = true;
const SCAN_SIZE_EXPECTED_UNIQUES = 5_000_000;
const BLOOM_TARGET_FP = 0.0001;
const BLOOM_GROWTH_FACTOR = 2.0;
const BLOOM_MAX_BYTES = 128 * 1024 * 1024;

const SCAN_N_BLOCKS = parseInt(process.env.SCAN_N_BLOCKS || '5', 10);

// Producer command for THIS script (set this to whatever you run)
// Example:
// const PRODUCER_CMD = 'cat';
// const PRODUCER_ARGS_TEMPLATE = (ipBlock) => [ './ips.txt' ];
//
// You currently build args inline below; keep it that way if you prefer.
const PRODUCER_CMD = 'zmap'; // <-- set me

// Optional variables for a zmap-style producer (only used if you build args that way)
const ZMAP_RATE_PPS = '5000';
const ZMAP_COOLDOWN = '5';

//
// END CONFIGURATION
//

const { spawn } = require('child_process');
const readline = require('readline');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { iterateBlocks } = require('./iterateBlocks');

let sqlite3;
try {
    sqlite3 = require('sqlite3');
} catch {
    console.error('Missing dependency: sqlite3');
    process.exit(1);
}

/* -------------------- utils -------------------- */

function nowSec() { return Math.floor(Date.now() / 1000); }
function daysToSeconds(d) { return Math.floor(d * 86400); }
function sanitizeIdent(s) { return String(s).replace(/[^a-zA-Z0-9_]/g, '_'); }

function makeRunId() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp =
        `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
        `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const rand = crypto.randomBytes(3).toString('hex');
    return `run_${stamp}_${rand}`;
}

/* -------------------- PLAIN TEXT LOGGER -------------------- */

function createTextLogger(filePath) {
    const abs = path.resolve(filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });

    // Clear log at process start
    try { fs.writeFileSync(abs, ''); } catch { }

    const ws = fs.createWriteStream(abs, { flags: 'a' });

    function write(line) {
        const s = String(line ?? '');
        ws.write(s.endsWith('\n') ? s : s + '\n');
    }

    return {
        info(msg) { write(msg); },
        warn(msg) { write(`WARN: ${msg}`); },
        error(msg) { write(`ERROR: ${msg}`); },
        raw(_stream, chunk) {
            const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
            ws.write(text);
        },
        close() {
            try { ws.end(); } catch { }
        },
        path: abs,
    };
}

/* -------------------- sqlite helpers -------------------- */

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, function (err, rows) {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function closeDb(db) {
    return new Promise((resolve) => {
        try { db.close(() => resolve()); } catch { resolve(); }
    });
}

/* -------------------- IP extraction -------------------- */

function extractIp(line) {
    const t = String(line || '').trim();
    if (!t) return null;

    const s = t.replace(/^\[|\]$/g, '');
    if (net.isIP(s)) return s;

    const m4 = s.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    if (m4 && net.isIP(m4[1])) return m4[1];

    const m6 = t.match(/^\[([^\]]+)\]:(\d+)$/);
    if (m6 && net.isIP(m6[1])) return m6[1];

    return null;
}

/* -------------------- main -------------------- */

(async function main() {
  const log = createTextLogger(RUN_OUTPUT_PATH);
  log.info(`Logging to ${log.path}`);

  if (!PRODUCER_CMD) {
    log.error('PRODUCER_CMD is empty. Set PRODUCER_CMD in config.');
    throw new Error('PRODUCER_CMD is empty. Set PRODUCER_CMD in config.');
  }

  fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
  const db = new sqlite3.Database(DB_PATH);

  // Soft-failure policy: do NOT stop the whole loop on one block failure.
  // We'll only stop on "hard" setup failures (like iterateBlocks returning nothing).
  let hardAbort = false;

  for (let scanIndex = 1; scanIndex <= SCAN_N_BLOCKS; scanIndex++) {
    if (hardAbort) break;

    const runTable = sanitizeIdent(makeRunId());
    let metaInserted = false;
    let runTableCreated = false;

    try {
      await run(db, `
        CREATE TABLE IF NOT EXISTS runs_meta (
          run_table TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          port INTEGER NOT NULL,
          source TEXT NOT NULL
        );
      `);

      await run(db, `
        CREATE TABLE IF NOT EXISTS run_block (
          run_table TEXT PRIMARY KEY,
          ip_block TEXT NOT NULL,
          ip_block_start INTEGER NOT NULL,
          ip_block_end INTEGER NOT NULL,
          ip_block_file TEXT NOT NULL,
          ip_block_namespace TEXT NOT NULL,
          picked_at INTEGER NOT NULL
        );
      `);

      // Per-run table first
      await run(db, `
        CREATE TABLE IF NOT EXISTS "${runTable}" (
          ip TEXT PRIMARY KEY,
          port INTEGER NOT NULL,
          source TEXT NOT NULL,
          first_seen INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          seen_count INTEGER NOT NULL
        );
      `);
      runTableCreated = true;

      await run(db, `CREATE INDEX IF NOT EXISTS "idx_${runTable}_last_seen" ON "${runTable}"(last_seen);`);

      await run(db,
        `INSERT INTO runs_meta(run_table, created_at, port, source) VALUES(?,?,?,?)`,
        [runTable, nowSec(), PORT, SOURCE]
      );
      metaInserted = true;

      // Pick a block
      const blockIter = await iterateBlocks(db, BLOCKS_FILE, {
        namespace: BLOCKS_NAMESPACE,
        runId: runTable,
        ignoreBlank: true,
      });

      const picked = await blockIter.nextMeta();
      if (!picked || !picked.text) {
        log.error('iterateBlocks returned empty block (hard abort)');
        hardAbort = true;
        throw new Error('iterateBlocks returned empty block');
      }

      const IP_BLOCK = picked.text.trim();
      log.info(`Scanning block ${scanIndex}/${SCAN_N_BLOCKS}: ${IP_BLOCK}`);

      await run(db, `
        INSERT INTO run_block
        (run_table, ip_block, ip_block_start, ip_block_end, ip_block_file, ip_block_namespace, picked_at)
        VALUES (?,?,?,?,?,?,?)
      `, [
        runTable,
        IP_BLOCK,
        picked.startByte,
        picked.endByte,
        path.resolve(BLOCKS_FILE),
        BLOCKS_NAMESPACE,
        nowSec(),
      ]);

      const PRODUCER_ARGS = [
        '-p', String(PORT),
        IP_BLOCK,
        '-r', ZMAP_RATE_PPS,
        '--cooldown-time', ZMAP_COOLDOWN,
        '-q',
        '-i', 'ens6',
        '--gateway-mac', '82:01:fa:1c:fa:1d'
      ];

      const child = spawn(PRODUCER_CMD, PRODUCER_ARGS, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stderr.on('data', (d) => log.raw('child_stderr', d));

      const rl = readline.createInterface({ input: child.stdout });

      // Always resolve; never throw from close handler
      const childCloseP = new Promise((resolve) => {
        child.on('close', (code, signal) => {
          try { rl.close(); } catch {}
          resolve({ code, signal });
        });
      });

      // Soft failure: record error but continue to next block
      let childErrored = false;
      child.on('error', (err) => {
        childErrored = true;
        log.error(`Producer error: ${err.message}`);
        try { rl.close(); } catch {}
      });

      const stmt = db.prepare(`
        INSERT INTO "${runTable}" (ip, port, source, first_seen, last_seen, seen_count)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(ip) DO UPDATE SET
          last_seen=excluded.last_seen,
          seen_count="${runTable}".seen_count+1
      `);

      let total = 0;

      for await (const line of rl) {
        if (line.length > MAX_LINE_LENGTH) continue;
        const ip = extractIp(line);
        if (!ip) continue;
        if (ENABLE_STRICT_IP_VALIDATION && net.isIP(ip) === 0) continue;

        try {
          stmt.run(ip, PORT, SOURCE, nowSec(), nowSec());
          total++;
        } catch (e) {
          // Soft: ignore edge-case stmt errors and keep reading
        }
      }

      const { code, signal } = await childCloseP;

      try { stmt.finalize(); } catch {}

      // Soft failure: log but do NOT stop further blocks
      if (childErrored || code !== 0) {
        log.error(`Block failed (soft): runTable=${runTable} ip_block=${IP_BLOCK} code=${code} signal=${signal || ''}`);
      }

      log.info(`Run done (${total} rows)`);
    } catch (e) {
      // For soft failures, we still clean up stale meta so dashboard doesn't query missing tables,
      // but we do NOT stop the loop unless hardAbort was set.
      log.error(`Run failed; cleaning up: ${e && (e.stack || e.message) ? (e.stack || e.message) : String(e)}`);

      try {
        if (metaInserted) {
          await run(db, `DELETE FROM run_block WHERE run_table=?`, [runTable]).catch(() => {});
          await run(db, `DELETE FROM runs_meta WHERE run_table=?`, [runTable]).catch(() => {});
        }
      } catch {}

      try {
        if (runTableCreated) {
          await run(db, `DROP TABLE IF EXISTS "${runTable}"`).catch(() => {});
        }
      } catch {}

      // IMPORTANT: do NOT set hardAbort here; continue to next block
    }
  }

  await closeDb(db);
  log.info('All scans complete');
  log.close();
})().catch((e) => {
  try {
    fs.appendFileSync(
      path.resolve(RUN_OUTPUT_PATH),
      `FATAL: ${String(e && e.stack ? e.stack : e)}\n`
    );
  } catch {}
  console.error(e);
  process.exit(1);
});
