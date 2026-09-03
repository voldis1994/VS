# Ablation — IMPULSE CONTINUATION

Gold 2026-09-02 · Yahoo GC=F 1m · lot 0.1 · spread 0.5 · strict quality gates

| Metric | Strict (default) | No impulse CONT | Narrow mid-leg | Δ vs strict |
| --- | ---: | ---: | ---: | ---: |
| Trades | 34 | **8** | **8** | −26 |
| Wins / Losses | 12 / 22 | 4 / 4 | 4 / 4 | |
| P&L | **£−0.38** | **£+1.45** | **£+1.45** | **+£1.83** |
| Wrong entries | 19 (56%) | 3 (38%) | 3 (38%) | −16 |
| CONTINUATION trades | 29 | 3 | 3 | −26 |
| CONTINUATION P&L | £−1.69 | £−0.34 | £−0.34 | |

## What each mode does

| Mode | Flag | Behavior |
| --- | --- | --- |
| **default** | (none) | Arms `IMPULSE UP/DOWN → CONTINUATION` + tip-zone rides + mid-leg |
| **no_impulse** | `--no-impulse-cont` | Drops raw impulse CONTINUATION arm/entry. Keeps mid-trend CONT, tip-zone CONT, BREAKOUT, FADE |
| **narrow_midleg** | `--narrow-midleg` | Only `CONTINUATION up/down ·` / `mid-swing` with bias match, not tip/floor, not climax. Also drops tip-zone “Rally/Dump through” arms |

## Verdict

Removing **IMPULSE → CONTINUATION** flips the day from **£−0.38 → £+1.45**.

On this sample, **no_impulse** and **narrow_midleg** produce the **same 8 trades / same P&L** (trade #1 differs only in arm text: tip-zone “Dump through low” vs mid-swing — same fill/exit). Extra narrow filters did not change the day further.

**Shipped live:** `LIVE_CONTINUATION_POLICY = 'no_impulse'` in `marketSetup.ts` + robot desk. Backtest default matches live (`--impulse-cont` restores legacy).

## Remaining losses (live / no_impulse)

| # | Side | Setup | £ | Note |
| --- | --- | --- | ---: | --- |
| 3 | SELL | mid-swing CONT | −0.19 | 0 MFE ThesisFailure |
| 4 | BUY | mid-swing CONT | −0.24 | MoveFlip |
| 5 | SELL | FADE | −0.04 | ReversalStop |
| 7 | SELL | FADE | −0.63 | EarlyCut (main leftover) |

Winner trade: BREAKOUT BUY 13:22 **+£1.92**.

Full JSON: `gold-2026-09-02-backtest-{strict,no-impulse-cont,narrow-midleg}.json`
