# VS — i3 SERVER · MSI ADMIN · CLIENT

One system. One source of truth: **i3 VS-CORE-01**.

## What runs where

| Machine | Role | Canonical path |
|---|---|---|
| **i3 Debian 13** | Complete server | `SERVER/` Control API :3000, DB, engines, `vs-monitor` |
| **MSI Windows** | ADMIN control panel only | `ADMIN/desktop` → `http://127.0.0.1:5188/` |
| **Remote CLIENT** | Web portal | WireGuard → `http://10.77.0.1:3000/` |

## Install

### i3 (one command)

```bash
cd ~/VS-new/VS
git pull origin main
sudo bash SERVER/START_I3.sh
```

### MSI (one command)

```bat
git pull
ADMIN\START_EVERYTHING.bat
```

If LAN IP wrong, put i3 IP in `ADMIN\config\SERVER_IP.txt` then re-run.

### CLIENT

ADMIN → CLIENTS → CREATE WEB LOGIN → open printed URL → market + lot + START/STOP.

See `DOCS/ONE_SHOT_START.md`.

## Status

See `DOCS/PHYSICAL_ACCEPTANCE.md` and `DOCS/FINAL_ACCEPTANCE_REPORT.md`.

**Current formal status: NOT PRODUCTION ACCEPTED** until physical chain is retested.
