# Multi-Account

Market Reader separates **clients**, **broker connections**, **accounts**, and **per-instrument trading settings** so one intelligence signal can fan out to many execution venues safely.

## Client model

Postgres schema (`001_initial_schema.sql`):

```
clients
  └── broker_connections (broker_name, environment, identifier)
        ├── api_credential_metadata (encrypted secrets)
        └── broker_accounts
              └── account_instrument_settings
                    (instrument_id, symbol, lot_size, enabled, trading_enabled)
```

- **Client** — logical customer/entity (`name`, `enabled`). Soft-delete disables the client.  
- **Broker connection** — Capital.com / paper / etc., demo or live.  
- **Broker account** — external account under a connection.  
- **Instrument settings** — lot size and trading switches **per account × instrument**. Trading defaults to **off** until explicitly enabled.

## Routing

`ExecutionRouter` consumes flat `AccountConfig` rows derived from enabled settings:

1. Intent must be `EntryReady` for instrument **I**.  
2. For each account where `enabled && trading_enabled && instrument == I`: emit an `ExecutionRequest`.  
3. Skip duplicates for the same intent×account.  
4. Adapter for that account executes with that account’s `lot_size`.  

One TradeIntent → N independent fills. Failures on one account do not cancel others at the router layer (per-request success flag).

## Control API surface

| Endpoint | Role |
|----------|------|
| `GET/POST/PUT/DELETE /api/clients` | Client CRUD (delete = disable) |
| `GET /api/clients/:id` | Client + nested accounts |
| `GET/POST/DELETE /api/brokers` | Broker connections + encrypted credentials |
| `POST /api/brokers/:id/test` | Connectivity smoke test |
| `GET/PUT /api/accounts/:id/instruments/...` | Lot size / trading enablement |
| `GET /api/positions` | Open positions joined to client/account names |

## Dashboard

- **Clients** — create/toggle clients  
- **Brokers** — attach Capital.com (or paper) credentials (masked display)  
- **Positions / Trades** — filterable by client context  

## Safety defaults

- `trading_enabled` false until operator enables an instrument on an account  
- LIVE mode requires `LIVE_TRADING_ENABLED=true`  
- Credentials never returned in plaintext from broker GET endpoints (masked metadata only)
