# Client Control Panel — Final Integration Flow

## CURRENT REAL FLOW (after bridge)

Proven production path (not assumptions):

1. **Market data** — `apps/market-core/src/main.cpp` `run_live_bridge()`  
   - GET `/api/pipeline/subscribed-epics` (clients with `panel_robot_requested=RUNNING`)  
   - Capital.com quotes via `CapitalComAdapter::quote`  
   - `MarketCorePipeline::process_event`

2. **Decision** — `MarketCorePipeline::process_event` → `EntryEngine::evaluate`  
   - may produce `EntryDecision::EntryReady` → `pending_intents_`

3. **Intent leave market-core** — `drain_pending_intents()` → HTTP  
   `POST /api/pipeline/intents` with `x-pipeline-token` + `idempotency_key`

4. **control-api** — `routes/pipeline.ts` → `fanoutEntryIntent` / `ingestAndExecuteIntent`  
   → `executePipelineIntent` → `listActiveSubscriptionsForEpic`

5. **Per client** — ownership check → `createCapitalPosition(session, { epic, direction, size: lot })`  
   → on success: persist + `emitToClient(..., trade_opened)`  
   → on failure: `emitToClient(..., error)` — **no** `trade_opened`

6. **Client START** — `startClientRobot` → `activateSubscription`  
   - requested = RUNNING; confirmed RUNNING only when bridge heartbeat includes epic

7. **Client STOP** — `deactivateSubscription` for that client only  
   - other clients on same epic keep RUNNING; bridge keeps analyzing while any subscriber remains

---

## Operator: enable LIVE bridge

```bash
export CONTROL_API_URL=http://127.0.0.1:3000
export PIPELINE_SERVICE_TOKEN=...   # or API_ADMIN_TOKEN
export CAPITAL_API_KEY=...
export CAPITAL_API_PASSWORD=...
export CAPITAL_IDENTIFIER=...
export CAPITAL_ENVIRONMENT=demo    # or live

./market-core --mode LIVE --bridge
# or: MARKET_CORE_BRIDGE=1 ./market-core --mode LIVE
```

Without this process, Client Panel stays **STARTING** (subscription requested, Market Reader not confirmed).

---

## E2E TRACE — Client 17 / XAUUSD / 0.10 / Account XYZ

1. Client presses START → `ClientPanelPage.toggleRobot` → `POST /api/client/start`
2. `startClientRobot` (`clientPanel.ts`) validates market/lot/account
3. `activateSubscription` stores epic+lot; `panel_robot_requested=RUNNING`
4. Status may be **STARTING** until bridge heartbeat
5. `run_live_bridge` polls subscribed epics → sees XAUUSD → Capital quote → `process_event`
6. `EntryEngine::evaluate` creates EntryReady → `drain_pending_intents`
7. Transport: HTTP `POST /api/pipeline/intents` (`main.cpp` `http_json`)
8. `registerPipelineRoutes` → `fanoutEntryIntent` (`intentFanout.ts`)
9. `listActiveSubscriptionsForEpic('XAUUSD')` matches Client 17
10. Account ownership check → account XYZ (`preferred` / linked account)
11. Lot 0.10 from subscription settings
12. `createCapitalPosition` (`capitalCom.ts`)
13. Broker success (`ok: true`)
14. Position row + manage-only robot attach
15. `emitToClient(17, { type: 'trade_opened', ... })`
16. Client WS `/ws/client` → `ClientPanelPage` flash + refresh
17. LIVE TRADE UI: XAUUSD · BUY · 0.10 LOT  
    Refresh: `getClientPanelStatus` restores from Capital open positions

---

## Auth

`/api/pipeline/*` requires `x-pipeline-token` (= `PIPELINE_SERVICE_TOKEN`) or `x-admin-token`.  
Not a public Client Panel path. Keep private/internal network in production.

## Idempotency

`pipeline_intent_dedupe` table + `idempotency_key` on ingest — HTTP retry does not double-execute.
