// --- src/lib/scheduler.js ---
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const runOutput = require('./run-output');
const { writeEnvKey } = require('./envfile');

const STATE_PATH = process.env.SCHED_STATE_PATH || path.resolve('./scheduleState.json');

const DEFAULT_SCAN_CMD = process.env.SCAN_CMD || 'node safe_scan.js';

const LOOP_MS = Number(process.env.SCHED_LOOP_MS || 500);

let loopTimer = null;
let runningChild = null;

function defaultState() {
  return {
    armed: false,
    delaySec: 0,
    nextRunAtMs: null,
    running: false,
    startedByDashboard: false,
    lastExit: null
  };
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const j = JSON.parse(raw);
    return { ...defaultState(), ...(j || {}) };
  } catch {
    return defaultState();
  }
}

function writeState(next) {
  const s = { ...defaultState(), ...(next || {}) };
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(s), 'utf8');
  } catch {}
  return s;
}

function getState() {
  return readState();
}

function computeNextRun(delaySec) {
  const d = Math.max(1, Number(delaySec || 0));
  return Date.now() + (d * 1000);
}

function arm(delaySec, source = 'dashboard') {
  const d = Math.max(1, Number(delaySec || 0));
  // keep delay persisted so the UI countdown is stable
  writeEnvKey('SCAN_DELAY_SEC', String(d));

  const next = writeState({
    armed: true,
    delaySec: d,
    nextRunAtMs: computeNextRun(d),
    startedByDashboard: source === 'dashboard'
  });

  return { ok: true, state: next };
}

function cancel(source = 'dashboard') {
  const s = readState();
  const next = writeState({
    ...s,
    armed: false,
    nextRunAtMs: null,
    startedByDashboard: source === 'dashboard'
  });
  return { ok: true, state: next };
}

function runNow(source = 'dashboard') {
  const s = readState();
  const delay = Math.max(1, Number(s.delaySec || 60));
  const next = writeState({
    ...s,
    armed: true, // run-now implies “armed” for that cycle
    delaySec: delay,
    nextRunAtMs: Date.now() + 250, // very soon
    startedByDashboard: source === 'dashboard'
  });
  return { ok: true, state: next };
}

function startBackgroundLoop(scanCmd = DEFAULT_SCAN_CMD) {
  if (loopTimer) return;

  loopTimer = setInterval(async () => {
    const s = readState();

    if (!s.armed || s.running) return;
    if (!s.nextRunAtMs || Date.now() < s.nextRunAtMs) return;

    // fire
    writeState({ ...s, running: true, lastExit: null });

    // new run clears output + marks state
    runOutput.beginRun({ source: 'scheduler', cmd: scanCmd });

    // IMPORTANT: don't pipe stdout into dashboard (zmap uses stdout for results).
    // safe_scan.js should write to runOutput.txt itself.
    //
    // Cross-platform execution:
    // - Windows machines running this project won't necessarily have "bash".
    // - Using `shell: true` preserves support for command strings (e.g. "node safe_scan.js")
    //   without introducing a hard dependency on bash.
    runningChild = spawn(scanCmd, {
      shell: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    runningChild.stderr.on('data', (d) => {
      try { runOutput.appendLine(String(d).trimEnd()); } catch {}
    });

    runningChild.on('close', (code, signal) => {
      const s2 = readState();

      const exit = { code, signal };
      writeState({
        ...s2,
        running: false,
        lastExit: exit,
        nextRunAtMs: s2.armed ? computeNextRun(s2.delaySec || 60) : null
      });

      runOutput.endRun(exit);
      runningChild = null;
    });

    runningChild.on('error', (err) => {
      const s2 = readState();
      const exit = { code: 1, signal: null, error: err.message };
      writeState({ ...s2, running: false, lastExit: exit, armed: false, nextRunAtMs: null });
      runOutput.endRun(exit);
      runningChild = null;
    });
  }, LOOP_MS);
}

module.exports = {
  startBackgroundLoop,
  getState,
  arm,
  cancel,
  runNow
};

