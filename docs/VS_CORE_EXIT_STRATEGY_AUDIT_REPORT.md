# VS CORE — EXIT STRATEGY JOINT AUDIT REPORT

**Repository:** voldis1994/VS  
**Working PR:** [#52](https://github.com/voldis1994/VS/pull/52)  
**Starting HEAD:** `c5048cac7d04f617a8ba0ba711042418b4e92d86`  
**Final HEAD:** `71f2a4cf30a7fd3457e400b45f303dbad0959bde`

## 1. Starting HEAD

`c5048cac7d04f617a8ba0ba711042418b4e92d86` — Strategy regime-context complete; Exit audit started from this tip.

## 2. Final HEAD

`71f2a4cf30a7fd3457e400b45f303dbad0959bde`

## 3. Exit architecture discovered

Authoritative live path (single desk orchestrator — no second brain):

```
market data → regime observe → Strategy (FLAT only)
→ setup/entry → risk → durable order → broker confirm → POSITION_OPEN
→ updateExcursion → decideBestOutcomeExit → exitTrade
→ closeCapitalPosition → broker flat confirm → POSITION_CLOSED → clearTradeState
```

| Transition | File / function |
|------------|-----------------|
| Regime observe | `robotDesk.applyRobotRegime` → `regimes.observeClosedBars` |
| Strategy entry | `strategyCore.evaluateStrategy` |
| Risk / order | `moneyPathRisk` / `riskCore` / `executionCore.executeTradeIntent` |
| POSITION_OPEN | confirm path in `executionCore` + `robotDesk.enterTrade` |
| Exit decision | `exitManage.decideBestOutcomeExit` |
| Broker close | `robotDesk.exitTrade` → `capitalCom.closeCapitalPosition` |
| Close finalize | `exitLifecycle.decideCloseFinalize` |
| POSITION_CLOSED | `durableOrderStore.markPositionClosed` after flat |

## 4. Strategy → Exit contract

Immutable fields now persisted at open:

| Field | Purpose |
|-------|---------|
| `entry_setup` | Strategy setup family |
| `entry_regime` | Regime at entry |
| `entry_reason` | Strategy reason (audit) |
| `open_side` / `entry_price` / `entry_at` | Position identity |
| `mfe` / `mae` / `peak_retention` | Runtime excursion |

Live `regime` continues to update for manage context — it is **not** re-used as entry permission.

## 5. Authority-boundary findings

- Exit never calls `evaluateStrategy` / setup qualification / late-move entry gates.
- **Defect:** `thesisFailureReason` exited on opposite **live** regime for every open side — including FADE / REVERSAL / FAILED_BREAKOUT — contradicting Strategy regime-as-context.
- **Fix:** ThesisFailure only when `entry_setup` ∈ {PULLBACK, CONTINUATION, BREAKOUT}. Countertrend setups and missing setup → no ThesisFailure.

## 6. Bugs discovered

1. ThesisFailure = hidden entry-permission re-gate on open positions.
2. `setup_type` dropped after entry / manage-attach (no Exit contract).
3. HTTP close OK immediately cleared local state; durable ledger never reached `POSITION_CLOSED`.
4. No explicit close-pending / in-flight duplicate-close latch.

## 7. Exact fixes made

- Persist entry_setup / entry_regime / entry_reason; clear on flat.
- Scope ThesisFailure to with-trend setups.
- Add `exitLifecycle` finalize rules; require broker flat before POSITION_CLOSED.
- `exitTrade`: close_in_flight + close_pending; no optimistic clear.
- `DurableOrderStore.markPositionClosed`.
- Injectable `nowMs` for TimeDecay determinism.

## 8. Exit reasons and precedence

1. ThesisFailure (with-trend + opposite live regime only)  
2. GaveBackPlus  
3. PeakProtection  
4. BestOutcome harvest  
5. Target  
6. HardInvalidation  
7. TimeDecay (90s / 180s)  

Broker safety SL remains last-resort outside this function. External broker-flat sync also finalizes POSITION_CLOSED.

## 9. LONG/SHORT verification

PASS — favorableMove + hard-stop / target / thesis / gave-back / peak for BUY and SELL (tests A–G + symmetry suite).

## 10. Look-ahead verification

PASS — Exit uses only snapshot + mid + injectable nowMs (test J). No future bars inside Exit.

## 11. Position-state / idempotency verification

PASS — tests K, L, M, N, O (no position / in-flight / pending / reject / retry / external flat / idempotent markPositionClosed).

## 12. Broker-confirmation verification

PASS — HTTP OK alone → CLOSE_PENDING; flat list required for FINALIZE_CLOSED (test O).

## 13. A–P test matrix results

**18/18 PASS** in `exitManage.test.ts` (matrix A–P + LONG/SHORT helpers).

## 14. Strategy regression result

- `entryFromRegime` + `regimeContextStrategy` + `noArtificialBlockers`: **47/47 PASS**
- `STRATEGY_REGRESSION` gate: **7/7 PASS**
- Strategy architecture unchanged (no redesign)

## 15. control-api result

**255/255 PASS** (was 247; +8 Exit matrix coverage)

## 16. vs-core:verify result

**PASS=24 FAIL=0 EXTERNAL_BLOCKER=3**

## 17. build/typecheck result

`tsc --noEmit`: exit 2 — **pre-existing** `moneyPathRisk.ts:122` OFFLINE/MISSING comparisons (same pattern at starting HEAD). Not introduced by Exit work. Left alone.

## 18. Exact files changed

- `SERVER/control-api/src/services/exitManage.ts`
- `SERVER/control-api/src/services/exitLifecycle.ts` *(new)*
- `SERVER/control-api/src/services/exitManage.test.ts`
- `SERVER/control-api/src/services/robotDesk.ts`
- `SERVER/control-api/src/vs-core/durableOrderStore.ts`
- `docs/VS_CORE_EXIT_STRATEGY_AUDIT_REPORT.md`

## 19. Remaining EXTERNAL_BLOCKER items

- `HISTORICAL_BASELINE`
- `CAPITAL_REAL_DEMO`
- `PHYSICAL_i3` / physical WireGuard install

## 20. Remaining software blockers

- Exit UPL still uses mid (not side bid/ask) — documented, not changed
- TimeDecay thresholds unchanged (existing product behavior)
- LIVE trading remains off; **PR #52 not merged**
