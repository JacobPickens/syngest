#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

/**
README — Streaming IP Ingest → SQLite (per-run tables)

Plain-text logging:
- All script logs are appended to ./bin/runOutput.txt
- Each console line = one log line
- No JSON, no stdout interference
*/

//
// CONFIGURATION
//

const ENABLE_CONSOLE_LOGGING = true; // set false to silence console output

// NOTE:
// This script may be spawned from different working directories (e.g. src/scripts).
// All runtime paths must resolve to the project root so we don't accidentally write
// runOutput.txt or the database inside src/.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const DB_PATH = path.join(PROJECT_ROOT, 'db', 'online.sqlite');

const PORT = 80;
const SOURCE = 'authorized';

const BLOCKS_FILE = path.join(PROJECT_ROOT, '/bin/allowed_blocks.txt');
const BLOCKS_NAMESPACE = 'allowed_blocks_v1';

// Must live in the project root (not inside src/scripts)
// All runtime artifacts should live in <project>/bin
const RUN_OUTPUT_PATH = path.join(PROJECT_ROOT, 'bin', 'runOutput.txt');

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

const BLOCKS_PER_CYCLE = parseInt(process.env.BLOCKS_PER_CYCLE || process.env.SCAN_N_BLOCKS || '5', 10);

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

function createTextLogger(filePath, enableConsole = true) {
    const abs = path.resolve(filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });

    // Clear log at process start
    try { fs.writeFileSync(abs, ''); } catch {}

    const ws = fs.createWriteStream(abs, { flags: 'a' });

    function write(line, stream = 'stdout') {
        const s = String(line ?? '');
        const out = s.endsWith('\n') ? s : s + '\n';

        // Always write to file
        ws.write(out);

        // Optional console mirror
        if (enableConsole) {
            if (stream === 'stderr') process.stderr.write(out);
            else process.stdout.write(out);
        }
    }

    return {
        info(msg) {
            write(msg, 'stdout');
        },
        warn(msg) {
            write(`WARN: ${msg}`, 'stderr');
        },
        error(msg) {
            write(`ERROR: ${msg}`, 'stderr');
        },
        raw(_stream, chunk) {
            const text = Buffer.isBuffer(chunk)
                ? chunk.toString('utf8')
                : String(chunk ?? '');

            ws.write(text);
            if (enableConsole) {
                process.stderr.write(text);
            }
        },
        close() {
            try { ws.end(); } catch {}
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

/* -------------------- allowed blocks (DB source of truth) -------------------- */

async function ensureAllowedBlocksTables(db) {
  await run(db, "CREATE TABLE IF NOT EXISTS allowed_blocks (ip_block TEXT PRIMARY KEY, added_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);");
  await run(db, "CREATE TABLE IF NOT EXISTS allowed_blocks_state (namespace TEXT PRIMARY KEY, total INTEGER NOT NULL, remaining_json TEXT NOT NULL, cycle INTEGER NOT NULL, updated_at INTEGER NOT NULL);");
  // Per-block attribution (so the UI can show IPs found per block)
  await run(db, "CREATE TABLE IF NOT EXISTS block_ips (run_id TEXT NOT NULL, ip_block TEXT NOT NULL, ip TEXT NOT NULL, port INTEGER NOT NULL, source TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, seen_count INTEGER NOT NULL, PRIMARY KEY (run_id, ip_block, ip, port, source));");
  await run(db, "CREATE INDEX IF NOT EXISTS idx_block_ips_block ON block_ips(ip_block);");
  await run(db, "CREATE INDEX IF NOT EXISTS idx_block_ips_last_seen ON block_ips(last_seen);");
}

async function seedAllowedBlocksFromFile(db, blocksFilePath, log) {
  const rows = await all(db, "SELECT COUNT(1) AS n FROM allowed_blocks").catch(() => [{ n: 0 }]);
  const n = Number(rows?.[0]?.n || 0);
  if (n > 0) return;

  const abs = path.resolve(String(blocksFilePath || ""));
  if (!abs || !fs.existsSync(abs)) {
    if (log) log.warn("No allowed blocks found in DB and file missing: " + abs);
    return;
  }

  const text = fs.readFileSync(abs, "utf8");
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const now = nowSec();

  for (const b of lines) {
    await run(db, "INSERT OR IGNORE INTO allowed_blocks(ip_block, added_at, enabled) VALUES(?,?,1)", [b, now]).catch(() => {});
  }

  if (log) log.info(`Seeded allowed_blocks from file (${lines.length} blocks)`);
}

async function loadAllowedBlocks(db) {
  const rows = await all(db, "SELECT ip_block FROM allowed_blocks WHERE enabled=1 ORDER BY added_at ASC");
  return rows.map(r => String(r.ip_block || "")).filter(Boolean);
}

function freshRemaining(total) {
  const arr = new Array(total);
  for (let i = 0; i < total; i++) arr[i] = i;
  return arr;
}

async function getStateRow(db, namespace) {
  const rows = await all(db, "SELECT namespace,total,remaining_json,cycle,updated_at FROM allowed_blocks_state WHERE namespace=? LIMIT 1", [namespace]);
  return rows && rows[0] ? rows[0] : null;
}

async function setStateRow(db, namespace, total, remaining, cycle) {
  const ts = nowSec();
  await run(db, "INSERT INTO allowed_blocks_state(namespace,total,remaining_json,cycle,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(namespace) DO UPDATE SET total=excluded.total, remaining_json=excluded.remaining_json, cycle=excluded.cycle, updated_at=excluded.updated_at", [namespace, total, JSON.stringify(remaining), cycle, ts]);
}

async function pickAllowedBlock(db, namespace, blocks) {
  if (!blocks || blocks.length === 0) throw new Error("No allowed blocks available");
  const total = blocks.length;

  await run(db, "BEGIN IMMEDIATE;");
  try {
    let st = await getStateRow(db, namespace);
    let remaining = null;
    try { remaining = st && st.remaining_json ? JSON.parse(st.remaining_json) : null; } catch { remaining = null; }

    if (!st || !Array.isArray(remaining) || remaining.length === 0 || Number(st.total) !== total) {
      remaining = freshRemaining(total);
      const nextCycle = st ? (Number(st.cycle) || 0) + 1 : 1;
      await setStateRow(db, namespace, total, remaining, nextCycle);
      st = await getStateRow(db, namespace);
    }

    // Random pick without replacement (swap-pop)
    const r = crypto.randomInt(0, remaining.length);
    const idx = remaining[r];
    const last = remaining.pop();
    if (r < remaining.length) remaining[r] = last;

    await setStateRow(db, namespace, total, remaining, Number(st.cycle) || 1);
    await run(db, "COMMIT;");

    return { text: blocks[idx], lineIndex: idx, startByte: 0, endByte: 0 };
  } catch (e) {
    await run(db, "ROLLBACK;").catch(() => {});
    throw e;
  }
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
  const log = createTextLogger(RUN_OUTPUT_PATH, ENABLE_CONSOLE_LOGGING);
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

// Run identity (one run spans multiple blocks in this invocation)
const runId = sanitizeIdent(String(process.env.RUN_ID || makeRunId()));
const initiatedBy = String(process.env.RUN_INITIATED_BY || 'unknown');

await run(db, `
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    initiated_by TEXT NOT NULL DEFAULT 'unknown',
    status TEXT NOT NULL DEFAULT 'running',
    blocks_scanned INTEGER NOT NULL DEFAULT 0,
    ips_found INTEGER NOT NULL DEFAULT 0
  );
`);

await run(db, `
  CREATE TABLE IF NOT EXISTS run_blocks (
    run_id TEXT NOT NULL,
    ip_block TEXT NOT NULL,
    picked_at INTEGER NOT NULL,
    ip_block_file TEXT NOT NULL,
    ip_block_namespace TEXT NOT NULL,
    ip_block_start INTEGER NOT NULL,
    ip_block_end INTEGER NOT NULL,
    PRIMARY KEY (run_id, ip_block, picked_at)
  );
`);

await run(db, `
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
`);

await run(db, `CREATE INDEX IF NOT EXISTS idx_ips_ip ON ips(ip);`);
await run(db, `CREATE INDEX IF NOT EXISTS idx_ips_last_seen ON ips(last_seen);`);
await run(db, `CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);`);

// Upsert run row (start)
await run(db,
  `INSERT INTO runs(run_id, started_at, initiated_by, status, blocks_scanned, ips_found)
   VALUES(?, ?, ?, 'running', 0, 0)
   ON CONFLICT(run_id) DO UPDATE SET
     started_at=excluded.started_at,
     initiated_by=excluded.initiated_by,
     status='running'`,
  [runId, nowSec(), initiatedBy]
).catch(() => {});

log.info(`Run started: ${runId} (by=${initiatedBy})`);

await ensureAllowedBlocksTables(db);
await seedAllowedBlocksFromFile(db, BLOCKS_FILE, log);
const allowedBlocks = await loadAllowedBlocks(db);
if (!allowedBlocks || allowedBlocks.length === 0) {
  log.error('No allowed blocks available. Ensure db.allowed_blocks is seeded (or place bin/allowed_blocks.txt).');
  hardAbort = true;
}

let blocksScanned = 0;

const upsertIpStmt = db.prepare(`

  INSERT INTO ips (run_id, ip, port, source, first_seen, last_seen, seen_count)
  VALUES (?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(run_id, ip, port, source) DO UPDATE SET
    last_seen=excluded.last_seen,
    seen_count=ips.seen_count+1
`);

const upsertBlockIpStmt = db.prepare(`
  INSERT INTO block_ips (run_id, ip_block, ip, port, source, first_seen, last_seen, seen_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(run_id, ip_block, ip, port, source) DO UPDATE SET
    last_seen=excluded.last_seen,
    seen_count=block_ips.seen_count+1
`);

for (let scanIndex = 1; scanIndex <= BLOCKS_PER_CYCLE; scanIndex++) {
  if (hardAbort) break;

  try {
    const picked = await pickAllowedBlock(db, BLOCKS_NAMESPACE, allowedBlocks);
    if (!picked || !picked.text) {
      log.error('Allowed-blocks picker returned empty block (hard abort)');
      hardAbort = true;
      throw new Error('Allowed-blocks picker returned empty block');
    }

    const IP_BLOCK = picked.text.trim();
    log.info(`Scanning block ${scanIndex}/${BLOCKS_PER_CYCLE}: ${IP_BLOCK}`);

    await run(db, `
      INSERT INTO run_blocks
      (run_id, ip_block, picked_at, ip_block_file, ip_block_namespace, ip_block_start, ip_block_end)
      VALUES (?,?,?,?,?,?,?)
    `, [
      runId,
      IP_BLOCK,
      nowSec(),
      path.resolve(BLOCKS_FILE),
      BLOCKS_NAMESPACE,
      picked.startByte,
      picked.endByte,
    ]).catch(() => {});

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

    const childCloseP = new Promise((resolve) => {
      child.on('close', (code, signal) => {
        try { rl.close(); } catch {}
        resolve({ code, signal });
      });
    });

    let childErrored = false;
    child.on('error', (err) => {
      childErrored = true;
      log.error(`Producer error: ${err.message}`);
      try { rl.close(); } catch {}
    });

    let total = 0;
    for await (const line of rl) {
      if (line.length > MAX_LINE_LENGTH) continue;
      const ip = extractIp(line);
      if (!ip) continue;
      if (ENABLE_STRICT_IP_VALIDATION && net.isIP(ip) === 0) continue;

      try {
        const ts = nowSec();
        upsertIpStmt.run(runId, ip, PORT, SOURCE, ts, ts);
        upsertBlockIpStmt.run(runId, IP_BLOCK, ip, PORT, SOURCE, ts, ts);
        total++;
      } catch (_) {
        // soft
      }
    }

    const { code, signal } = await childCloseP;

    if (childErrored || code !== 0) {
      log.error(`Block failed (soft): run_id=${runId} ip_block=${IP_BLOCK} code=${code} signal=${signal || ''}`);
    }

    blocksScanned += 1;
    log.info(`Block complete (${total} ips)`);
  } catch (e) {
    log.error(`Block error (soft): ${e && (e.stack || e.message) ? (e.stack || e.message) : String(e)}`);
    // continue
  }
}

try { upsertIpStmt.finalize(); } catch {}

// Update run aggregates (end)
const runDistinct = await all(db, `SELECT COUNT(DISTINCT ip) AS n FROM ips WHERE run_id=?`, [runId]).catch(() => [{ n: 0 }]);
const ipsFound = Number((runDistinct && runDistinct[0] && runDistinct[0].n) || 0);

await run(db,
  `UPDATE runs
   SET ended_at=?, status=?, blocks_scanned=?, ips_found=?
   WHERE run_id=?`,
  [nowSec(), hardAbort ? 'failed' : 'completed', blocksScanned, ipsFound, runId]
).catch(() => {});

log.info(`Run complete: ${runId} blocks=${blocksScanned} ips=${ipsFound}`);

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

