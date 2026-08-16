# Exit engine — VS CORE

Authoritative exit management runs on **i3 only**.

## Purpose

Continuously evaluate open positions from live market evidence and choose
best-outcome actions: HOLD, PARTIAL_EXIT, MOVE_SL, TRAIL, FULL_EXIT.

## Measurements (required)

For every open position track real values only:

- MFE (maximum favorable excursion)
- MAE (maximum adverse excursion)
- peak unrealized P/L and peak price + timestamp
- giveback from peak

Implementation: `SERVER/core/market-intelligence/src/exitEngine.ts`
plus strategy-specific exits under `SERVER/core/strategies/*/exit.ts`.

## Exit evidence (examples)

- strategy invalidation
- structure break / momentum failure
- failed continuation / reversal confirmation
- volatility transition
- target reached / trailing protection
- feed integrity or execution problem

## Recording

Every exit decision must store:

- exit reason
- market state at exit
- features used
- MFE / MAE / peak
- realized P/L and holding time

## Protective SL / BE / TP

- Every position has a protective stop from structure/volatility + instrument constraints.
- ~20% of price is an **emergency ceiling**, not a normal stop distance.
- Break-even and take-profit require measured evidence (risk cleared, structure, costs) — not arbitrary fixed points.

## API / UI

ADMIN and CLIENT display exit state from server APIs — they never compute authoritative exits locally.
