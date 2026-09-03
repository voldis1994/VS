# Gold backtest — 2026-09-02 (1m) · live

Source: **Yahoo Finance GC=F** (public). Lot **0.1**. Spread **0.5**.
Mode: **live (no impulse CONTINUATION — matches desk)**.
PnL: **£0.10 / point** (£1/pt @ 1.0 lot).

## Result

| Metric | Value |
| --- | --- |
| Bars | 1379 |
| Trades opened | **10** |
| Wins / Losses / Flat | 6 / 4 / 0 |
| Total P&L | **£2.06** |
| Avg / trade | £0.21 |
| Wrong entries | **4** (40%) |
| Missed candidates (shadow) | **115** |
| Unnecessary blocks | **33** (28.7%) |
| £ left on table (unnecessary) | **£12.29** |

## Unnecessary blocks

Shadow = ja būtu iegujuši ar to pašu exit smadzenēm. Unnecessary = shadow peļņa > £0.05 un MFE ≥ 0.8pt.

- **10×** against-move / local climax
- **7×** wait · spike 1m — need next candle confirm
- **7×** wait · need 2 green 1m (momentum)
- **3×** wait · need 2 red 1m (momentum)
- **2×** same-side dead BUY until flip (flow UP) · no spam re-entry
- **2×** wait · need closed green 1m confirm
- **1×** wait · need closed red 1m confirm
- **1×** same-side dead SELL until flip (flow DOWN) · no spam re-entry


### By category

- **candle**: 72 blocked · **20** unnecessary
- **against_move**: 31 blocked · **10** unnecessary
- **post_exit**: 12 blocked · **3** unnecessary

## Wrong entries — main reasons

- **3×** Loss with no real MFE run (<0.8pt) — wrong side / late
- **1×** BUY at tip (virsotne) — tip-chase


## Exit reasons

- **3×** PeakProtection
- **3×** ThesisFailure
- **2×** BestOutcome harvest
- **1×** MoveFlip
- **1×** Target

## Setups

- **5×** CONTINUATION
- **4×** BREAKOUT
- **1×** FADE

## Trades

| # | Side | Setup | Entry UTC | Exit UTC | Pts | £ | MFE | Hold | Exit | Wrong |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | SELL | CONTINUATION | 01:57 | 01:59 | 0.90 | 0.09 | 3.75 | 2m | PeakProtection |  |
| 2 | BUY | FADE | 03:37 | 03:40 | 2.60 | 0.26 | 4.75 | 3m | PeakProtection |  |
| 3 | SELL | CONTINUATION | 04:45 | 04:48 | -1.90 | -0.19 | 0.00 | 3m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 4 | BUY | CONTINUATION | 07:19 | 07:26 | -1.70 | -0.17 | 0.15 | 7m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 5 | SELL | CONTINUATION | 10:58 | 10:59 | -3.10 | -0.31 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 6 | BUY | CONTINUATION | 11:03 | 11:06 | -2.40 | -0.24 | 1.85 | 3m | MoveFlip |  |
| 7 | BUY | BREAKOUT | 13:22 | 13:31 | 19.20 | 1.92 | 19.45 | 9m | Target |  |
| 8 | BUY | BREAKOUT | 13:42 | 13:45 | 3.20 | 0.32 | 5.15 | 3m | BestOutcome harvest | BUY at tip (virsotne) — tip-chase |
| 9 | BUY | BREAKOUT | 13:58 | 14:00 | 2.80 | 0.28 | 4.65 | 2m | BestOutcome harvest |  |
| 10 | BUY | BREAKOUT | 14:05 | 14:09 | 1.00 | 0.10 | 2.85 | 4m | PeakProtection |  |

Full JSON: `scripts/reports/gold-2026-09-02-backtest-live.json`
