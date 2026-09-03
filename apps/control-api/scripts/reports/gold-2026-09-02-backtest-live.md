# Gold backtest — 2026-09-02 (1m) · live

Source: **Yahoo Finance GC=F** (public). Lot **0.1**. Spread **0.5**.
Mode: **live (no impulse CONTINUATION — matches desk)**.
PnL: **£0.10 / point** (£1/pt @ 1.0 lot).

## Result

| Metric | Value |
| --- | --- |
| Bars | 1379 |
| Trades opened | **8** |
| Wins / Losses / Flat | 6 / 2 / 0 |
| Total P&L | **£2.54** |
| Avg / trade | £0.32 |
| Wrong entries | **2** (25%) |
| Missed candidates (shadow) | **121** |
| Unnecessary blocks | **36** (29.8%) |
| £ left on table (unnecessary) | **£12.25** |

## Unnecessary blocks

Shadow = ja būtu iegujuši ar to pašu exit smadzenēm. Unnecessary = shadow peļņa > £0.05 un MFE ≥ 0.8pt.

- **10×** wait · need 2 green 1m (momentum)
- **7×** wait · spike 1m — need next candle confirm
- **7×** against-move / local climax
- **6×** wait · need closed green 1m confirm
- **3×** wait · need 2 red 1m (momentum)
- **1×** wait · need closed red 1m confirm
- **1×** same-side dead SELL until flip (flow DOWN) · no spam re-entry
- **1×** same-side dead BUY until flip (flow UP) · no spam re-entry


### By category

- **candle**: 93 blocked · **27** unnecessary
- **against_move**: 22 blocked · **7** unnecessary
- **post_exit**: 6 blocked · **2** unnecessary

## Wrong entries — main reasons

- **1×** Loss with no real MFE run (<0.8pt) — wrong side / late
- **1×** BUY at tip (virsotne) — tip-chase


## Exit reasons

- **3×** PeakProtection
- **2×** BestOutcome harvest
- **1×** ThesisFailure
- **1×** MoveFlip
- **1×** Target

## Setups

- **4×** BREAKOUT
- **3×** CONTINUATION
- **1×** FADE

## Trades

| # | Side | Setup | Entry UTC | Exit UTC | Pts | £ | MFE | Hold | Exit | Wrong |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | SELL | CONTINUATION | 01:57 | 01:59 | 0.90 | 0.09 | 3.75 | 2m | PeakProtection |  |
| 2 | BUY | FADE | 03:37 | 03:40 | 2.60 | 0.26 | 4.75 | 3m | PeakProtection |  |
| 3 | SELL | CONTINUATION | 04:45 | 04:48 | -1.90 | -0.19 | 0.00 | 3m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 4 | BUY | CONTINUATION | 11:03 | 11:06 | -2.40 | -0.24 | 1.85 | 3m | MoveFlip |  |
| 5 | BUY | BREAKOUT | 13:22 | 13:31 | 19.20 | 1.92 | 19.45 | 9m | Target |  |
| 6 | BUY | BREAKOUT | 13:42 | 13:45 | 3.20 | 0.32 | 5.15 | 3m | BestOutcome harvest | BUY at tip (virsotne) — tip-chase |
| 7 | BUY | BREAKOUT | 13:58 | 14:00 | 2.80 | 0.28 | 4.65 | 2m | BestOutcome harvest |  |
| 8 | BUY | BREAKOUT | 14:05 | 14:09 | 1.00 | 0.10 | 2.85 | 4m | PeakProtection |  |

Full JSON: `scripts/reports/gold-2026-09-02-backtest-live.json`
