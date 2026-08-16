# Market Intelligence + Strategy + Execution Core

**Status:** Software foundation COMPLETE for the measurement → setup → protective-stop chain.  
**Live multi-feed trading on physical Capital:** NOT claimed DONE until acceptance chain on real feeds passes.

## What was implemented

| Layer | Path |
|---|---|
| Types / operational blocks | `SERVER/core/market-intelligence/src/types.ts` |
| Multi-feed validation | `.../feedValidation.ts` |
| Canonical 10s OHLC + aggregation | `.../ohlc10s.ts` |
| Market state **vector** (not FLAT/UNKNOWN) | `.../marketState.ts` |
| Setup engine PASS/FAIL | `.../setupEngine.ts` |
| Protective SL (structure/ATR; 20% ceiling only) | `.../protectiveStop.ts` |
| Lot sizing (instrument bounds) | `.../lotSizing.ts` |
| Order lifecycle OSM (spec §16) | `.../orderLifecycle.ts` |
| MFE/MAE + exit ranking | `.../exitEngine.ts` |
| Trade explanation | `.../explainability.ts` |
| Strategy module | `SERVER/core/strategies/trend_continuation/` |
| DB | `SERVER/database/migrations/014_market_intelligence.sql` |
| API | `POST /api/v1/market/feeds/validate`, `/state`, `/setup/trend_continuation` |
| Tests | `TESTS/unit/market-intelligence.test.ts` |

## Hard rules enforced in code

- No random / fake ticks
- `FEED_UNAVAILABLE` / `INSUFFICIENT_DATA` / `NO_SETUP` / `DATA_QUALITY_BLOCK` / `EMERGENCY_SL_CEILING`
- Labels are UI-only; setups use measurable conditions
- No look-ahead: `candlesAvailableAt(asOf)`
- SL never “20 pips”; 20% is emergency ceiling that **blocks** open

## Not yet physical DONE

Full acceptance (§23) still requires real multi-provider ticks on i3, durable persistence of ticks/candles from live feeds, broker fill path wired to this OSM, and monitor panels showing the vector from server truth.
