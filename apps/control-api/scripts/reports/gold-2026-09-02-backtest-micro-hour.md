# Gold backtest — 2026-09-02 (1m) · micro-hour

Source: **Yahoo Finance GC=F** (public). Lot **0.1**. Spread **0.5**.
Mode: **live + micro-chop (hour filter, SCALP book)**.
PnL: **£0.10 / point** (£1/pt @ 1.0 lot).

## Result

| Metric | Value |
| --- | --- |
| Bars | 1379 |
| Trades opened | **10** |
| Wins / Losses / Flat | 4 / 6 / 0 |
| Total P&L | **£1.18** |
| Avg / trade | £0.12 |
| Wrong entries | **4** (40%) |
| Missed candidates (shadow) | **122** |
| Unnecessary blocks | **37** (30.3%) |
| £ left on table (unnecessary) | **£12.22** |

## Unnecessary blocks

Shadow = ja būtu iegujuši ar to pašu exit smadzenēm. Unnecessary = shadow peļņa > £0.05 un MFE ≥ 0.8pt.

- **9×** wait · need 2 green 1m (momentum)
- **7×** wait · spike 1m — need next candle confirm
- **7×** against-move / local climax
- **6×** wait · need closed green 1m confirm
- **3×** wait · need 2 red 1m (momentum)
- **2×** same-side dead SELL until flip (flow DOWN) · no spam re-entry
- **1×** wait · need closed red 1m confirm
- **1×** same-side dead BUY until flip (flow UP) · no spam re-entry
- **1×** post-exit cool-down 240s · quality over frequency


### By category

- **candle**: 89 blocked · **26** unnecessary
- **against_move**: 21 blocked · **7** unnecessary
- **post_exit**: 12 blocked · **4** unnecessary

## Wrong entries — main reasons

- **3×** Loss with no real MFE run (<0.8pt) — wrong side / late
- **1×** Fast fail (2m) · ReversalStop


## Exit reasons

- **3×** MoveFlip
- **2×** PeakProtection
- **2×** ThesisFailure
- **1×** ReversalStop
- **1×** Target
- **1×** EarlyCut

## Setups

- **5×** CONTINUATION
- **3×** FADE
- **2×** BREAKOUT

## Trades

| # | Side | Setup | Entry UTC | Exit UTC | Pts | £ | MFE | Hold | Exit | Wrong |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | SELL | CONTINUATION | 01:57 | 01:59 | 0.90 | 0.09 | 3.75 | 2m | PeakProtection |  |
| 2 | BUY | FADE | 03:37 | 03:40 | 2.60 | 0.26 | 4.75 | 3m | PeakProtection |  |
| 3 | SELL | CONTINUATION | 04:13 | 04:14 | -0.80 | -0.08 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 4 | BUY | CONTINUATION | 07:30 | 07:34 | -0.40 | -0.04 | 1.75 | 4m | ThesisFailure |  |
| 5 | SELL | CONTINUATION | 10:52 | 10:54 | -3.40 | -0.34 | 0.00 | 2m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 6 | BUY | CONTINUATION | 11:03 | 11:06 | -2.40 | -0.24 | 1.85 | 3m | MoveFlip |  |
| 7 | SELL | FADE | 13:12 | 13:14 | -0.40 | -0.04 | 1.15 | 2m | ReversalStop | Fast fail (2m) · ReversalStop |
| 8 | BUY | BREAKOUT | 13:22 | 13:31 | 19.20 | 1.92 | 19.45 | 9m | Target |  |
| 9 | SELL | FADE | 13:37 | 13:41 | -6.30 | -0.63 | 0.00 | 4m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 10 | BUY | BREAKOUT | 13:57 | 14:01 | 2.80 | 0.28 | 8.05 | 4m | MoveFlip |  |

Full JSON: `scripts/reports/gold-2026-09-02-backtest-micro-hour.json`
