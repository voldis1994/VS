# VS CORE — Production System

## Products

1. **VS CORE SERVER** — Debian 13 on i3 (`VS-CORE-01`)
2. **VS ADMIN** — Windows MSI Control Panel only (`VS-ADMIN-01`)
3. **VS CLIENT** — Windows customer application + WireGuard

```
CUSTOMER (Internet) --WireGuard--> HOME ROUTER --> i3 SERVER
MSI ADMIN (LAN) -------------------------------^
```

i3 remains authoritative if MSI or all clients disconnect.

## Repository

```
SERVER/         i3 brain (control-api, client-api, core engines, monitor, install)
ADMIN/          MSI Control Panel (desktop UI + windows installers)
CLIENT/         Customer app (desktop UI + windows installers + enrollment)
SHARED/         Contracts / types
DEPLOY/         Symlinks to debian/windows/systemd/wireguard/firewall assets
TESTS/          Automated + physical checklists
DOCS/           Architecture and operations
legacy-review/  Archived historical code (never imported by production)
scripts/        Release packaging
```

## i3 install

```bash
git clone <repo>
cd VS
sudo bash SERVER/install/INSTALL_SERVER.sh
sudo bash SERVER/install/HEALTHCHECK.sh
bash SERVER/SHOW_DASHBOARD.sh
```

## MSI ADMIN install

```bat
ADMIN\INSTALL_ADMIN.bat
ADMIN\START_ADMIN.bat
```

## Customer CLIENT

```bat
CLIENT\INSTALL_CLIENT.bat
CLIENT\START_CLIENT.bat
CLIENT\VERIFY_CLIENT.bat
```

Packaged deliverable: `scripts/BUILD_CLIENT_PACKAGE.sh` → `dist/VS-CLIENT` (Windows CI wraps as `VS_CLIENT_SETUP.exe`).

## Rules

- No fake LIVE / CONNECTED / prices / P/L in production UI
- `LIVE_TRADING_ENABLED=false` by default
- ADMIN API ≠ CLIENT API
- Documentation: `DOCS/`
