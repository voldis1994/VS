# Trend Continuation Strategy

## WHY

Uses **directional persistence** measured from closed 10-second OHLC:
regression slope, R² (trend quality), structure HH/HL or LH/LL, and multi-feed confidence.

Hypothesis: when trend strength and quality are both elevated and noise is bounded,
continuation in the measured direction has positive expectancy *conditional on*
protective structure/ATR stop and feed agreement.

## WHEN

Measurable conditions (all must PASS):

- `market_state.status == OK` (enough closed 10s bars)
- feed quality OK or DEGRADED (never BLOCK)
- `trend_strength ≥ threshold`
- `trend_quality (R²) ≥ threshold`
- `|direction_score| ≥ threshold`
- `noise_score ≤ ceiling`
- feed confidence ≥ threshold (when available)

## WHY ENTRY

Entry is at the validated multi-feed trading price (median mid) only after setup PASS.
Direction = sign(direction_score). No entry from regime label alone.

## WHY INVALIDATION

Protective SL at structure swing (preferred) or ATR envelope.
If price trades through invalidation, the continuation hypothesis is false.

## WHY EXIT

Exit engine ranks HOLD / MOVE_SL / TRAIL / PARTIAL / FULL using MFE/MAE,
giveback ratio, momentum decay, and structure deterioration — no look-ahead.

## FAILURE MODES

- Single-feed environments without confirmation → INSUFFICIENT_DATA / DATA_QUALITY_BLOCK
- Compression / high noise → NO_SETUP
- Computed SL beyond emergency ceiling (default 20% of price) → trade must not open
- Stale or disagreeing feeds → DATA_QUALITY_BLOCK
