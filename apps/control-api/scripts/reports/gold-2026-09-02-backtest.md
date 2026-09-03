# Gold backtest — 2026-09-02 (1m)

Source: **Yahoo Finance GC=F** (public). Lot **0.1**. Spread **0.5**.
PnL: **£0.10 / point** (£1/pt @ 1.0 lot).

## Result

| Metric | Value |
| --- | --- |
| Bars | 1379 |
| Trades opened | **34** |
| Wins / Losses / Flat | 12 / 22 / 0 |
| Total P&L | **£-0.38** |
| Avg / trade | £-0.01 |
| Wrong entries | **19** (55.9%) |

## Wrong entries — main reasons

- **18×** Loss with no real MFE run (<0.8pt) — wrong side / late
- **1×** Fast fail (2m) · ReversalStop


## Exit reasons

- **15×** ThesisFailure
- **8×** MoveFlip
- **4×** PeakProtection
- **3×** EarlyCut
- **2×** BestOutcome harvest
- **1×** ReversalStop
- **1×** Target

## Setups

- **29×** CONTINUATION
- **3×** BREAKOUT
- **2×** FADE

## Trades

| # | Side | Setup | Entry UTC | Exit UTC | Pts | £ | MFE | Hold | Exit | Wrong |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | SELL | CONTINUATION | 01:09 | 01:10 | -7.40 | -0.74 | 0.00 | 1m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 2 | BUY | CONTINUATION | 01:24 | 01:27 | -6.30 | -0.63 | 0.00 | 3m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 3 | SELL | CONTINUATION | 01:57 | 01:59 | 0.90 | 0.09 | 3.75 | 2m | PeakProtection |  |
| 4 | BUY | CONTINUATION | 02:14 | 02:22 | 5.00 | 0.50 | 8.15 | 8m | MoveFlip |  |
| 5 | SELL | CONTINUATION | 03:28 | 03:37 | 7.90 | 0.79 | 10.05 | 9m | MoveFlip |  |
| 6 | BUY | CONTINUATION | 05:26 | 05:36 | 9.20 | 0.92 | 13.35 | 10m | MoveFlip |  |
| 7 | SELL | CONTINUATION | 06:11 | 06:12 | -2.60 | -0.26 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 8 | BUY | CONTINUATION | 07:30 | 07:34 | -0.40 | -0.04 | 1.75 | 4m | ThesisFailure |  |
| 9 | SELL | CONTINUATION | 08:43 | 08:46 | 1.30 | 0.13 | 2.25 | 3m | BestOutcome harvest |  |
| 10 | BUY | CONTINUATION | 09:03 | 09:04 | -0.90 | -0.09 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 11 | SELL | CONTINUATION | 09:11 | 09:16 | 1.40 | 0.14 | 2.75 | 5m | PeakProtection |  |
| 12 | BUY | CONTINUATION | 09:29 | 09:30 | -0.60 | -0.06 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 13 | SELL | CONTINUATION | 10:52 | 10:54 | -3.40 | -0.34 | 0.00 | 2m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 14 | BUY | CONTINUATION | 11:03 | 11:06 | -2.40 | -0.24 | 1.85 | 3m | MoveFlip |  |
| 15 | SELL | CONTINUATION | 11:43 | 11:45 | -1.60 | -0.16 | 0.25 | 2m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 16 | BUY | CONTINUATION | 11:52 | 11:56 | 2.60 | 0.26 | 5.45 | 4m | PeakProtection |  |
| 17 | SELL | CONTINUATION | 12:08 | 12:09 | -3.10 | -0.31 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 18 | BUY | CONTINUATION | 12:14 | 12:16 | -2.40 | -0.24 | 0.00 | 2m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 19 | SELL | CONTINUATION | 12:52 | 12:54 | -1.90 | -0.19 | 0.00 | 2m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 20 | BUY | BREAKOUT | 13:08 | 13:11 | -2.20 | -0.22 | 0.00 | 3m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 21 | SELL | FADE | 13:12 | 13:14 | -0.40 | -0.04 | 1.15 | 2m | ReversalStop | Fast fail (2m) · ReversalStop |
| 22 | BUY | BREAKOUT | 13:22 | 13:31 | 19.20 | 1.92 | 19.45 | 9m | Target |  |
| 23 | SELL | FADE | 13:37 | 13:41 | -6.30 | -0.63 | 0.00 | 4m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 24 | BUY | BREAKOUT | 13:57 | 14:01 | 2.80 | 0.28 | 8.05 | 4m | MoveFlip |  |
| 25 | SELL | CONTINUATION | 14:13 | 14:14 | 0.10 | 0.01 | 0.35 | 1m | ThesisFailure |  |
| 26 | BUY | CONTINUATION | 14:28 | 14:29 | -2.40 | -0.24 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 27 | SELL | CONTINUATION | 15:35 | 15:46 | 1.30 | 0.13 | 4.95 | 11m | PeakProtection |  |
| 28 | BUY | CONTINUATION | 17:55 | 18:00 | -3.90 | -0.39 | 1.25 | 5m | ThesisFailure |  |
| 29 | SELL | CONTINUATION | 18:09 | 18:13 | 1.20 | 0.12 | 2.15 | 4m | BestOutcome harvest |  |
| 30 | BUY | CONTINUATION | 18:50 | 18:52 | -0.30 | -0.03 | 0.35 | 2m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 31 | SELL | CONTINUATION | 19:36 | 19:37 | -1.70 | -0.17 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 32 | BUY | CONTINUATION | 20:04 | 20:08 | -2.70 | -0.27 | 0.00 | 4m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 33 | SELL | CONTINUATION | 22:21 | 22:23 | -1.80 | -0.18 | 0.00 | 2m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 34 | BUY | CONTINUATION | 23:56 | 23:57 | -2.00 | -0.20 | 0.00 | 1m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |

Full JSON: `scripts/reports/gold-2026-09-02-backtest.json`
