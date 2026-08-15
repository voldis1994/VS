# PR #51 — FINAL PRODUCTION CALL-PATH AUDIT

**HEAD:** (filled at commit time)  
**Branch:** `cursor/vs-core-remove-artificial-blockers-0bd7`

## Call graph (production)

```
MARKET DATA → NORMALIZATION → DATA QUALITY → FEED (PRIMARY/REFERENCE)
→ MARKET STATE → FEATURES/REGIME → SETUP/EVIDENCE → STRATEGY (BUY|SELL|NO_SETUP)
→ TRADE INTENT → TECHNICAL SAFETY (Risk) → EXECUTION → ORDER SM
→ CAPITAL ADAPTER → BROKER
```

On timeout: `SUBMITTING → BROKER_RESULT_UNRESOLVED → reconcile → resolve` (no blind resubmit).

## Blocker classification summary

| Finding | Class | Action |
|---------|-------|--------|
| robotDesk 20s post-close cooldown | ARTIFICIAL | REMOVED (prior commit) |
| riskCore `in_cooldown` / `RISK_REJECTED_COOLDOWN` | ARTIFICIAL | REMOVED (ignored no-op) |
| daily loss / max trades / consecutive loss / profit target / arbitrary risk% | ARTIFICIAL | never gated; ignored if passed |
| WAIT_* as live DecisionCodes | ARTIFICIAL / DEAD | REMOVED from DecisionCodes; compat-only `decisionCompat.ts` |
| NO_SETUP / fade / countertrend / late move / bar forming | STRATEGY_RULE | emit `NO_SETUP` |
| duplicate / invalid lot / stale-offline PRIMARY / session / reconcile / no-stop | TECHNICAL_SAFETY | KEEP |
| Capital 429 session cooldown | TECHNICAL_SAFETY | KEEP (broker rate limit) |
| UNKNOWN as strategy decision | FORBIDDEN | not emitted |

## Decision model

- BUY / SELL (ENTER_*) → intent → safety → execution  
- NO_SETUP → continue next market event (no timer)  
- BLOCKED_TECHNICAL + precise risk/error code  
- BROKER_RESULT_UNRESOLVED for ambiguous broker timeout (not Strategy UNKNOWN)

## Readiness

STRATEGY / RISK / EXECUTION use `runtimeHealth.ts` probes (evaluate path + OSM).  
Execution without known broker dependency → WARNING `BROKER_DEPENDENCY_UNKNOWN`, not fake OK.

## /api/v1

Inventory + tests in `mobileApiV1.security.test.ts`.  
Bearer required on protected routes; admin `x-admin-token`; Client A→B denied; broker/order always 403 after auth.

## Evidence commands

```bash
cd apps/control-api && npm test && npm run vs-core:verify
```
