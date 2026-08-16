# Physical i3 monitor fix — retest commands

## Software status

**SOFTWARE FIX READY FOR PHYSICAL RETEST**

Physical acceptance remains **FAILED** until i3 is retested.

## What broke

1. `MONITOR_SERVER` preferred the git tree `SERVER/control-api` (often without `node_modules`) over `/opt/vs-server/control-api`, then hard-failed: `tsx missing`.
2. Monitor tried to source `/var/lib/vs-server/server.env` (mode 600) → `Permission denied` for non-root paths.

## What was fixed

- Prefer installed `/opt/vs-server/control-api` local `node_modules/.bin/tsx`
- Curl fallback to `GET /api/v1/server/monitor/console/text` (localhost only, **no secrets**)
- `INSTALL_I3_SERVER` installs deps, verifies tsx, installs `/usr/local/bin/vs-monitor`, self-tests monitor endpoint
- `server.env` mode `640` root:vs-server — monitor no longer needs to read it
- Path: `SERVER/install/INSTALL_I3_SERVER.sh`

## Exact physical commands

```bash
cd ~/VS-new/VS
git pull origin main
sudo bash SERVER/install/INSTALL_I3_SERVER.sh
vs-monitor
```
