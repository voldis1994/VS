# VS — i3 SERVER · MSI ADMIN · CLIENT

One system. One source of truth: **i3 VS-CORE-01**.

## What runs where

| Machine | Role | Canonical path |
|---|---|---|
| **i3 Debian 13** | Complete server | `SERVER/` Control API :3000, DB, engines, `vs-monitor` |
| **MSI Windows** | ADMIN control panel only | `ADMIN/desktop` → `http://127.0.0.1:5188/` |
| **Remote CLIENT** | Web portal | WireGuard → `http://10.77.0.1:3000/` |

## Install

### i3

```bash
cd ~/VS-new/VS
git pull origin main
sudo bash SERVER/install/INSTALL_I3_SERVER.sh
vs-monitor
```

Check: `ss -lntp | grep 3000` must show **`0.0.0.0:3000`** (not only `10.77.0.1`).

If `/health` fails with DB auth / `28P01`:

```bash
sudo bash SERVER/deploy/fix-db-password.sh
sudo bash SERVER/FIX_CONTROL_API.sh
```

MSI needs the **real** i3 LAN IP (not only 192.168.0.10). After API is up:

```bat
REM in ADMIN\config\control-panel.env
VS_SERVER_URL=http://<i3-lan-ip>:3000
ADMIN\START_ADMIN.bat
```

### MSI

```bat
git pull origin main
ADMIN\INSTALL_ADMIN.bat
ADMIN\START_ADMIN.bat
```

### CLIENT

ADMIN → CLIENTS → create remote login → WireGuard → open portal URL.

## Status

See `DOCS/PHYSICAL_ACCEPTANCE.md` and `DOCS/FINAL_ACCEPTANCE_REPORT.md`.

**Current formal status: NOT PRODUCTION ACCEPTED** until physical chain is retested.
