# Implementation report — clean production architecture

**Branch:** `cursor/vs-core-production-rebuild-0bd7`  
**LIVE_TRADING_ENABLED default:** false  

| Subsystem | State | Source |
|-----------|-------|--------|
| Legacy audit | IMPLEMENTED | `DOCS/LEGACY_AUDIT.md` |
| Clean tree `SERVER/core/*` | IMPLEMENTED | engines relocated + shims |
| Database migrations | IMPLEMENTED | `SERVER/database/migrations` (001–013) |
| Redis | PARTIAL | Docker + probes; not sole authority |
| Supervisor PROCESS/SYSTEM/TRADING | PARTIAL | `SERVER/core/supervisor` + Control API |
| Control API | IMPLEMENTED | `SERVER/control-api` |
| Client API (separate package) | PARTIAL | `SERVER/client-api` auth boundary + routes; session store wiring PARTIAL |
| Market data | IMPLEMENTED | `SERVER/core/market-data` |
| Indicators | IMPLEMENTED | `SERVER/core/indicators` |
| Regime | IMPLEMENTED | `SERVER/core/regime` |
| Strategy | IMPLEMENTED | `SERVER/core/strategy` |
| Signal | IMPLEMENTED | `SERVER/core/signal` |
| Risk + kill switch | IMPLEMENTED | `riskCore` + `SERVER/core/risk` + killSwitch API |
| Execution OSM | IMPLEMENTED | `SERVER/core/execution` |
| Broker gateway | PARTIAL | Capital health/canonical/probes; full session lifecycle in control-api services |
| Positions | PARTIAL | `SERVER/core/positions` façade + existing control-api services |
| Reconciliation | PARTIAL | `SERVER/core/reconciliation` + gates |
| Incidents / audit | PARTIAL | core helpers + existing vs_incidents/audit |
| WireGuard | PARTIAL | network scripts + docs |
| i3 monitor | IMPLEMENTED | MONITOR_SERVER + API |
| ADMIN MSI | PARTIAL | bats + dashboard; real API wired |
| CLIENT app | PARTIAL | installers/VERIFY; desktop packaging incomplete |
| Backup/restore/update | IMPLEMENTED | install scripts |
| Installers | PARTIAL | INSTALL_SERVER + ADMIN/CLIENT windows |
| Systemd templates | PARTIAL | `SERVER/systemd/*` (+ deploy units) |
| Docs | IMPLEMENTED | required DOCS/* set |
| Fake production state | NOT PRESENT | fail-closed / CONFIG_REQUIRED |

**Not DONE** for physical topology. No silent DEMO fallback. No invented READY.
