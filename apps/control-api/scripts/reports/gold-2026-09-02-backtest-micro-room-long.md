# Gold backtest — 2026-09-02 (1m) · micro-room-long

Source: **Yahoo Finance GC=F** (public). Lot **0.1**. Spread **0.5**.
Mode: **live + micro-chop (room filter, LONG book)**.
PnL: **£0.10 / point** (£1/pt @ 1.0 lot).

## Result

| Metric | Value |
| --- | --- |
| Bars | 1379 |
| Trades opened | **34** |
| Wins / Losses / Flat | 10 / 24 / 0 |
| Total P&L | **£-0.70** |
| Avg / trade | £-0.02 |
| Wrong entries | **21** (61.8%) |
| Missed candidates (shadow) | **129** |
| Unnecessary blocks | **36** (27.9%) |
| £ left on table (unnecessary) | **£11.64** |

## Unnecessary blocks

Shadow = ja būtu iegujuši ar to pašu exit smadzenēm. Unnecessary = shadow peļņa > £0.05 un MFE ≥ 0.8pt.

- **7×** wait · need 2 green 1m (momentum)
- **6×** against-move / local climax
- **5×** wait · spike 1m — need next candle confirm
- **5×** wait · need closed green 1m confirm
- **3×** wait · need 2 red 1m (momentum)
- **3×** same-side dead SELL until flip (flow DOWN) · no spam re-entry
- **3×** same-side dead BUY until flip (flow UP) · no spam re-entry
- **2×** wait · need closed red 1m confirm
- **1×** wait · confirm after UP spike (close below spike)
- **1×** post-exit cool-down 240s · quality over frequency


### By category

- **candle**: 85 blocked · **23** unnecessary
- **post_exit**: 24 blocked · **7** unnecessary
- **against_move**: 20 blocked · **6** unnecessary

## Wrong entries — main reasons

- **20×** Loss with no real MFE run (<0.8pt) — wrong side / late
- **1×** Fast fail (2m) · ReversalStop


## Exit reasons

- **19×** ThesisFailure
- **5×** PeakProtection
- **3×** EarlyCut
- **3×** MoveFlip
- **2×** BestOutcome harvest
- **1×** ReversalStop
- **1×** Target

## Setups

- **29×** CONTINUATION
- **3×** FADE
- **2×** BREAKOUT

## Trades

| # | Side | Setup | Entry UTC | Exit UTC | Pts | £ | MFE | Hold | Exit | Wrong |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | SELL | CONTINUATION | 01:09 | 01:10 | -7.40 | -0.74 | 0.00 | 1m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 2 | BUY | CONTINUATION | 01:24 | 01:27 | -6.30 | -0.63 | 0.00 | 3m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 3 | SELL | CONTINUATION | 01:57 | 01:59 | 0.90 | 0.09 | 3.75 | 2m | PeakProtection |  |
| 4 | BUY | CONTINUATION | 02:49 | 02:51 | -3.60 | -0.36 | 0.00 | 2m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 5 | SELL | CONTINUATION | 03:12 | 03:24 | 4.90 | 0.49 | 7.65 | 12m | BestOutcome harvest |  |
| 6 | BUY | FADE | 03:37 | 03:40 | 2.60 | 0.26 | 4.75 | 3m | PeakProtection |  |
| 7 | SELL | CONTINUATION | 04:13 | 04:14 | -0.80 | -0.08 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 8 | BUY | CONTINUATION | 04:15 | 04:17 | -1.60 | -0.16 | 0.00 | 2m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 9 | SELL | CONTINUATION | 04:39 | 04:43 | -1.90 | -0.19 | 0.05 | 4m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 10 | BUY | CONTINUATION | 05:25 | 05:36 | 11.20 | 1.12 | 15.35 | 11m | MoveFlip |  |
| 11 | SELL | CONTINUATION | 05:37 | 05:38 | -1.20 | -0.12 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 12 | BUY | CONTINUATION | 06:02 | 06:03 | -3.50 | -0.35 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 13 | SELL | CONTINUATION | 06:11 | 06:12 | -2.60 | -0.26 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 14 | BUY | CONTINUATION | 07:30 | 07:34 | -0.40 | -0.04 | 1.75 | 4m | ThesisFailure |  |
| 15 | SELL | CONTINUATION | 08:43 | 08:46 | 1.30 | 0.13 | 2.25 | 3m | BestOutcome harvest |  |
| 16 | BUY | CONTINUATION | 09:03 | 09:04 | -0.90 | -0.09 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 17 | SELL | CONTINUATION | 09:36 | 09:40 | -1.70 | -0.17 | 0.35 | 4m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 18 | BUY | CONTINUATION | 11:03 | 11:06 | -2.40 | -0.24 | 1.85 | 3m | MoveFlip |  |
| 19 | SELL | CONTINUATION | 11:43 | 11:45 | -1.60 | -0.16 | 0.25 | 2m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 20 | BUY | CONTINUATION | 11:52 | 11:56 | 2.60 | 0.26 | 5.45 | 4m | PeakProtection |  |
| 21 | SELL | CONTINUATION | 12:08 | 12:09 | -3.10 | -0.31 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 22 | BUY | CONTINUATION | 12:14 | 12:16 | -2.40 | -0.24 | 0.00 | 2m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 23 | SELL | FADE | 13:12 | 13:14 | -0.40 | -0.04 | 1.15 | 2m | ReversalStop | Fast fail (2m) · ReversalStop |
| 24 | BUY | BREAKOUT | 13:22 | 13:31 | 19.20 | 1.92 | 19.45 | 9m | Target |  |
| 25 | SELL | FADE | 13:37 | 13:41 | -6.30 | -0.63 | 0.00 | 4m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 26 | BUY | BREAKOUT | 13:57 | 14:01 | 2.80 | 0.28 | 8.05 | 4m | MoveFlip |  |
| 27 | SELL | CONTINUATION | 15:35 | 15:46 | 1.30 | 0.13 | 4.95 | 11m | PeakProtection |  |
| 28 | BUY | CONTINUATION | 16:31 | 16:32 | -1.90 | -0.19 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 29 | SELL | CONTINUATION | 18:23 | 18:31 | -2.40 | -0.24 | 0.45 | 8m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 30 | BUY | CONTINUATION | 18:50 | 18:52 | -0.30 | -0.03 | 0.35 | 2m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 31 | SELL | CONTINUATION | 19:36 | 19:37 | -1.70 | -0.17 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 32 | BUY | CONTINUATION | 19:38 | 19:45 | 2.50 | 0.25 | 4.65 | 7m | PeakProtection |  |
| 33 | SELL | CONTINUATION | 20:54 | 22:00 | -0.90 | -0.09 | 1.65 | 6m | ThesisFailure |  |
| 34 | BUY | CONTINUATION | 22:23 | 22:24 | -1.00 | -0.10 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |

Full JSON: `scripts/reports/gold-2026-09-02-backtest-micro-room-long.json`
