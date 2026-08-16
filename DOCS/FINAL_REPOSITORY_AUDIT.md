# Final Repository Audit

**Date:** 2026-08-16  
**Branch:** `cursor/vs-final-consolidation-0bd7`

## Classification summary

| Path | Class | Notes |
|------|-------|-------|
| `SERVER/control-api` | PRODUCTION | Authoritative appliance + ADMIN/CLIENT HTTP |
| `SERVER/client-api` | PRODUCTION | Client boundary package |
| `SERVER/core/*` | PRODUCTION | Domain libraries (market, indicators, regime, strategy, risk, execution, broker, supervisor) |
| `SERVER/database` | PRODUCTION | Migrations authority |
| `SERVER/monitor` | PRODUCTION | Graphical i3 panel (was dashboard-v2) |
| `SERVER/install`, `SERVER/deploy`, `SERVER/network` | PRODUCTION | Install/systemd/WG |
| `SERVER/MONITOR_SERVER` | PRODUCTION | Console monitor |
| Former `SERVER/*-engine` shims | DELETED | Re-exports removed; use `SERVER/core` |
| `ADMIN/desktop` | PRODUCTION | MSI UI (was apps/dashboard-v2) |
| `ADMIN/app`, `ADMIN/connection`, `ADMIN/windows` | PRODUCTION | Install/CLI/discovery |
| `CLIENT/desktop` | PRODUCTION | Customer UI (was apps/client-v2) |
| `CLIENT/windows`, `CLIENT/connection` | PRODUCTION | Installers + enrollment helper |
| `CLIENT` stub folders (home/market/…) | DELETED | Empty README stubs |
| `SHARED/` | PRODUCTION | Contracts |
| `DEPLOY/` | PRODUCTION | Corrected symlinks |
| `TESTS/` | TEST-ONLY | |
| `DOCS/` | PRODUCTION docs | |
| `legacy-review/` | ARCHIVE | Was `Old-system/` |
| Root `docker-compose.yml` | PRODUCTION | Postgres+Redis for local/dev appliance deps |
| `dist/` | GENERATED | gitignored |

## Authoritative vs obsolete

| Concern | AUTHORITATIVE | OBSOLETE |
|---------|---------------|----------|
| Server API | `SERVER/control-api` | `legacy-review/apps/control-api` |
| Engines | `SERVER/core/*` (+ vs-core money path inside control-api) | top-level `*-engine` shims (removed) |
| Admin UI | `ADMIN/desktop` | `legacy-review/apps/dashboard` |
| Client UI | `CLIENT/desktop` | stub folders / old dashboard CLIENT mode |
| Monitor | `SERVER/monitor` + `MONITOR_SERVER` | old dashboard |
| Legacy C++ | none in production | `legacy-review/libs` |

## Migrated functionality

- UI v2 → final `desktop` / `monitor` paths
- Presence heartbeat mirrored from CLIENT network device heartbeat
- ADMIN pages bound to real monitor/supervisor/broker/market endpoints (honest NO DATA)
- CLIENT START/STOP calls `/api/v1/trading/start|stop`
- boot.sh no longer falls back to Old-system
- DEPLOY symlinks repaired

## Remaining gaps (honest)

- Physical i3/MSI/remote CLIENT tests require hardware
- `VS_CLIENT_SETUP.exe` requires Windows packager CI
- Capital/market credentials → NOT_CONFIGURED until supplied
- control-api `vs-core` money path coexists with `SERVER/core` libraries (single runtime process; libraries shared for tests)
