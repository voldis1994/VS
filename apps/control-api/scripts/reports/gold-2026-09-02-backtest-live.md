# Gold backtest — 2026-09-02 (1m) · live

Source: **Yahoo Finance GC=F** (public). Lot **0.1**. Spread **0.5**.
Mode: **live (no impulse CONTINUATION — matches desk)**.
PnL: **£0.10 / point** (£1/pt @ 1.0 lot).

## Result

| Metric | Value |
| --- | --- |
| Bars | 1379 |
| Trades opened | **9** |
| Wins / Losses / Flat | 5 / 4 / 0 |
| Total P&L | **£1.45** |
| Avg / trade | £0.16 |
| Wrong entries | **5** (55.6%) |
| Missed candidates (shadow) | **115** |
| Unnecessary blocks | **35** (30.4%) |
| £ left on table (unnecessary) | **£12.53** |

## Unnecessary blocks

Shadow = ja būtu iegujuši ar to pašu exit smadzenēm. Unnecessary = shadow peļņa > £0.05 un MFE ≥ 0.8pt.

- **11×** wait · need 2 green 1m (momentum)
- **7×** wait · spike 1m — need next candle confirm
- **7×** against-move / local climax
- **3×** wait · need 2 red 1m (momentum)
- **2×** same-side dead SELL until flip (flow DOWN) · no spam re-entry
- **2×** wait · need closed green 1m confirm
- **1×** wait · need closed red 1m confirm
- **1×** wait · confirm after DOWN spike (close above spike)
- **1×** same-side dead BUY until flip (flow UP) · no spam re-entry


### By category

- **candle**: 86 blocked · **25** unnecessary
- **against_move**: 21 blocked · **7** unnecessary
- **post_exit**: 8 blocked · **3** unnecessary

## Wrong entries — main reasons

- **4×** Loss with no real MFE run (<0.8pt) — wrong side / late
- **1×** BUY at tip (virsotne) — tip-chase


## Exit reasons

- **2×** PeakProtection
- **2×** ThesisFailure
- **2×** BestOutcome harvest
- **1×** EarlyCut
- **1×** Target
- **1×** MoveFlip

## Setups

- **4×** CONTINUATION
- **4×** BREAKOUT
- **1×** FADE

## Trades

| # | Side | Setup | Entry UTC | Exit UTC | Pts | £ | MFE | Hold | Exit | Wrong |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | SELL | CONTINUATION | 01:09 | 01:10 | -7.40 | -0.74 | 0.00 | 1m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 2 | BUY | FADE | 03:37 | 03:40 | 2.60 | 0.26 | 4.75 | 3m | PeakProtection |  |
| 3 | SELL | CONTINUATION | 04:45 | 04:48 | -1.90 | -0.19 | 0.00 | 3m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 4 | BUY | CONTINUATION | 07:33 | 07:34 | -2.00 | -0.20 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 5 | BUY | BREAKOUT | 13:22 | 13:31 | 19.20 | 1.92 | 19.45 | 9m | Target |  |
| 6 | BUY | BREAKOUT | 13:42 | 13:45 | 3.20 | 0.32 | 5.15 | 3m | BestOutcome harvest | BUY at tip (virsotne) — tip-chase |
| 7 | BUY | BREAKOUT | 13:58 | 14:00 | 2.80 | 0.28 | 4.65 | 2m | BestOutcome harvest |  |
| 8 | BUY | BREAKOUT | 14:05 | 14:09 | 1.00 | 0.10 | 2.85 | 4m | PeakProtection |  |
| 9 | BUY | CONTINUATION | 15:32 | 15:35 | -3.00 | -0.30 | 0.00 | 3m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |

Full JSON: `scripts/reports/gold-2026-09-02-backtest-live.json`
