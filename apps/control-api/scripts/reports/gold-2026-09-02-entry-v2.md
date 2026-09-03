# Entry model v2 — live desk

Gold 2026-09-02 · lot 0.1 · shipped to robot desk

| Mode | Trades | W/L | P&L | Wrong |
| --- | ---: | ---: | ---: | ---: |
| Prior live (`no_impulse` only) | 8 | 4/4 | £+1.45 | 3 |
| **Entry v2 (this)** | 8 | 6/2 | **£+2.54** | 2 |

Δ **+£1.09** vs prior live.

## What changed (live)

1. **FADE quality** — block FADE SELL into `marketTrend UP` (kills 13:37 −£0.63). FADE BUY vs DOWN hour/trend still OK on V-flip UP (keeps 03:37 +£0.26).
2. **CONTINUATION mid-leg quality** — room + climax + tip/floor on mid-swing / mid-leg reasons only.
3. **Post-exit** — through-level BREAKOUT may re-enter same side after 5m cool-down (so blocking tip FADEs does not miss 13:22 +£1.92). Impulse BREAKOUT spam still blocked.
4. **Kept** — `no_impulse` CONTINUATION, ARMED-only, candle/against-move gates.

## Trades (v2)

| # | Side | Setup | UTC | £ | Note |
| --- | --- | --- | --- | ---: | --- |
| 1 | SELL | CONT dump | 01:57 | +0.09 | |
| 2 | BUY | FADE | 03:37 | +0.26 | V-flip floor |
| 3 | SELL | mid-swing CONT | 04:45 | −0.19 | still 0 MFE |
| 4 | BUY | mid-swing CONT | 11:03 | −0.24 | had MFE |
| 5 | BUY | BREAKOUT through H | 13:22 | **+1.92** | |
| 6–8 | BUY | BREAKOUT through H | 13:42–14:05 | +0.70 | continuation of rally |

Removed vs prior: FADE SELL 13:12 (−0.04), FADE SELL 13:37 (−0.63).
