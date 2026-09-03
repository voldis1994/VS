# Gold backtest — 2026-09-02 (1m) · micro-strict-loose

Source: **Yahoo Finance GC=F** (public). Lot **0.1**. Spread **0.5**.
Mode: **live + micro-chop (strict filter, SCALP book, loose gates)**.
PnL: **£0.10 / point** (£1/pt @ 1.0 lot).

## Result

| Metric | Value |
| --- | --- |
| Bars | 1379 |
| Trades opened | **20** |
| Wins / Losses / Flat | 8 / 12 / 0 |
| Total P&L | **£-0.56** |
| Avg / trade | £-0.03 |
| Wrong entries | **9** (45%) |
| Missed candidates (shadow) | **74** |
| Unnecessary blocks | **25** (33.8%) |
| £ left on table (unnecessary) | **£8.81** |

## Unnecessary blocks

Shadow = ja būtu iegujuši ar to pašu exit smadzenēm. Unnecessary = shadow peļņa > £0.05 un MFE ≥ 0.8pt.

- **13×** same-side dead BUY until flip (flow UP) · no spam re-entry
- **7×** same-side dead SELL until flip (flow DOWN) · no spam re-entry
- **2×** post-exit cool-down 240s · quality over frequency
- **1×** post-exit cool-down 120s · quality over frequency
- **1×** post-exit cool-down 180s · quality over frequency
- **1×** reverse blocked · need V-flip UP after SELL exit (have none)


### By category

- **post_exit**: 74 blocked · **25** unnecessary

## Wrong entries — main reasons

- **9×** Loss with no real MFE run (<0.8pt) — wrong side / late


## Exit reasons

- **9×** MoveFlip
- **5×** PeakProtection
- **4×** EarlyCut
- **1×** ThesisFailure
- **1×** Target

## Setups

- **13×** CONTINUATION
- **5×** FADE
- **2×** BREAKOUT

## Trades

| # | Side | Setup | Entry UTC | Exit UTC | Pts | £ | MFE | Hold | Exit | Wrong |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | SELL | CONTINUATION | 01:01 | 01:06 | 4.60 | 0.46 | 8.95 | 5m | PeakProtection |  |
| 2 | BUY | CONTINUATION | 02:37 | 02:51 | -6.30 | -0.63 | 0.00 | 14m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 3 | SELL | CONTINUATION | 03:02 | 03:08 | -1.20 | -0.12 | 1.45 | 6m | MoveFlip |  |
| 4 | BUY | FADE | 03:37 | 03:40 | 2.60 | 0.26 | 4.75 | 3m | PeakProtection |  |
| 5 | SELL | CONTINUATION | 04:17 | 04:22 | -0.50 | -0.05 | 0.35 | 5m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 6 | BUY | CONTINUATION | 05:16 | 05:19 | -2.30 | -0.23 | 0.45 | 3m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 7 | SELL | CONTINUATION | 09:25 | 09:28 | -2.40 | -0.24 | 0.45 | 3m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 8 | BUY | CONTINUATION | 09:40 | 09:44 | -0.70 | -0.07 | 1.45 | 4m | MoveFlip |  |
| 9 | SELL | CONTINUATION | 10:02 | 10:10 | 2.40 | 0.24 | 4.75 | 8m | MoveFlip |  |
| 10 | BUY | CONTINUATION | 10:17 | 10:23 | 1.00 | 0.10 | 2.75 | 6m | PeakProtection |  |
| 11 | SELL | CONTINUATION | 10:52 | 10:54 | -3.40 | -0.34 | 0.00 | 2m | MoveFlip | Loss with no real MFE run (<0.8pt) — wro |
| 12 | BUY | CONTINUATION | 11:03 | 11:06 | -2.40 | -0.24 | 1.85 | 3m | MoveFlip |  |
| 13 | SELL | FADE | 11:58 | 12:04 | -5.20 | -0.52 | 0.65 | 6m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 14 | BUY | CONTINUATION | 12:14 | 12:16 | -2.40 | -0.24 | 0.00 | 2m | ThesisFailure | Loss with no real MFE run (<0.8pt) — wro |
| 15 | SELL | FADE | 13:11 | 13:14 | 1.40 | 0.14 | 2.95 | 3m | PeakProtection |  |
| 16 | BUY | BREAKOUT | 13:22 | 13:31 | 19.20 | 1.92 | 19.45 | 9m | Target |  |
| 17 | SELL | FADE | 13:37 | 13:41 | -6.30 | -0.63 | 0.00 | 4m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 18 | BUY | BREAKOUT | 13:52 | 14:01 | 2.70 | 0.27 | 7.95 | 9m | MoveFlip |  |
| 19 | SELL | FADE | 14:03 | 14:05 | -7.30 | -0.73 | 0.00 | 2m | EarlyCut | Loss with no real MFE run (<0.8pt) — wro |
| 20 | BUY | CONTINUATION | 14:19 | 14:21 | 0.90 | 0.09 | 2.15 | 2m | PeakProtection |  |

Full JSON: `scripts/reports/gold-2026-09-02-backtest-micro-strict-loose.json`
