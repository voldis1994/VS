# VS Architecture (production rebuild)

## Authority

**VS-CORE-01** (i3 Debian) is the only trading brain.

- Capital.com / broker credentials: **SERVER ONLY**
- ADMIN (MSI): Control Panel over **LAN** → Control API
- CLIENT (remote): WireGuard → Client API
- ADMIN/CLIENT never talk to Capital.com

## Process vs trading readiness

| Flag | Meaning |
|------|---------|
| `process_ready` | Config + Postgres + Control API answering |
| `trading_ready` | All live gates + operator auth (default **false**) |

`LIVE_TRADING_ENABLED` defaults to **false**. Never invent TRADING_READY.

## Status contract

Both i3 console monitor and MSI dashboard use:

`GET /api/v1/server/monitor` (admin token)

Supervisor view:

`GET /api/v1/system/supervisor`

## Module map

| Folder | Role |
|--------|------|
| `SERVER/control-api` | Runtime API + vs-core engines |
| `SERVER/supervisor` | Boot/readiness evaluation |
| `SERVER/market-data` | Tick validation (no invented prices) |
| `SERVER/indicators` | Deterministic indicators |
| `SERVER/regime-engine` | Regime classification (no auto-orders) |
| `SERVER/strategy-engine` | Eligibility only |
| `SERVER/signal-engine` | Signal ≠ order |
| `SERVER/risk-engine` | Stops / sizing |
| `SERVER/execution-engine` | Order state machine |
| `legacy-review/` | Frozen / archived — **no production imports** |

See `DOCS/LEGACY_AUDIT.md`.
