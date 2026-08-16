# VS CORE — Blocker classification (post artificial-limit removal)

Search terms: WAIT, UNKNOWN, DAILY_LOSS, MAX_TRADES, TRADE_LIMIT, COOLDOWN, RISK_PERCENT, LOSS_LIMIT, PROFIT_TARGET, CONSECUTIVE_LOSS

| Location | Condition | Class | Action |
|----------|-----------|-------|--------|
| `riskCore.ts` `in_cooldown` | artificial entry cooldown | OBSOLETE/ARTIFICIAL | **REMOVED** (ignored no-op) |
| `robotDesk.ts` 20s post-close | artificial cooldown | OBSOLETE/ARTIFICIAL | **REMOVED** |
| `strategyCore.ts` `in_cooldown` | artificial | OBSOLETE/ARTIFICIAL | **REMOVED** |
| daily loss / max trades / consecutive loss / profit target / arbitrary risk% | not in proven strategy | OBSOLETE/ARTIFICIAL | **never implemented as gates**; Risk ignores if passed |
| `NO_SETUP` / former WAIT_NO_SETUP, BAR_FORMING, NO_FADE, COUNTERTREND, LATE_MOVE | no trade intent | STRATEGY RULE | emit **NO_SETUP** (not WAIT mode) |
| duplicate intent / open position | safety | TECHNICAL SAFETY | keep |
| invalid / out-of-range lot | safety | TECHNICAL SAFETY | keep |
| stale/offline PRIMARY feed | safety | TECHNICAL SAFETY | keep → BLOCKED_TECHNICAL / RISK_REJECTED_* |
| broker session unhealthy | safety | TECHNICAL SAFETY | keep |
| reconcile dirty / unresolved submit | safety | TECHNICAL SAFETY | keep |
| missing stop | safety | TECHNICAL SAFETY | keep |
| client STOP / trading off | permission | TECHNICAL SAFETY | keep → BLOCKED_TECHNICAL |
| Capital 429 session cooldown (`capitalCom.ts`) | broker rate limit | TECHNICAL SAFETY | keep (not a strategy limit) |
| UNKNOWN decision | forbidden | OBSOLETE | never emit |

Decision model: BUY/SELL intent · NO_SETUP · BLOCKED_TECHNICAL+code.
