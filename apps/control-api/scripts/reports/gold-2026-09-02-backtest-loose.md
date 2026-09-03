# Gold backtest — 2026-09-02 (1m) · loose

Source: **Yahoo Finance GC=F** (public). Lot **0.1**. Spread **0.5**.
Mode: **loose (no candle/2bar/spike, no against-move/climax)**.
PnL: **£0.10 / point** (£1/pt @ 1.0 lot).

## Result

| Metric | Value |
| --- | --- |
| Bars | 1379 |
| Trades opened | **76** |
| Wins / Losses / Flat | 33 / 42 / 1 |
| Total P&L | **£-2.67** |
| Avg / trade | £-0.04 |
| Wrong entries | **34** (44.7%) |
| Missed candidates (shadow) | **115** |
| Unnecessary blocks | **32** (27.8%) |
| £ left on table (unnecessary) | **£13.17** |

## Unnecessary blocks

Shadow = ja būtu iegujuši ar to pašu exit smadzenēm. Unnecessary = shadow peļņa > £0.05 un MFE ≥ 0.8pt.

- **18×** same-side dead BUY until flip (flow UP) · no spam re-entry
- **11×** same-side dead SELL until flip (flow DOWN) · no spam re-entry
- **2×** post-exit cool-down 180s · quality over frequency
- **1×** post-exit cool-down 240s · quality over frequency


### By category

- **post_exit**: 115 blocked · **32** unnecessary

## Wrong entries — main reasons

- **33×** Loss with no real MFE run (<0.8pt) — wrong side / late
- **1×** Fast fail (2m) · ThesisFailure


## Exit reasons

- **29×** ThesisFailure
- **21×** MoveFlip
- **16×** PeakProtection
- **7×** BestOutcome harvest
- **3×** EarlyCut

## Setups

- **72×** CONTINUATION
- **3×** FADE
- **1×** BREAKOUT

## Trades

| # | Side | Setup | Entry UTC | Exit UTC | Pts | £ | MFE | Hold | Exit | Wrong |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | SELL | CONTINUATION | 01:01 | 01:06 | 4.60 | 0.46 | 8.95 | 5m | PeakProtection |  |
| 2 | BUY | CONTINUATION | 01:15 | 01:18 | -4.00 | -0.40 | 0.00 | 3m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 3 | SELL | CONTINUATION | 01:27 | 01:40 | 7.40 | 0.74 | 10.85 | 13m | MoveFlip |  |
| 4 | BUY | CONTINUATION | 02:06 | 02:09 | -7.70 | -0.77 | 0.15 | 3m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 5 | SELL | CONTINUATION | 02:51 | 03:01 | 3.90 | 0.39 | 6.55 | 10m | MoveFlip |  |
| 6 | BUY | CONTINUATION | 03:10 | 03:11 | -0.80 | -0.08 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 7 | SELL | CONTINUATION | 03:16 | 03:24 | 3.50 | 0.35 | 6.25 | 8m | PeakProtection |  |
| 8 | BUY | FADE | 03:37 | 03:40 | 2.60 | 0.26 | 4.75 | 3m | PeakProtection |  |
| 9 | SELL | CONTINUATION | 04:13 | 04:14 | -0.80 | -0.08 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 10 | BUY | CONTINUATION | 05:12 | 05:18 | 2.50 | 0.25 | 3.85 | 6m | BestOutcome harvest |  |
| 11 | SELL | CONTINUATION | 05:54 | 06:02 | -1.90 | -0.19 | 0.00 | 8m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 12 | BUY | CONTINUATION | 06:08 | 06:10 | 1.10 | 0.11 | 3.45 | 2m | PeakProtection |  |
| 13 | SELL | CONTINUATION | 06:16 | 06:18 | -3.90 | -0.39 | 0.95 | 2m | ThesisFailure | Fast fail (2m) · ThesisFailure |
| 14 | BUY | CONTINUATION | 06:24 | 06:28 | -2.80 | -0.28 | 0.00 | 4m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 15 | SELL | CONTINUATION | 06:29 | 06:34 | 1.90 | 0.19 | 3.05 | 5m | BestOutcome harvest |  |
| 16 | BUY | CONTINUATION | 06:39 | 06:46 | -3.80 | -0.38 | 1.05 | 7m | MoveFlip |  |
| 17 | SELL | CONTINUATION | 06:47 | 06:55 | 2.20 | 0.22 | 4.25 | 8m | PeakProtection |  |
| 18 | BUY | CONTINUATION | 07:06 | 07:14 | 3.40 | 0.34 | 6.75 | 8m | MoveFlip |  |
| 19 | SELL | CONTINUATION | 07:28 | 07:30 | -2.40 | -0.24 | 0.00 | 2m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 20 | BUY | CONTINUATION | 07:31 | 07:34 | -2.40 | -0.24 | 0.00 | 3m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 21 | SELL | CONTINUATION | 07:39 | 07:45 | 1.80 | 0.18 | 3.75 | 6m | PeakProtection |  |
| 22 | BUY | CONTINUATION | 08:04 | 08:06 | -4.40 | -0.44 | 0.00 | 2m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 23 | SELL | CONTINUATION | 08:25 | 08:30 | -1.50 | -0.15 | 1.05 | 5m | MoveFlip |  |
| 24 | BUY | CONTINUATION | 08:37 | 08:42 | -0.80 | -0.08 | 1.25 | 5m | ThesisFailure |  |
| 25 | SELL | CONTINUATION | 08:43 | 08:46 | 1.30 | 0.13 | 2.25 | 3m | BestOutcome harvest |  |
| 26 | BUY | CONTINUATION | 09:03 | 09:04 | -0.90 | -0.09 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 27 | SELL | CONTINUATION | 09:10 | 09:16 | 1.80 | 0.18 | 3.15 | 6m | BestOutcome harvest |  |
| 28 | BUY | CONTINUATION | 09:29 | 09:30 | -0.60 | -0.06 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 29 | SELL | CONTINUATION | 10:02 | 10:10 | 2.40 | 0.24 | 4.75 | 8m | MoveFlip |  |
| 30 | BUY | CONTINUATION | 10:13 | 10:23 | 2.50 | 0.25 | 4.25 | 10m | PeakProtection |  |
| 31 | SELL | CONTINUATION | 10:31 | 10:46 | -1.80 | -0.18 | 0.00 | 15m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 32 | BUY | CONTINUATION | 11:00 | 11:05 | 1.00 | 0.10 | 2.65 | 5m | PeakProtection |  |
| 33 | SELL | CONTINUATION | 11:42 | 11:45 | -0.40 | -0.04 | 1.45 | 3m | ThesisFailure |  |
| 34 | BUY | CONTINUATION | 11:52 | 11:56 | 2.60 | 0.26 | 5.45 | 4m | PeakProtection |  |
| 35 | SELL | CONTINUATION | 12:08 | 12:09 | -3.10 | -0.31 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 36 | BUY | CONTINUATION | 12:14 | 12:16 | -2.40 | -0.24 | 0.00 | 2m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 37 | SELL | CONTINUATION | 12:30 | 12:38 | 3.70 | 0.37 | 6.25 | 8m | PeakProtection |  |
| 38 | BUY | CONTINUATION | 12:49 | 12:51 | -5.30 | -0.53 | 0.00 | 2m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 39 | SELL | CONTINUATION | 12:52 | 12:54 | -1.90 | -0.19 | 0.00 | 2m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 40 | BUY | CONTINUATION | 13:02 | 13:09 | 1.70 | 0.17 | 3.15 | 7m | PeakProtection |  |
| 41 | SELL | FADE | 13:37 | 13:41 | -6.30 | -0.63 | 0.00 | 4m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 42 | BUY | BREAKOUT | 13:52 | 14:01 | 2.70 | 0.27 | 7.95 | 9m | MoveFlip |  |
| 43 | SELL | FADE | 14:03 | 14:05 | -7.30 | -0.73 | 0.00 | 2m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 44 | BUY | CONTINUATION | 14:19 | 14:21 | 0.90 | 0.09 | 2.15 | 2m | PeakProtection |  |
| 45 | SELL | CONTINUATION | 14:30 | 14:32 | -3.30 | -0.33 | 0.00 | 2m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 46 | BUY | CONTINUATION | 14:33 | 14:34 | -0.50 | -0.05 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 47 | SELL | CONTINUATION | 14:36 | 14:42 | -1.20 | -0.12 | 0.45 | 6m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 48 | BUY | CONTINUATION | 15:02 | 15:04 | 0.00 | 0.00 | 3.35 | 2m | ThesisFailure |  |
| 49 | SELL | CONTINUATION | 15:07 | 15:23 | 4.80 | 0.48 | 8.45 | 16m | MoveFlip |  |
| 50 | BUY | CONTINUATION | 15:24 | 15:25 | -0.90 | -0.09 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 51 | SELL | CONTINUATION | 15:35 | 15:46 | 1.30 | 0.13 | 4.95 | 11m | PeakProtection |  |
| 52 | BUY | CONTINUATION | 15:55 | 16:04 | 1.50 | 0.15 | 3.45 | 9m | MoveFlip |  |
| 53 | SELL | CONTINUATION | 16:05 | 16:10 | -2.90 | -0.29 | 0.00 | 5m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 54 | BUY | CONTINUATION | 16:52 | 16:54 | 1.50 | 0.15 | 2.35 | 2m | BestOutcome harvest |  |
| 55 | SELL | CONTINUATION | 17:11 | 17:21 | 1.50 | 0.15 | 2.95 | 10m | MoveFlip |  |
| 56 | BUY | CONTINUATION | 17:23 | 17:26 | 0.60 | 0.06 | 1.35 | 3m | ThesisFailure |  |
| 57 | SELL | CONTINUATION | 17:34 | 17:35 | -0.90 | -0.09 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 58 | BUY | CONTINUATION | 17:41 | 17:48 | 5.80 | 0.58 | 10.15 | 7m | MoveFlip |  |
| 59 | SELL | CONTINUATION | 18:00 | 18:03 | -2.80 | -0.28 | 0.55 | 3m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 60 | BUY | CONTINUATION | 18:05 | 18:06 | -1.60 | -0.16 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 61 | SELL | CONTINUATION | 18:08 | 18:13 | 1.20 | 0.12 | 2.15 | 5m | BestOutcome harvest |  |
| 62 | BUY | CONTINUATION | 18:18 | 18:22 | -3.10 | -0.31 | 1.15 | 4m | MoveFlip |  |
| 63 | SELL | CONTINUATION | 18:23 | 18:31 | -2.40 | -0.24 | 0.45 | 8m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 64 | BUY | CONTINUATION | 18:32 | 18:34 | 0.30 | 0.03 | 2.25 | 2m | PeakProtection |  |
| 65 | SELL | CONTINUATION | 18:42 | 18:50 | -1.60 | -0.16 | 0.85 | 8m | MoveFlip |  |
| 66 | BUY | CONTINUATION | 18:51 | 18:52 | -0.90 | -0.09 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 67 | SELL | CONTINUATION | 18:58 | 19:03 | -2.40 | -0.24 | 0.45 | 5m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 68 | BUY | CONTINUATION | 19:12 | 19:27 | 1.50 | 0.15 | 2.75 | 15m | PeakProtection |  |
| 69 | SELL | CONTINUATION | 19:36 | 19:37 | -1.70 | -0.17 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 70 | BUY | CONTINUATION | 19:41 | 19:45 | 0.60 | 0.06 | 2.75 | 4m | PeakProtection |  |
| 71 | SELL | CONTINUATION | 20:14 | 20:25 | -2.10 | -0.21 | 1.05 | 11m | ThesisFailure |  |
| 72 | BUY | CONTINUATION | 20:27 | 20:29 | -1.30 | -0.13 | 0.00 | 2m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 73 | SELL | CONTINUATION | 20:57 | 22:00 | -2.80 | -0.28 | 0.00 | 3m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 74 | BUY | CONTINUATION | 22:26 | 22:31 | -3.00 | -0.30 | 0.00 | 5m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 75 | SELL | CONTINUATION | 22:44 | 23:04 | -2.00 | -0.20 | 0.85 | 20m | ThesisFailure |  |
| 76 | BUY | CONTINUATION | 23:42 | 23:48 | 1.80 | 0.18 | 3.15 | 6m | BestOutcome harvest |  |

Full JSON: `scripts/reports/gold-2026-09-02-backtest-loose.json`
