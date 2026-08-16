# VS Legacy Audit

**Date:** 2026-08-16  
**Branch:** `cursor/vs-core-production-rebuild-0bd7`  
**Rule:** One authoritative production implementation. Legacy must not own ports, DBs, systemd, or be imported by production Node runtime.

## Classification legend

| Label | Meaning |
|-------|---------|
| KEEP | Production path — extend in place |
| REWRITE | Wrong shape; replace while preserving behavior |
| MIGRATE | Move into clean tree / wire into runtime |
| LEGACY | Freeze; optional `legacy-review/` |
| DELETE | Empty or harmful duplicate |

---

## A. Top-level

| Path | Class | Notes |
|------|-------|-------|
| `SERVER/` | KEEP | Authoritative brain |
| `SERVER/control-api/` | KEEP | Fastify Control API + money path (`vs-core`) |
| `SERVER/client-api/` | KEEP | New separate Client API boundary |
| `SERVER/core/` | KEEP | Canonical engines (market, indicators, regime, …) |
| `SERVER/database/` | KEEP | Canonical migrations (control-api symlink) |
| `SERVER/install/` | KEEP | Installer + healthcheck + backup/restore |
| `SERVER/wireguard/` | KEEP | Scripts/templates/enrollment layout |
| `SERVER/systemd/` | KEEP | Unit templates |
| `SERVER/dashboard/` | KEEP | Local monitor launcher |
| `SERVER/{market-data,indicators,…}-engine` shims | MIGRATE | Compatibility re-exports → `SERVER/core/*` |
| `ADMIN/` | KEEP | MSI Control Panel only |
| `CLIENT/` | MIGRATE | Installers + VERIFY; full desktop app still PARTIAL |
| `SHARED/` | KEEP | contracts/types |
| `TESTS/` | KEEP | Cross-cutting vitest |
| `DOCS/` | KEEP | Canonical docs |
| `docs/` | LEGACY | Historical lowercase docs — do not expand |
| `apps/control-api` | KEEP | Symlink → `SERVER/control-api` |
| `apps/dashboard` | KEEP | ADMIN/CLIENT web UI until native packs complete |
| `libs/` | LEGACY | C++ Market Reader stack — **not** imported by Node boot |
| `legacy-review/` | LEGACY | Frozen apps + windows-native binaries |
| `tests/` (lowercase) | LEGACY | C++ tests |
| `DEPLOY/` | DELETE | Empty; real deploy is `SERVER/deploy` |
| `cmake/`, `CMakeLists.txt`, `vcpkg.json` | LEGACY | Builds frozen C++ only |
| `tools/` | LEGACY | Ancillary Go/tools — not vs-server boot |

---

## B. Production runtime (KEEP)

| Component | Location |
|-----------|----------|
| Appliance boot | `SERVER/deploy/boot.sh`, systemd `vs-server` |
| Control API | `SERVER/control-api` |
| Client API package | `SERVER/client-api` |
| Core engines | `SERVER/core/*` |
| Migrations | `SERVER/database/migrations` (001–013) |
| WireGuard ops | `SERVER/network/*` + `SERVER/wireguard/scripts` |
| i3 monitor | `SERVER/MONITOR_SERVER`, `/api/v1/server/monitor` |
| ADMIN | `ADMIN/*`, `apps/dashboard` |
| LIVE fail-closed | `LIVE_TRADING_ENABLED=false` default |

---

## C. What was migrated this rebuild

| From | To |
|------|----|
| `SERVER/market-data` | `SERVER/core/market-data` (+ shim) |
| `SERVER/indicators` | `SERVER/core/indicators` (+ shim) |
| `SERVER/regime-engine` | `SERVER/core/regime` (+ shim) |
| `SERVER/strategy-engine` | `SERVER/core/strategy` (+ shim) |
| `SERVER/signal-engine` | `SERVER/core/signal` (+ shim) |
| `SERVER/risk-engine` | `SERVER/core/risk` (+ shim) |
| `SERVER/execution-engine` | `SERVER/core/execution` (+ shim) |
| `SERVER/supervisor` | `SERVER/core/supervisor` (+ shim) |
| `SERVER/broker-gateway` | `SERVER/core/broker` (+ shim) |
| `control-api/.../migrations` | `SERVER/database/migrations` (symlink) |

Useful algorithms retained (Node): riskCore, orderStateMachine, Capital HTTP adapter, enrollment, monitor — remain in `control-api/src/vs-core` and are being consumed alongside `SERVER/core`.

C++ `libs/*` regime/market/execution: **not migrated** into Node; documented as historical. Do not dual-boot.

---

## D. Forbidden production behaviors

- No `Math.random` market prices
- No silent LIVE → DEMO broker fallback
- No fake READY / CONNECTED / P/L
- No strategy → broker direct path
- No ADMIN/CLIENT trading engines
- Legacy must not register systemd or bind :3000

---

## E. Secrets (never commit)

- `/var/lib/vs-server/server.env`
- WireGuard private keys under network data
- Capital credentials on i3 only
