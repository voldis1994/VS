# Control API

Fastify service (`apps/control-api`), default `http://0.0.0.0:3000`. Auth: `x-admin-token` (see [SECURITY.md](SECURITY.md)). WebSocket at `/ws` for telemetry.

## System

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness `{ status: "ok" }` |
| GET | `/api/system/status` | Component health, mode, feed counts, latency metrics |
| GET | `/api/system/mode` | Current mode + `live_enabled` |
| POST | `/api/system/mode` | Body `{ mode }`; LIVE blocked unless env allows |
| GET | `/api/system/metrics` | Latest telemetry metrics |
| GET | `/api/system/events` | Recent `system_events` (limit 100) |

## Clients

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/clients` | List clients |
| GET | `/api/clients/:id` | Client + accounts |
| POST | `/api/clients` | `{ name }` |
| PUT | `/api/clients/:id` | `{ name?, enabled? }` |
| DELETE | `/api/clients/:id` | Soft-disable |

## Brokers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/brokers` | Connections joined to client name |
| GET | `/api/brokers/:id` | Connection + masked credential metadata |
| POST | `/api/brokers` | `{ client_id, broker_name, environment, identifier?, api_key?, password? }` |
| POST | `/api/brokers/:id/test` | Connection test stub |
| DELETE | `/api/brokers/:id` | Soft-disable |

## Accounts / positions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/accounts/:id/instruments` | Instrument settings |
| PUT | `/api/accounts/:id/instruments/:instrumentId` | Upsert lot size / enable / trading_enabled |
| GET | `/api/positions` | Open positions with client/account names |

## Trades / intents

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/trades` | Query: `client_id`, `instrument_id`, `direction`, `limit` |
| GET | `/api/trades/:id` | Trade + linked intent/evidence |
| GET | `/api/intents` | Recent trade intents |

## Market / feeds

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/market/instruments` | Instrument market-reader summary |
| GET | `/api/market/instruments/:id` | Detail + nested market_state |
| GET | `/api/market/evidence/:instrumentId` | Setup lifecycle + evidence lists |
| GET | `/api/feeds` | Feed health (latency, stale rate, divergence, …) |

## Audit / settings

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/audit` | Query: `action`, `limit` |
| GET | `/api/settings` | Mode, horizon, TTL, log level |
| PUT | `/api/settings` | `{ log_level? }` |

## WebSocket

`GET /ws` (WebSocket upgrade). Broadcast types include `heartbeat` (~5s) and `market_update` (~2s). CORS origin defaults to `http://localhost:5173`.
