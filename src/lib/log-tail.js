'use strict';

const fs = require('fs');
const path = require('path');

const LOG_PATH = process.env.LOG_PATH || path.resolve('./scan.log');
const MAX_LOG_BYTES_PER_POLL = Number(process.env.MAX_LOG_BYTES_PER_POLL || (64 * 1024));

const logStateByRun = new Map();

function getLogState(runTable) {
  if (!logStateByRun.has(runTable)) {
    logStateByRun.set(runTable, {
      offset: 0,
      startedAtMs: Date.now(),
      stats: {
        total_lines: 0,
        accepted: 0,
        rejected: 0,
        bloom_skipped: 0,
        last_rate: null
      }
    });
  }
  return logStateByRun.get(runTable);
}

function resetLogState(runTable) {
  logStateByRun.set(runTable, {
    offset: 0,
    startedAtMs: Date.now(),
    stats: {
      total_lines: 0,
      accepted: 0,
      rejected: 0,
      bloom_skipped: 0,
      last_rate: null
    }
  });
}

// Heuristic regexes based on safe_scan.js output
const RX = {
  total: /lines\s*processed[:=]\s*(\d+)/i,
  accepted: /accepted[:=]\s*(\d+)/i,
  rejected: /rejected[:=]\s*(\d+)/i,
  bloom: /bloom(?:_skipped| skipped)?[:=]\s*(\d+)/i,
  rate: /rate[:=]\s*([\d.]+)\s*(?:ips\/s|lines\/s)?/i
};

function parseStats(text, st) {
  if (!text) return;
  st.stats.total_lines += (text.match(/\n/g) || []).length;

  let m;
  if ((m = RX.accepted.exec(text))) st.stats.accepted = Number(m[1]);
  if ((m = RX.rejected.exec(text))) st.stats.rejected = Number(m[1]);
  if ((m = RX.bloom.exec(text))) st.stats.bloom_skipped = Number(m[1]);
  if ((m = RX.rate.exec(text))) st.stats.last_rate = Number(m[1]);
}

function readNew(runTable) {
  const st = getLogState(runTable);

  let stat;
  try {
    stat = fs.statSync(LOG_PATH);
  } catch {
    return { text: '', offset: st.offset, missing: true, log_path: LOG_PATH, stats: st.stats };
  }

  if (stat.size < st.offset) st.offset = 0;

  const start = st.offset;
  const remaining = stat.size - start;
  if (remaining <= 0) return { text: '', offset: st.offset, missing: false, log_path: LOG_PATH, stats: st.stats };

  const toRead = Math.min(remaining, MAX_LOG_BYTES_PER_POLL);
  const fd = fs.openSync(LOG_PATH, 'r');
  try {
    const buf = Buffer.allocUnsafe(toRead);
    const n = fs.readSync(fd, buf, 0, toRead, start);
    st.offset = start + n;
    const text = buf.slice(0, n).toString('utf8');
    parseStats(text, st);
    return { text, offset: st.offset, missing: false, log_path: LOG_PATH, stats: st.stats };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { LOG_PATH, resetLogState, readNew };
