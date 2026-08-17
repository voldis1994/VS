# Execution

Execution spans `ExecutionRouter`, broker adapters, and `apps/execution-service`.

## ExecutionRouter

`libs/execution-router` fans a single `TradeIntent` to eligible accounts.

### AccountConfig

- `client_id`, `account_id`, `instrument`  
- `lot_size` (default 0.01)  
- `enabled`, `trading_enabled`  

### Routing rules

`route(intent, accounts)` returns `ExecutionRequest`s only when:

1. Intent decision is `EntryReady`  
2. Account is enabled **and** trading_enabled  
3. Account instrument matches intent  
4. Intent×account is not already recorded as executed (`is_duplicate`)  

Duplicate key: `(intent_id << 32) | account_id`. Successful fills call `record_execution`.

### ExecutionResult

`id`, `intent_id`, `client_id`, `account_id`, `success`, `fill_price`, `quantity`, `error_message`, `executed_at`.

## Broker adapters

`IBrokerAdapter` (`libs/broker-adapters`) capability matrix includes market/limit orders, SL/TP, trailing stop, partial close, modify, WS quotes/trades.

| Method | Purpose |
|--------|---------|
| `connect` / `disconnect` / `is_connected` / `health` | Session |
| `authenticate` | API key, password, identifier |
| `account_info`, `quote`, `positions` | Account state |
| `create_position`, `close_position` | Orders |

### PaperBrokerAdapter

In-process simulator: set quotes, market fills, tracks open positions. Used by PAPER mode and unit tests.

### CapitalComAdapter

REST adapter for Capital.com (`https://open-api.capital.com/`). Base URLs for demo/live in `config/brokers.yaml`. Epic mapping via `set_epic_mapping`. Capabilities that are unsupported (e.g. trailing stop, WS quotes per config) are explicit in broker YAML.

## execution-service flow

1. Construct router, position manager, exit engine.  
2. Register broker map (`AccountId` → adapter); paper broker connected with seed quote.  
3. Route intent → for each request build `BrokerOrderRequest` (market, lot size, SL/TP).  
4. `create_position` → `ExecutionResult` → `record_execution`.  
5. On success, `open_position` then evaluate position + exit engines.  

Mode flag: `--mode PAPER|DEMO|LIVE` (LIVE gated by environment in market-core; live scripts use release binaries).

## Persistence

Control-api tables `executions`, `positions`, `trades` store routed outcomes for the dashboard and audit trail.
