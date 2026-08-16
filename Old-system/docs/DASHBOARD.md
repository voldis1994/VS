# Dashboard

React + Vite app (`apps/dashboard`). Dev URL: http://localhost:5173. Talks to Control API (`VITE_API_URL`) and WebSocket (`VITE_WS_URL` / `/ws` via API).

## Navigation

Sidebar layout (`Layout.tsx`) with operating-mode badge from `/api/system/status`.

| Route | Page | Purpose |
|-------|------|---------|
| `/` | Overview | Mode, market-core/execution/DB health, feed counts, open positions, today’s executions |
| `/market` | Market Reader | Per-instrument table: regime, setup, evidence, direction, probability, edge, quality, consensus, entry state |
| `/evidence/:instrumentId?` | Live Evidence | Setup lifecycle, strength, supporting/contradicting lists, active trade intent JSON |
| `/positions` | Positions | Open positions: client, account, side, entry, qty, MFE/MAE, peak retention |
| `/clients` | Clients | Create clients; enable/disable |
| `/brokers` | Brokers | Add Capital.com/paper connections with credentials; test connection; masked secrets |
| `/trades` | Trades | Closed/recorded trades: entry/exit, PnL, regime |
| `/feeds` | Feeds | Source health: latency, jitter, stale rate, divergence, reliability, predictive score |
| `/system` | System | Process health grid + settings JSON |
| `/logs` | Logs | Audit log stream (actor, action, entity) |
| `/settings` | Settings | Operating mode switch (confirm before apply); live gate aware |

## Live updates

`useWebSocket` connects on app load. Market and status pages also poll via `useApi` intervals (typically 3s) so the UI stays current if WS is down.

## Operator workflow (typical)

1. Overview — confirm PAPER/DEMO and healthy components  
2. Feeds — verify latency/stale rates  
3. Market Reader / Evidence — watch setups forming  
4. Clients → Brokers → instrument trading enablement  
5. Positions / Trades — monitor fills and exits  
6. Logs / Settings — audit changes; switch mode only with confirmation  

LIVE mode should only be selected after credentials, lot sizes, and `LIVE_TRADING_ENABLED` are verified.
