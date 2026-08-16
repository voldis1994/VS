# Regime engine

Location: `SERVER/core/regime/`.

First-class regimes including TREND_UP/DOWN, RANGE, breakout candidate/confirmed/failed, volatility expansion/compression, reversal candidates, liquidity/spread/stale/unstable, NO_TRADE.

Hysteresis / minimum residence via `applyHysteresis` — no single-tick flips.

Thresholds belong in versioned configuration (expand under `SERVER/config`).
