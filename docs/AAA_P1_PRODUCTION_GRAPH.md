# VS AAA — P1 PRODUCTION RUNTIME GRAPH

Status: **declared production path** (code-path audit of current `main`).
Not a claim that Capital DEMO E2E has passed.

## SINGLE PRODUCTION DECISION ENGINE

**Node `robotDesk` (`apps/control-api/src/services/robotDesk.ts`)** is the only LIVE entry brain when `entry_enabled: true`.

C++ `market-core` / `execution-service`:

* launcher may start `market-core` only with real `PIPELINE_TOKEN`;
* `execution-service` is explicitly **not** started (paper one-shot);
* Node path does **not** require PIPELINE_TOKEN.

### Production graph (LIVE)

```
VS.exe (launcher)
  → Docker PG/Redis
  → GitHub ZIP source (if SHA differs)
  → control-api (:3000) + dashboard/client
  → POST /api/robot-desk/start  (entry_enabled=true)
  → setInterval(robotCycle, ~2s)

robotCycle:
  acquireCapitalSession
  → fetchCapitalMarketQuote(epic)          # Capital REST snapshot
  → marketAllowsTrading(marketStatus)      # TRADEABLE|OPEN only
  → readMultiFeedPrice(epic, anchorMid)    # Capital-anchored fusion
  → updateTenSecondOhlc                    # 10s bars
  → applyRobotRegime / observeClosedBars   # 14 regimes
  → listCapitalOpenPositions               # broker truth
  → [if open] decideBestOutcomeExit → closeCapitalPosition
  → [if flat + entry_enabled + just_closed]
       resolveTrendBias / effectiveBias
       → decideEntryFrom10sRegime
       → isLateMoveOnOneMinute (skip)
       → detectStaleQuoteAdverse (skip)
       → denyWithTrendEntry (skip)
       → enterTrade
            → createCapitalPosition (+ SL 0.20% of price)
            → confirmCapitalDeal / listCapitalOpenPositions
```

### Functions actually invoked (entry path)

| Step | Function | File |
| --- | --- | --- |
| Session | `acquireCapitalSession` | `capitalCom.ts` |
| Quote | `fetchCapitalMarketQuote` | `capitalCom.ts` |
| Market gate | `marketAllowsTrading` | `robotDesk.ts` |
| Feeds | `readMultiFeedPrice`, `pickOhlcMid` | `robotReader.ts` |
| Public legs | (inside reader) public internet feeds | `publicInternetFeeds.ts` |
| OHLC | `updateTenSecondOhlc`, `isMoving10s` | `tenSecondOhlc.ts` |
| Regime | `observeClosedBars`, `classifyRegime` | `regimes.ts` |
| Bias | `resolveTrendBias`, `effectiveBias` | `entryFromRegime.ts` |
| Setup | `decideEntryFrom10sRegime` | `entryFromRegime.ts` |
| Lag guard | `detectStaleQuoteAdverse` | `staleQuoteGuard.ts` |
| Risk-ish | `denyWithTrendEntry`, one-trade `listCapitalOpenPositions` | entry + desk |
| Exec | `createCapitalPosition` | `capitalCom.ts` |
| Manage | `decideBestOutcomeExit` | `exitManage.ts` |

### Competing / non-production paths (do not use for LIVE decisions)

| Path | Role | Production? |
| --- | --- | --- |
| C++ `market-core` bridge | optional PIPELINE fan-in | NO (unless token + explicit) |
| C++ `execution-service` | paper demo | NO |
| `intentFanout` alone without robotDesk entry | pipeline manage | manage-only when entry_enabled=false |
| Browser/Vite UI | display/control | NOT the decision engine |

## OLD vs NEW (intent)

| OLD (ambiguous) | NEW (required) |
| --- | --- |
| Multiple brains (C++ / Node / UI) | One: Node `robotDesk` |
| WAIT without reason | WAIT_* / ERROR_* codes (see `decisionCodes.ts`) |
| Fake LIVE labels | Status only from Capital session + quote age |

## Gaps still OPEN (honest)

* No atomic `client_order_id` lifecycle store yet
* No dedicated RiskEngine module (checks are inline)
* No crash reconciliation on startup beyond broker list in-cycle
* Desktop is still launcher + browser, not AAA native shell
* Capital DEMO acceptance test not automated in CI
