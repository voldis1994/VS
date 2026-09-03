# Gold backtest — 2026-09-02 (1m)

Source: **Yahoo Finance GC=F** (public). Lot **0.1**. Spread **0.5**.
PnL: **£0.10 / point** (£1/pt @ 1.0 lot).

## Result

| Metric | Value |
| --- | --- |
| Bars | 1379 |
| Trades opened | **54** |
| Wins / Losses / Flat | 18 / 34 / 2 |
| Total P&L | **£-4.16** |
| Avg / trade | £-0.08 |
| Wrong entries | **20** (37%) |

## Wrong entries — main reasons

- **19×** Loss with no real MFE run (<0.8pt) — wrong side / late
- **1×** Fast fail (2m) · ThesisFailure


## Exit reasons

- **22×** MoveFlip
- **13×** ThesisFailure
- **9×** PeakProtection
- **4×** EarlyCut
- **4×** BestOutcome harvest
- **2×** ReversalStop

## Setups

- **51×** CONTINUATION
- **2×** BREAKOUT
- **1×** FADE

## Trades

| # | Side | Setup | Entry UTC | Exit UTC | Pts | £ | MFE | Hold | Exit | Wrong |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | SELL | CONTINUATION | 01:01 | 01:06 | 4.60 | 0.46 | 8.95 | 5m | PeakProtection |  |
| 2 | BUY | CONTINUATION | 01:24 | 01:27 | -6.30 | -0.63 | 0.00 | 3m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 3 | SELL | CONTINUATION | 01:37 | 01:40 | -2.20 | -0.22 | 1.25 | 3m | MoveFlip |  |
| 4 | BUY | CONTINUATION | 02:06 | 02:09 | -7.70 | -0.77 | 0.15 | 3m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 5 | SELL | CONTINUATION | 02:54 | 02:59 | 2.50 | 0.25 | 4.75 | 5m | PeakProtection |  |
| 6 | BUY | CONTINUATION | 03:10 | 03:11 | -0.80 | -0.08 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 7 | SELL | CONTINUATION | 03:28 | 03:37 | 7.90 | 0.79 | 10.05 | 9m | MoveFlip |  |
| 8 | BUY | CONTINUATION | 03:45 | 04:06 | 11.60 | 1.16 | 12.95 | 20m | MoveFlip |  |
| 9 | SELL | CONTINUATION | 04:13 | 04:14 | -0.80 | -0.08 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 10 | BUY | CONTINUATION | 05:15 | 05:19 | -1.00 | -0.10 | 1.75 | 4m | MoveFlip |  |
| 11 | SELL | CONTINUATION | 05:59 | 06:02 | -2.10 | -0.21 | 0.00 | 3m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 12 | BUY | CONTINUATION | 06:08 | 06:10 | 1.10 | 0.11 | 3.45 | 2m | PeakProtection |  |
| 13 | SELL | CONTINUATION | 06:16 | 06:18 | -3.90 | -0.39 | 0.95 | 2m | ThesisFailure | Fast fail (2m) · ThesisFailure |
| 14 | BUY | CONTINUATION | 06:43 | 06:46 | -4.60 | -0.46 | 0.00 | 3m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 15 | SELL | CONTINUATION | 07:05 | 07:06 | -3.40 | -0.34 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 16 | BUY | CONTINUATION | 07:17 | 07:26 | -0.90 | -0.09 | 0.95 | 9m | ThesisFailure |  |
| 17 | SELL | CONTINUATION | 07:42 | 07:47 | 0.00 | 0.00 | 1.85 | 5m | MoveFlip |  |
| 18 | BUY | CONTINUATION | 08:08 | 08:11 | -2.30 | -0.23 | 2.05 | 3m | ReversalStop |  |
| 19 | SELL | CONTINUATION | 08:25 | 08:30 | -1.50 | -0.15 | 1.05 | 5m | MoveFlip |  |
| 20 | BUY | CONTINUATION | 08:37 | 08:42 | -0.80 | -0.08 | 1.25 | 5m | ThesisFailure |  |
| 21 | SELL | CONTINUATION | 08:50 | 08:56 | 3.00 | 0.30 | 5.25 | 6m | PeakProtection |  |
| 22 | BUY | CONTINUATION | 09:03 | 09:04 | -0.90 | -0.09 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 23 | SELL | CONTINUATION | 09:10 | 09:16 | 1.80 | 0.18 | 3.15 | 6m | BestOutcome harvest |  |
| 24 | BUY | CONTINUATION | 09:40 | 09:44 | -0.70 | -0.07 | 1.45 | 4m | MoveFlip |  |
| 25 | SELL | CONTINUATION | 10:02 | 10:10 | 2.40 | 0.24 | 4.75 | 8m | MoveFlip |  |
| 26 | BUY | CONTINUATION | 10:19 | 10:23 | 0.90 | 0.09 | 2.65 | 4m | PeakProtection |  |
| 27 | SELL | CONTINUATION | 10:52 | 10:54 | -3.40 | -0.34 | 0.00 | 2m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 28 | BUY | CONTINUATION | 11:02 | 11:06 | -2.60 | -0.26 | 1.65 | 4m | MoveFlip |  |
| 29 | SELL | CONTINUATION | 11:46 | 11:52 | -1.30 | -0.13 | 1.15 | 6m | MoveFlip |  |
| 30 | BUY | BREAKOUT | 12:00 | 12:02 | -4.70 | -0.47 | 0.00 | 2m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 31 | SELL | CONTINUATION | 12:12 | 12:13 | -3.40 | -0.34 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 32 | BUY | CONTINUATION | 12:26 | 12:27 | -5.10 | -0.51 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 33 | SELL | CONTINUATION | 12:56 | 13:00 | -3.60 | -0.36 | 1.45 | 4m | ThesisFailure |  |
| 34 | BUY | CONTINUATION | 13:16 | 13:19 | 1.00 | 0.10 | 2.75 | 3m | PeakProtection |  |
| 35 | SELL | FADE | 13:37 | 13:41 | -6.30 | -0.63 | 0.00 | 4m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 36 | BUY | BREAKOUT | 13:57 | 14:01 | 2.80 | 0.28 | 8.05 | 4m | MoveFlip |  |
| 37 | SELL | CONTINUATION | 14:30 | 14:32 | -3.30 | -0.33 | 0.00 | 2m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 38 | BUY | CONTINUATION | 15:24 | 15:25 | -0.90 | -0.09 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 39 | SELL | CONTINUATION | 15:36 | 15:46 | -0.40 | -0.04 | 3.25 | 10m | ReversalStop |  |
| 40 | BUY | CONTINUATION | 15:57 | 16:04 | 0.00 | 0.00 | 1.95 | 7m | MoveFlip |  |
| 41 | SELL | CONTINUATION | 16:16 | 16:31 | -1.70 | -0.17 | 0.25 | 15m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 42 | BUY | CONTINUATION | 16:52 | 16:54 | 1.50 | 0.15 | 2.35 | 2m | BestOutcome harvest |  |
| 43 | SELL | CONTINUATION | 17:11 | 17:21 | 1.50 | 0.15 | 2.95 | 10m | MoveFlip |  |
| 44 | BUY | CONTINUATION | 17:45 | 17:48 | -4.60 | -0.46 | 0.00 | 3m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 45 | SELL | CONTINUATION | 18:08 | 18:13 | 1.20 | 0.12 | 2.15 | 5m | BestOutcome harvest |  |
| 46 | BUY | CONTINUATION | 18:31 | 18:34 | 1.10 | 0.11 | 3.05 | 3m | PeakProtection |  |
| 47 | SELL | CONTINUATION | 18:42 | 18:50 | -1.60 | -0.16 | 0.85 | 8m | MoveFlip |  |
| 48 | BUY | CONTINUATION | 19:15 | 19:27 | 1.40 | 0.14 | 2.65 | 12m | PeakProtection |  |
| 49 | SELL | CONTINUATION | 19:36 | 19:37 | -1.70 | -0.17 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 50 | BUY | CONTINUATION | 19:50 | 19:53 | -3.10 | -0.31 | 0.00 | 3m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 51 | SELL | CONTINUATION | 20:14 | 20:25 | -2.10 | -0.21 | 1.05 | 11m | ThesisFailure |  |
| 52 | BUY | CONTINUATION | 20:35 | 20:53 | 1.20 | 0.12 | 2.45 | 18m | PeakProtection |  |
| 53 | SELL | CONTINUATION | 22:16 | 22:23 | -1.20 | -0.12 | 0.85 | 7m | MoveFlip |  |
| 54 | BUY | CONTINUATION | 23:42 | 23:48 | 1.80 | 0.18 | 3.15 | 6m | BestOutcome harvest |  |

Full JSON: `scripts/reports/gold-2026-09-02-backtest.json`
