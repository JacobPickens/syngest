# Scan Dashboard (Pug) — runOutput.json + optional scheduler

A **non-interfering** Express + Pug dashboard that **polls**:
- your SQLite DB (created by your scan script)
- `runOutput.json` for the terminal output + "accurate" pills (preferred)

It does **not** attach to or control an already-running scan process.
Optionally, you can **arm a timeout** to start a scan **from the dashboard** (disabled automatically while a scan is running).

## Install

```bash
npm i
```

## Run

Env vars:

- `DB_PATH` (default `./online.sqlite`)
- `OUTPUT_PATH` (default `./runOutput.json`)
- `DASH_PORT` (default `3000`)
- `SCAN_CMD` (default `node safe_scan.js`)
- `SCAN_CWD` (default current working directory)

```bash
DB_PATH=./online.sqlite OUTPUT_PATH=./runOutput.json npm start
```

Open: `http://localhost:3000/dashboard`

## Feeding the terminal

The UI reads `runOutput.json`. It supports these shapes:

1) Object:
```json
{
  "running": true,
  "lines": ["line 1", "line 2"],
  "stats": {"onlineIpsFound": 12, "totalSearched": 999},
  "meta": {}
}
```

2) Array of lines:
```json
["line 1","line 2"]
```

If your scanner only writes stdout, you can still use the optional dashboard scheduler; it will write its captured output into `runOutput.json`.

## Scheduler

The page has a "NEXT SCAN" panel:
- set `delay_minutes` and click **arm** (recurring; runs every delay until canceled)
- shows a countdown to the next run
- disables controls while a scan is running
- **run_now** starts immediately

This only affects scans started *by the dashboard* using `SCAN_CMD`.


## Scan blocks per run

The dashboard can write `SCAN_N_BLOCKS` into `.env` (path configurable with `ENV_PATH`). The spawned scan process gets this env var.
