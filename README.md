# VS — QUICK START

## SERVER / i3 Debian 13

1. Copy release package (`dist/VS-SERVER`) or clone repo to the i3
2. Run `sudo bash SERVER/install/INSTALL_SERVER.sh`
3. Configure external required values in `/var/lib/vs-server/server.env` (Capital credentials, `PUBLIC_HOST_OR_IP`, admin token)
4. Run `sudo bash SERVER/FINAL_ACCEPTANCE.sh`
5. Run `sudo bash SERVER/SHOW_DASHBOARD.sh` (or `sudo bash SERVER/INSTALL_MONITOR` for autostart)

## ADMIN / MSI Windows 11

1. Run `ADMIN\INSTALL_ADMIN.bat`
2. Run `ADMIN\START_ADMIN.bat`
3. Optional: `ADMIN\FINAL_ACCEPTANCE.bat`

LAN/Wi-Fi to Control API (default `http://192.168.0.10:3000`). WireGuard is **not** required for home ADMIN.

## CLIENT / remote Windows

1. Create enrollment from ADMIN (Network / devices)
2. Deliver CLIENT installer + enrollment package securely
3. Run `CLIENT\INSTALL_CLIENT.bat` (or enrollment installer)
4. Run `CLIENT\FINAL_ACCEPTANCE.bat` / `CLIENT\VERIFY_CLIENT.bat`
5. Run `CLIENT\START_CLIENT.bat` if packaged

Remote path: Internet → WireGuard UDP 51820 → VS-CORE-01 → Client API. Clients never talk to the broker.

---

# Market Reader / VS

Real-time multi-source market intelligence + VS SERVER trading appliance.

## Product boundaries

```
VS/
├── SERVER/     # Authoritative brain (i3) — INSTALL_SERVER / INSTALL_I3_SERVER
├── ADMIN/      # Control Panel only (MSI) — no broker/Postgres/Redis
├── CLIENT/     # Remote app + WireGuard
├── DOCS/       # Architecture + audits + FINAL_PRODUCT_REPORT
├── TESTS/      # Cross-cutting unit tests
├── dist/       # Release packages from scripts/BUILD_RELEASE.sh
└── legacy-review/  # Frozen archives (not imported by production)
```

Money path lives under `SERVER/control-api` (verified P0). Compatibility symlinks:
`apps/control-api` → `SERVER/control-api`, `deploy/vs-core` → `SERVER/deploy`.

**LIVE trading stays fail-closed** (`LIVE_TRADING_ENABLED=false`) until Capital credentials + production gates are satisfied on real hardware.

## Architecture roles

| Role | Machine | Contents |
|------|---------|----------|
| Brain | i3 Debian 13 `VS-CORE-01` | Supervisor, Postgres, Redis, market/indicators/regime/strategy/signal/risk/execution, broker gateway, APIs, WireGuard, local dashboard |
| Admin | MSI Windows 11 | VS ADMIN Control Panel only |
| Client | Customer Windows | VS CLIENT + WireGuard; Client API only |

See `DOCS/ARCHITECTURE.md`, `DOCS/FINAL_GAP_AUDIT.md`, `DOCS/FINAL_PRODUCT_REPORT.md`, `DOCS/PORTS.md`.

## Deployment detail

### [i3 SERVER] — VS-CORE-01

```bash
# from repo or release package
sudo bash SERVER/install/INSTALL_SERVER.sh
sudo bash SERVER/STATUS_SERVER
sudo bash SERVER/INSTALL_MONITOR   # optional physical console
sudo bash SERVER/FINAL_ACCEPTANCE.sh
```

Safe broker probes (never place trades):

```bash
bash SERVER/broker-gateway/capital/vs-broker-status
bash SERVER/broker-gateway/capital/vs-broker-test-auth
bash SERVER/broker-gateway/capital/vs-broker-test-market
```

Backup:

```bash
sudo bash SERVER/BACKUP_SERVER.sh
sudo bash SERVER/LIST_BACKUPS.sh
sudo bash SERVER/VERIFY_BACKUP.sh /var/lib/vs-server/backup/vs-pg-….sql.gz
# restore requires CONFIRM:
# sudo bash SERVER/RESTORE_SERVER.sh <file> CONFIRM
```

### [MSI WINDOWS ADMIN]

```bat
cd ADMIN
INSTALL_ADMIN.bat
START_ADMIN.bat
FINAL_ACCEPTANCE.bat
```

Requires Node.js 20+ and `API_ADMIN_TOKEN`. Discovers VS-CORE-01 on **LAN first**. If the server is down, UI shows **SERVER OFFLINE** — no mock READY.

### [REMOTE CLIENT]

1. ADMIN → NETWORK → create CLIENT enrollment.
2. Client PC: install WireGuard + enrollment; Client API via `10.77.0.1`.
3. Router: forward UDP **51820** WAN → VS-CORE-01 LAN IP.
4. Set `PUBLIC_HOST_OR_IP` on server to the **reachable** public endpoint (not `192.168.x.x` for remote ISPs).

## Release packages

```bash
bash scripts/BUILD_RELEASE.sh
# produces dist/VS-SERVER, dist/VS-ADMIN, dist/VS-CLIENT
```

## Tests

```bash
cd SERVER/control-api && npm test
cd TESTS && npm test
cd ADMIN && npm test
```

## Docs index

- `DOCS/FINAL_GAP_AUDIT.md` — requirement vs source truth
- `DOCS/NO_FAKE_AUDIT.md` — fake/mock/demo classification
- `DOCS/PORTS.md` — firewall / exposure
- `DOCS/FINAL_PRODUCT_REPORT.md` — subsystem status matrix
- `DOCS/IMPLEMENTATION_REPORT.md` / `DOCS/ACCEPTANCE_REPORT.md`
