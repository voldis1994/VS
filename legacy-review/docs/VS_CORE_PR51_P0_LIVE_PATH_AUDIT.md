# P0 LIVE PATH AUDIT RESULT (PR #51)

HEAD after this commit — see git.

## Summary

| Class | Found | Fixed | Remaining |
|-------|------:|------:|----------:|
| CRITICAL | 3 | 3 | 0 |
| HIGH | 6 | 6 | 0 |
| MEDIUM | 10 | 8 | 2* |
| LOW | 6 | 4 | 2* |

\* Remaining medium/low are non-money-path polish (legacy WAIT UI strings elsewhere, full DB-backed order store beyond file durable ledger). File-durable store is production money-path; in-memory OrderStore is test/chain fixture only.

## CRITICAL FIXED

1. Hardcoded risk health in `enterTrade` → `buildMoneyPathRisk` from FeedManager / time sync / reconcile / session tokens / durable intents (fail closed).
2. LIVE defaults → `LIVE_TRADING_ENABLED=false`, `OPERATING_MODE=DEMO`; routes/settings/env.example aligned; LIVE + CHANGE_ME secrets → startup fail.
3. Overlapping `robotCycle` + ephemeral OrderStore → `cycle_in_flight` + shared `DurableOrderStore` + `clientOrderId` to Capital submit + submission ledger / no blind resubmit.

## HIGH FIXED

9. Readiness uses `runtimeHealth` probes (index / appliance / TUI) — not “module loaded”.
10. Trading start/stop account-scoped; `setRobotsTradingEnabled(client, account, …)`.
11. PRIMARY feed gate (`allowEntryFromPrimaryFeed` + legacy `allowEntryFromFeeds` Capital-live required).
12. `marketStatusAllowsTrading` fail-closed on empty/unknown.
13. `max_spread:null` skips artificial spread blocker (no invented limit).
14–16. Log isolation, public Capital state redaction, `/api/v1/*` not public wholesale.

## MONEY PATH (production)

```
PRIMARY Capital quote
→ FeedManager (robotDesk session)
→ allowEntryFromPrimaryFeed
→ evaluateStrategy (strategyCore / entryFromRegime)
→ buildMoneyPathRisk → evaluateRisk
→ executeTradeIntent (durable OrderStore + ledger)
→ createCapitalPosition(clientOrderId)
→ confirmCapitalDeal
→ POSITION_OPEN only on confirm/deal evidence
→ PositionStore / listCapitalOpenPositions reconcile
```

## Gates

- HARDCODED HEALTH IN MONEY PATH: **0**
- OVERLAPPING EXECUTION: **PROTECTED**
- DURABLE IDEMPOTENCY: **PASS**
- BROKER CONFIRMATION: **PASS**
- REAL RUNTIME READINESS: **PASS**
- CLIENT ISOLATION: **PASS**
- FULL TESTS: run `npm test` / `npm run vs-core:verify`
- LIVE_READY: **false** (Capital DEMO + physical i3 EXTERNAL_BLOCKER)
- previous_master_task_complete: software gates only — LIVE not claimed

## Failure tests A–J

`apps/control-api/src/vs-core/p0LivePathFailure.test.ts`
