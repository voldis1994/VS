# Final Gap Audit

**Date:** 2026-08-16  
**Against:** FINAL PRODUCTION COMPLETION PASS  
**Method:** source inspection + unit/integration tests (agent environment has no physical i3/MSI/remote)

Legend: IMPLEMENTED | PARTIAL | MISSING | BROKEN | UNVERIFIED

## Core roles

| Requirement | Status | Evidence |
|-------------|--------|----------|
| i3 = authoritative brain | IMPLEMENTED | `SERVER/control-api`, systemd `vs-server` |
| MSI = ADMIN only | IMPLEMENTED | `ADMIN/*`, `apps/dashboard` |
| Remote CLIENT via WireGuard | PARTIAL | enrollment + WG scripts; remote ISP E2E UNVERIFIED |
| No broker on ADMIN/CLIENT | IMPLEMENTED | Capital adapter only in SERVER |
| LIVE default false | IMPLEMENTED | env + settings API refuse enable |

## Infrastructure

| Item | Status | Notes |
|------|--------|-------|
| PostgreSQL + migrations | IMPLEMENTED | 001–013 + migrate runner |
| Redis | PARTIAL | Docker + probes |
| Supervisor | PARTIAL | `SERVER/supervisor` + API |
| Control API | PARTIAL | Large surface + kill switch + broker health |
| Client API (isolated) | PARTIAL | mobile/client panel + security tests |
| WebSocket | PARTIAL | `/ws` telemetry |
| WireGuard tooling | PARTIAL | scripts + PORTS.md PUBLIC_HOST |
| Firewall | PARTIAL | APPLY_FIREWALL; physical UNVERIFIED |
| i3 monitor | IMPLEMENTED | monitor + SHOW_DASHBOARD |
| MSI dashboard | PARTIAL | wired to monitor API |
| Backup/restore | IMPLEMENTED | BACKUP/LIST/VERIFY/RESTORE scripts |
| Update workflow | PARTIAL | UPDATE_SERVER.sh operator-gated |
| Release dist/ packages | IMPLEMENTED | `scripts/BUILD_RELEASE.sh` |
| FINAL_ACCEPTANCE scripts | IMPLEMENTED | SERVER/ADMIN/CLIENT |

## Trading stack

| Item | Status | Notes |
|------|--------|-------|
| Market-data lifecycle | IMPLEMENTED | `MarketFeedBook` states + candles |
| Indicators | IMPLEMENTED | SMA/EMA/ATR/RSI/ADX/MACD/BB/Donchian/ROC/mom/vol/swings/S-R |
| All regimes + hysteresis | IMPLEMENTED | classifier full IDs |
| Strategies | IMPLEMENTED | full registry eligibility |
| Signals | IMPLEMENTED | builder + NO_TRADE records |
| Risk + kill switch | IMPLEMENTED | riskCore + API + DB |
| Stops / TP / sizing | IMPLEMENTED | ATR/structure/swing/vol + RR + size |
| Execution state machine | IMPLEMENTED | orderStateMachine |
| Capital gateway | PARTIAL | CONFIG_REQUIRED honesty + canonical types + safe probes; live session UNVERIFIED |
| Reconciliation | PARTIAL | tables + gates |
| Positions | PARTIAL | existing services |

## Tests

| Suite | Status |
|-------|--------|
| control-api vitest | IMPLEMENTED |
| ADMIN connection | IMPLEMENTED |
| TESTS/unit | IMPLEMENTED (expanded) |
| Physical i3/MSI/remote | UNVERIFIED in agent |

## External configuration required

- Capital.com credentials on i3 only
- Router UDP 51820 → VS-CORE-01 for remote clients
- `PUBLIC_HOST_OR_IP` / `WIREGUARD_PORT`
- `API_ADMIN_TOKEN` / DB secrets
- DHCP reservation for LAN admin target
