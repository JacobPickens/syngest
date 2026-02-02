'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * iterateBlocks(db, filePath, opts)
 *
 * Randomly iterates over lines in filePath WITHOUT repeats until exhausted,
 * then starts a new cycle. State is persisted in SQLite.
 *
 * Adds per-run tagging: each selected line is recorded in line_picker_picks
 * with run_id + namespace + file_id + line_index + line_text + picked_at.
 *
 * Uses a line-offset index for speed and low memory usage.
 *
 * opts:
 * - namespace: string (default: basename(filePath))
 * - ignoreBlank: boolean (default true)
 * - maxLineBytes: integer (default 8192)
 * - runId: string (optional, recommended) run identifier used for tagging
 *          If omitted, a run id is auto-generated and exposed via api.runId.
 *
 * Returned object:
 * - runId: string
 * - next(): Promise<string>
 * - nextN(n): Promise<string[]>
 * - nextMeta(): Promise<{text,lineIndex,startByte,endByte}>
 * - nextMetaN(n): Promise<Array<{text,lineIndex,startByte,endByte}>>
 * - info(): Promise<object>
 */

async function iterateBlocks(db, filePath, opts = {}) {
  const absFile = path.resolve(filePath);
  const namespace = opts.namespace || path.basename(absFile);
  const ignoreBlank = opts.ignoreBlank !== false;
  const maxLineBytes = Number.isInteger(opts.maxLineBytes) ? opts.maxLineBytes : 8192;

  // Per-run tag (stable identifier you pass from your main script)
  const runId = String(opts.runId || makeRunId());

  await ensureTables(db);

  // Build line-offset index
  const { meta, index } = buildLineIndex(absFile, { ignoreBlank });

  if (index.count === 0) {
    throw new Error(`File contains no usable lines: ${absFile}`);
  }

  const fileId = await upsertFile(db, meta);

  // Ensure state row exists
  await ensureStateRow(db, namespace, fileId, index.count);

  async function next() {
    const arr = await nextN(1);
    return arr[0];
  }

  async function nextN(n) {
    const metas = await nextMetaN(n);
    return metas.map((m) => m.text);
  }

  async function nextMeta() {
    const arr = await nextMetaN(1);
    return arr[0];
  }

  async function nextMetaN(n) {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error('nextMetaN(n): n must be a positive integer');
    }

    // Transaction ensures: (1) state mutation is consistent, (2) picks logging matches the state update.
    await exec(db, 'BEGIN IMMEDIATE;');
    try {
      let state = await getState(db, namespace, fileId);
      let remaining = safeParseJsonArray(state?.remaining_json);

      // Reset if exhausted or mismatch
      if (!remaining || remaining.length === 0 || state.total !== index.count) {
        remaining = freshRemaining(index.count);
        // New cycle marker
        await setCycle(db, namespace, fileId, Date.now(), index.count, remaining);
      }

      const take = Math.min(n, remaining.length);
      const pickedIdx = new Array(take);

      // Random pick without replacement (swap-pop)
      for (let i = 0; i < take; i++) {
        const r = crypto.randomInt(0, remaining.length);
        pickedIdx[i] = remaining[r];
        const last = remaining.pop();
        if (r < remaining.length) remaining[r] = last;
      }

      // Persist remaining for this cycle
      await writeRemaining(db, namespace, fileId, index.count, remaining);

      // Read selected lines by offset (outside DB but inside txn is fine; small reads)
      const pickedMeta = pickedIdx.map((li) => {
        const startByte = index.starts[li];
        const endByte = index.ends[li];
        const text = readLineSlice(absFile, startByte, endByte, maxLineBytes);
        return { text, lineIndex: li, startByte, endByte };
      });

      // Per-run tagging: log picks
      const ts = nowSec();
      for (let i = 0; i < take; i++) {
        await logPick(db, {
          runId,
          namespace,
          fileId,
          lineIndex: pickedMeta[i].lineIndex,
          lineText: pickedMeta[i].text,
          pickedAt: ts,
        });
      }

      await exec(db, 'COMMIT;');
      return pickedMeta;
    } catch (e) {
      await exec(db, 'ROLLBACK;').catch(() => {});
      throw e;
    }
  }

  async function info() {
    const state = await getState(db, namespace, fileId);
    const remaining = safeParseJsonArray(state?.remaining_json) || [];
    return {
      runId,
      namespace,
      file: absFile,
      total_lines: index.count,
      remaining_in_cycle: remaining.length,
      cycle: state?.cycle ?? null,
      last_updated_at: state?.updated_at ?? null,
    };
  }

  return { runId, next, nextN, nextMeta, nextMetaN, info };
}

/* ============================================================================
   LINE OFFSET INDEX
   ============================================================================ */

function buildLineIndex(filePath, { ignoreBlank }) {
  const st = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');

  try {
    const CHUNK = 1 << 16; // 64KB
    const buf = Buffer.allocUnsafe(CHUNK);

    const starts = [];
    const ends = [];

    let filePos = 0;
    let lineStart = 0;
    let hasNonWs = false;
    let lastCR = false;

    function isWs(b) {
      // space, tab, CR
      return b === 0x20 || b === 0x09 || b === 0x0d;
    }

    while (true) {
      const n = fs.readSync(fd, buf, 0, CHUNK, filePos);
      if (n <= 0) break;

      for (let i = 0; i < n; i++) {
        const b = buf[i];

        if (ignoreBlank && b !== 0x0a && !isWs(b)) hasNonWs = true;

        if (b === 0x0a) { // '\n'
          const end = (filePos + i) - (lastCR ? 1 : 0);
          if (!ignoreBlank || hasNonWs) {
            starts.push(lineStart);
            ends.push(end);
          }
          lineStart = filePos + i + 1;
          hasNonWs = false;
          lastCR = false;
        } else {
          lastCR = b === 0x0d;
        }
      }

      filePos += n;
    }

    // last line if no trailing newline
    if (lineStart < st.size) {
      if (!ignoreBlank || hasNonWs) {
        starts.push(lineStart);
        ends.push(st.size);
      }
    }

    return {
      meta: {
        path: filePath,
        mtimeMs: Math.floor(st.mtimeMs),
        sizeBytes: st.size,
        lineCount: starts.length,
      },
      index: {
        starts,
        ends,
        count: starts.length,
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readLineSlice(filePath, start, end, maxBytes) {
  const rawLen = end - start;
  if (rawLen < 0) throw new Error('Invalid line slice');

  const len = Math.min(rawLen, maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    let s = buf.slice(0, n).toString('utf8').trim();
    if (rawLen > maxBytes) s += '…';
    return s;
  } finally {
    fs.closeSync(fd);
  }
}

/* ============================================================================
   SQLITE STATE + PER-RUN PICK LOGGING
   ============================================================================ */

async function ensureTables(db) {
  await exec(db, `
    CREATE TABLE IF NOT EXISTS line_picker_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE,
      mtime_ms INTEGER,
      size_bytes INTEGER,
      line_count INTEGER,
      updated_at INTEGER
    );
  `);

  await exec(db, `
    CREATE TABLE IF NOT EXISTS line_picker_state (
      namespace TEXT,
      file_id INTEGER,
      cycle INTEGER,
      total INTEGER,
      remaining_json TEXT,
      updated_at INTEGER,
      PRIMARY KEY (namespace, file_id)
    );
  `);

  await exec(db, `
    CREATE TABLE IF NOT EXISTS line_picker_picks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      file_id INTEGER NOT NULL,
      line_index INTEGER NOT NULL,
      line_text TEXT NOT NULL,
      picked_at INTEGER NOT NULL
    );
  `);

  await exec(db, `CREATE INDEX IF NOT EXISTS idx_line_picker_picks_run ON line_picker_picks(run_id);`);
  await exec(db, `CREATE INDEX IF NOT EXISTS idx_line_picker_picks_ns ON line_picker_picks(namespace, file_id);`);
  await exec(db, `CREATE INDEX IF NOT EXISTS idx_line_picker_picks_time ON line_picker_picks(picked_at);`);
}

async function upsertFile(db, meta) {
  await exec(db, `
    INSERT INTO line_picker_files(path, mtime_ms, size_bytes, line_count, updated_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET
      mtime_ms=excluded.mtime_ms,
      size_bytes=excluded.size_bytes,
      line_count=excluded.line_count,
      updated_at=excluded.updated_at;
  `, [meta.path, meta.mtimeMs, meta.sizeBytes, meta.lineCount, nowSec()]);

  const row = await get(db, `SELECT id FROM line_picker_files WHERE path=?`, [meta.path]);
  return row.id;
}

async function ensureStateRow(db, namespace, fileId, total) {
  const exists = await get(db, `
    SELECT 1 FROM line_picker_state WHERE namespace=? AND file_id=?
  `, [namespace, fileId]);

  if (exists) return;

  const remaining = freshRemaining(total);
  await exec(db, `
    INSERT INTO line_picker_state(namespace, file_id, cycle, total, remaining_json, updated_at)
    VALUES(?,?,?,?,?,?)
  `, [namespace, fileId, Date.now(), total, JSON.stringify(remaining), nowSec()]);
}

async function getState(db, namespace, fileId) {
  return get(db, `
    SELECT cycle, total, remaining_json, updated_at
    FROM line_picker_state
    WHERE namespace=? AND file_id=?
  `, [namespace, fileId]);
}

async function setCycle(db, namespace, fileId, cycleMs, total, remaining) {
  await exec(db, `
    UPDATE line_picker_state
    SET cycle=?, total=?, remaining_json=?, updated_at=?
    WHERE namespace=? AND file_id=?
  `, [cycleMs, total, JSON.stringify(remaining), nowSec(), namespace, fileId]);
}

async function writeRemaining(db, namespace, fileId, total, remaining) {
  await exec(db, `
    UPDATE line_picker_state
    SET total=?, remaining_json=?, updated_at=?
    WHERE namespace=? AND file_id=?
  `, [total, JSON.stringify(remaining), nowSec(), namespace, fileId]);
}

async function logPick(db, { runId, namespace, fileId, lineIndex, lineText, pickedAt }) {
  await exec(db, `
    INSERT INTO line_picker_picks(run_id, namespace, file_id, line_index, line_text, picked_at)
    VALUES(?,?,?,?,?,?)
  `, [runId, namespace, fileId, lineIndex, lineText, pickedAt]);
}

/* ============================================================================
   HELPERS
   ============================================================================ */

function freshRemaining(total) {
  const arr = Array.from({ length: total }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function safeParseJsonArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function makeRunId() {
  // run_YYYYMMDD_HHMMSS_rand
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = crypto.randomBytes(3).toString('hex');
  return `run_${stamp}_${rand}`;
}

/* ============================================================================

   sqlite3 promise wrappers

   ============================================================================ */

function exec(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, function (err, row) {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

module.exports = { iterateBlocks };

