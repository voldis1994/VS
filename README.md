# VS CORE — Production System

## Products

1. **VS CORE SERVER** — Debian 13 on i3 (`VS-CORE-01`)
2. **VS ADMIN** — Windows MSI Control Panel only (`VS-ADMIN-01`)
3. **VS CLIENT** — Customer **web portal** (login + market + lot + robot)

```
CUSTOMER browser  --->  http://<i3-ip>:3000/  (login from ADMIN)
MSI ADMIN (LAN)   --->  i3 Control API
```

i3 remains authoritative if MSI or all clients disconnect.

## Repository

```
SERVER/         i3 brain (control-api, core, monitor, install)
ADMIN/          MSI Control Panel
CLIENT/desktop  Customer web UI (served by i3 at :3000)
SHARED/         Contracts
DEPLOY/         Deploy asset index
TESTS/ DOCS/ legacy-review/ scripts/
```

## i3 install

```bash
git clone <repo>
cd VS
sudo bash SERVER/install/INSTALL_SERVER.sh
sudo bash SERVER/install/HEALTHCHECK.sh
bash SERVER/SHOW_DASHBOARD.sh
```

## MSI ADMIN

```bat
ADMIN\INSTALL_ADMIN.bat
ADMIN\START_ADMIN.bat
```

Then: **CLIENTS → CREATE WEB LOGIN** → copy URL + login + password for the customer.

## Customer CLIENT

1. Open the URL from ADMIN (example: `http://192.168.0.10:3000/`)
2. Sign in with login + password
3. Choose market, set lot, START/STOP robot

No Git / Node / installer required for the customer. Details: `DOCS/CLIENT_INSTALL.md`.

## Rules

- No fake LIVE / CONNECTED / prices / P/L in production UI
- `LIVE_TRADING_ENABLED=false` by default
- ADMIN API ≠ CLIENT API
- Documentation: `DOCS/`
