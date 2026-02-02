# Dump README

Version: v0.0.1
State: grazing
Rollback target: v0.0.0

Syngest feeds the Anabolic Repo.

## Changes in this version

- Dashboard restyled to match the reference: glass panels, top state bar, stat pills, left rail.
- Prominent **Validated hits** table (recent IPs) + sticky header.
- Live **Terminal** tail panel for run output.
- **Grazer controls** panel: intake cycle, arm/disarm, graze now, and countdown.
- **Feed rate** panel with a sparkline chart driven by real DB stats (hot unique IPs in the last minute).
- Added a three-state UI toggle (Idle / Grazing / Ingesting) persisted to localStorage for later workflows.
- Added API: `/api/blocks/recent` for the Grazing log panel.
- Hardened `/api/run/latest` to ignore stale runs whose per-run table no longer exists.
- Version-control scripts now understand README fields (rollback target) and print-active won’t expect sha256.
