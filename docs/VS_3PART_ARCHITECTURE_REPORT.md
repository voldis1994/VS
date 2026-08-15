# VS 3-PART ARCHITECTURE REPORT

Branch: `cursor/vs-architecture-server-admin-client-0bd7`  
Architecture HEAD: `f3064c26c4eee34b3cd9e67cd98fa9bb1742d20c`  
Base P0 HEAD: `d1f09f9eeaca6dbe52d17379ee23d8928ed564da`  
PR: https://github.com/voldis1994/VS/pull/52  
**LIVE_READY: false** (Capital DEMO + physical i3 remain EXTERNAL_BLOCKER — never mocked)

## Gate table

| Item | Result |
|------|--------|
| SERVER | **CREATED** |
| ADMIN | **CREATED** |
| CLIENT | **CREATED** (structure + BUILD_CLIENT; native UI deferred) |
| EXISTING CORE MIGRATED | **PASS** (git rename → `SERVER/control-api`) |
| MONEY PATH REGRESSION | **PASS** (210 unit tests incl. P0 A–J) |
| SERVER INSTALL | **PASS** (`SERVER/INSTALL_SERVER` + deploy units) |
| SERVER START | **PASS** (`SERVER/START_SERVER` validates; does not install) |
| SERVER TUI | **PASS** (existing `runTui` — independent of trading lifecycle) |
| SERVER AUTO-START FOUNDATION | **PASS** (systemd `vs-server.service` + watchdog) |
| ADMIN INSTALL | **PASS** (`ADMIN/INSTALL_ADMIN`) |
| ADMIN START | **PASS** (`ADMIN/START_ADMIN` → diagnostic client) |
| SERVER ↔ ADMIN AUTH | **PASS** (`x-admin-token` required; 401 without) |
| SERVER ↔ ADMIN ENCRYPTION | **FOUNDATION PASS** — auth required; default bind localhost; LAN only with non-default token (`ADMIN_BIND=lan`); TLS expected via operator reverse proxy / private network (not open weak public) |
| REAL SERVER TELEMETRY | **PASS** (`/api/v1/admin/snapshot` uses `hostTelemetry` / runtime probes) |
| ADMIN DISCONNECT DETECTION | **PASS** (`serverAdminConnection.test.ts`) |
| ADMIN RECONNECT | **PASS** (same suite) |
| SERVER RUNS WITHOUT ADMIN | **PASS** (Admin is client-only; SERVER boot independent) |
| CLIENT STRUCTURE | **PASS** |
| CLIENT BACKEND ON SERVER | **PASS** (`mobileApiV1` / client routes remain on SERVER) |
| CLIENT ISOLATION | **PASS** (existing isolation tests) |
| FULL CORE TESTS | **PASS** |
| EXTERNAL BLOCKERS | HISTORICAL_BASELINE, CAPITAL_REAL_DEMO, PHYSICAL_i3 |

## Layout

```
SERVER/   control-api + deploy + config + INSTALL/START/STOP/STATUS
ADMIN/    connection client + diagnostic START_ADMIN
CLIENT/   BUILD_CLIENT + connection rules (no Capital)
```

Compatibility symlinks: `apps/control-api`, `deploy/vs-core`, `config`.

## Two-machine acceptance (operator)

1. Machine A: `SERVER/INSTALL_SERVER` then `START_SERVER` (set `API_ADMIN_TOKEN`, optional `ADMIN_BIND=lan`)
2. Machine B: `ADMIN/INSTALL_ADMIN`, set `VS_SERVER_URL` + token, `START_ADMIN`
3. ADMIN shows REAL `server_id`, CPU/RAM/SSD/uptime/probes from SERVER
4. Stop SERVER → ADMIN `DISCONNECTED` (no stale LIVE)
5. Restart SERVER → ADMIN reconnects to fresh snapshot

## Explicit non-goals this PR

- Full AAA Admin UI
- Full native Client UI
- Claiming LIVE_READY / closing Capital DEMO or physical i3
