# Rebuild Audit

**Date:** 2026-08-16  
**Against:** FINAL PRODUCTION BUILD master spec

## Classification

| Path | Class | Notes |
|------|-------|-------|
| `SERVER/control-api` | KEEP | Authoritative Control API + money path |
| `SERVER/client-api` | KEEP | Client auth boundary |
| `SERVER/core/*` | KEEP | Engines (market, indicators, regime, strategy, signal, risk, execution, broker, supervisor) |
| `SERVER/database` | KEEP | Migrations 001–013 |
| `SERVER/install` | KEEP | INSTALL/HEALTHCHECK/BACKUP |
| `SERVER/dashboard-v2` | KEEP | New i3 panel |
| `SERVER/deploy` | KEEP | boot + systemd |
| `SERVER/network` + `wireguard` | KEEP | WG/firewall ops |
| `ADMIN/apps/dashboard-v2` | KEEP | New MSI ADMIN UI |
| `ADMIN/windows` | KEEP | Installers |
| `CLIENT/apps/client-v2` | KEEP | New CLIENT UI |
| `CLIENT/windows` | KEEP | Installers |
| `SHARED` | KEEP | Contracts |
| `TESTS` | KEEP | Automated + physical checklists |
| `DOCS` | KEEP | Canonical docs |
| `DEPLOY` | KEEP | Aggregated deploy links |
| `scripts` | KEEP | Release packaging |
| `Old-system/**` | ARCHIVE | All historical C++/old UI/cmake/tools/docs |
| `SERVER/*-engine` shims | KEEP (compat) | Re-export `SERVER/core/*` |
| `docker-compose.yml` | KEEP | Postgres/Redis for appliance |
| Fake LIVE prices / fake clients | DELETE from prod | Fail-closed NO DATA / CONFIG_REQUIRED |

## Production import rule

`Old-system/` must never be imported by production Node paths. Enforced by `TESTS/unit/no-legacy-ui-imports.test.ts`.

## Duplicate / conflict resolution

| Conflict | Resolution |
|----------|------------|
| Old `apps/dashboard` | In `Old-system/apps/dashboard` |
| C++ `libs/` | In `Old-system/libs` — not wired to vs-server |
| Dual readiness concepts | Supervisor: PROCESS vs SYSTEM vs TRADING |
| Client API vs Control API | Separate packages; CLIENT cannot use admin token |

## Still PARTIAL (honest)

- Capital live session without credentials
- Remote WG E2E without public endpoint
- Native `VS_CLIENT_SETUP.exe` (folder package exists; Windows packager CI needed)
- Full OpenAPI export
- Every ADMIN page fully wired beyond dashboard/servers/clients
