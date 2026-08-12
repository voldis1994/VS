# Client Control Panel — Audit & Plan

## STEP 1 — AUDIT

### Client → Broker Account
- Schema: `clients` → `broker_connections.client_id` → `broker_accounts.broker_connection_id`.
- Admin creates clients (`/api/clients`); Brokers page attaches Capital connections to a client.
- Trading accounts list joins client name (`/api/trading/accounts`).
- **No client access code / panel auth exists today.** Admin uses single `x-admin-token`.

### Instrument / lot source of truth
- Live catalog: `capital_markets` (per `broker_connection_id`), filled by Trading → Pull Capital markets.
- Lot constraints: `min_lot`, `max_lot`, `lot_step` on `capital_markets`.
- Account overlays: `account_instrument_settings` (lot_size, trading_enabled).
- APIs: `/api/instruments`, `/api/trading/markets`, `/api/trading/accounts/:id/instruments`.
- Legacy `/api/market/instruments` is empty/stub — **not** SoT.

### START / STOP runtime (updated)

- **Client Panel START** → activates `account_instrument_settings` subscription only (no robotDesk entry brain).
- **Pipeline intents** → `POST /api/pipeline/intents` → `intentFanout` routes to RUNNING subscribers with each account’s lot size via Capital.
- **Admin Robot Board** may still use `robotDesk` (separate path); Client Panel must not.
- See `docs/CLIENT_PANEL_PIPELINE_FIX.md`.

### Positions / trades
- Robot writes `positions` on entry/exit (best effort).
- Live truth for open trade: Capital positions + robot session (`open_side`, `entry_price`, `deal_id`).
- Presentation mapping already used in UI: BUY → BUY LONG, SELL → SELL SCALP (no separate scalp engine).

### WebSocket
- Global `/ws` → `TelemetryBroadcaster` (admin metrics/heartbeat). **Not client-scoped.**
- Client Panel needs a separate authenticated channel.

### Safest integration point
- Extend `clients` with access + panel preferences.
- New `/api/client-auth/*` + `/api/client/*` (session binds `client_id` server-side).
- START/STOP → existing `startRobotSession` / `stopRobotSession` for the client’s preferred/linked `broker_account`.
- Markets → same `capital_markets` for that account’s connection.
- Do **not** rewrite Market Reader / Entry / Execution / Exit engines.

---

## STEP 2 — IMPLEMENTATION PLAN

### Existing files to modify
| File | Why |
|------|-----|
| `apps/control-api/src/middleware/auth.ts` | Exempt client-auth/client/ws-client from admin token; keep admin boundary. |
| `apps/control-api/src/index.ts` | Register client routes, cookie/CORS origins, client WS. |
| `apps/control-api/src/services/robotDesk.ts` | Emit client-scoped events; helpers to find sessions by account/client. |
| `apps/control-api/src/routes/clients.ts` | Admin: access code generate/reset, preferred account, runtime snapshot, admin STOP. |
| `apps/control-api/package.json` | Optional cookie helper deps if needed (prefer Node crypto). |
| `apps/dashboard/src/App.tsx` | Add `/client` route outside Desk layout. |
| `apps/dashboard/src/pages/ClientsPage.tsx` | Access code + runtime + admin STOP UI. |
| `apps/dashboard/src/styles/global.css` | Mobile client panel styles. |
| `.env.example` | `CLIENT_CORS_ORIGIN`, session secrets, cookie flags. |
| `docs/ARCHITECTURE.md` | Short note pointing here (additive). |

### New files to create
| File | Why |
|------|-----|
| `apps/control-api/src/db/migrations/005_client_panel.sql` | Access hash, panel state, sessions, login attempt log. |
| `apps/control-api/src/security/accessCode.ts` | scrypt hash/verify for access codes. |
| `apps/control-api/src/security/clientSession.ts` | Token create/verify, cookie name, expiry. |
| `apps/control-api/src/services/clientPanel.ts` | Resolve account, validate lot/market, start/stop, status DTO. |
| `apps/control-api/src/services/clientEvents.ts` | Per-client WS fan-out. |
| `apps/control-api/src/routes/clientAuth.ts` | Login / logout / me (rate-limited). |
| `apps/control-api/src/routes/clientPanel.ts` | Markets, config, start, stop, status (session-scoped). |
| `apps/control-api/src/security/accessCode.test.ts` | Hashing tests. |
| `apps/control-api/src/services/clientPanel.test.ts` | Isolation, lot validation, auth boundary helpers. |
| `apps/dashboard/src/pages/ClientPanelPage.tsx` | Mobile-first LOGIN → MARKET → LOT → VS START/STOP + LIVE TRADE. |
| `apps/dashboard/src/hooks/useClientApi.ts` | Client session API helper (no admin token). |
| `apps/dashboard/src/hooks/useClientWebSocket.ts` | Client-scoped WS. |
