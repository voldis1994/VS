# Client Panel — Pipeline Integration Fix

## CURRENT FLOW (broken for Client Panel)

```
Client Panel START
  → startClientRobot()
  → startRobotSession()   [robotDesk.ts]
  → robotCycle() invents BUY/SELL
       • first flat cycle → always BUY
       • else mid Δ threshold → BUY/SELL
  → createCapitalPosition()
```

This is a **parallel simplified brain**, not Market Reader → EntryEngine → TradeIntent → ExecutionRouter.

Real C++ path (exists, **not live-wired to Capital**):

```
market-core MarketCorePipeline::process_event
  → SetupEngine → EvidenceEngine → EntryEngine::evaluate
  → TradeIntent (EntryReady) in pending_intents_
  ✗ never published to DB / execution-service / Capital
```

Designed routing (`docs/MULTI_ACCOUNT.md`, `ExecutionRouter::route`):

```
TradeIntent(EntryReady, instrument I)
  → accounts where enabled && trading_enabled && instrument==I
  → each fill uses account.lot_size
```

## TARGET FLOW

```
Client Panel: MARKET + LOT + START
  → activate subscription only
       • clients.panel_* persisted
       • account_instrument_settings.trading_enabled=true, lot_size=N
       • runtime registry: client RUNNING on epic
  → NO robotDesk entry strategy

Central intent ingest (pipeline / admin / future market-core publisher)
  → TradeIntent EntryReady for epic X
  → intentFanout.executeIntent(X, BUY|SELL, …)
       → only RUNNING subscriptions on X
       → each client’s broker account + own lot_size
       → Capital createPosition
       → trade_opened WS **only if broker confirms**
       → optional manage-only robot (exits only; no entry brain)

Client STOP
  → trading_enabled=false, unregister, stop manage sessions
```

### Decision source
- **Canonical:** `EntryEngine::evaluate` → `TradeIntent` (`libs/entry-engine`)
- **Live bridge (this fix):** control-api `intentFanout` consumes ingested EntryReady intents (DB + `POST /api/pipeline/intents`). Does **not** invent mid-threshold entries.
- market-core → control-api publisher remains a follow-up; until intents arrive, Client stays **RUNNING / WAITING FOR TRADE** (honest).

### Lot-size injection
`account_instrument_settings.lot_size` / subscription registry → `createCapitalPosition({ size: lot })` at fan-out (not in EntryEngine).

### Trade type
Show **BUY / SELL** only unless intent carries real `setup_type` / classification from pipeline.
