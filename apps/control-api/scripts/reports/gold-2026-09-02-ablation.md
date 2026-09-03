# Ablation — remove candle / climax filters

Gold 2026-09-02 · lot 0.1 · spread 0.5

| Metric | Strict (current) | Loose (filters off) | Δ |
| --- | ---: | ---: | ---: |
| Trades | 34 | 76 | +42 |
| Wins / Losses | 12 / 22 | 33 / 42 | |
| P&L | **£-0.38** | **£-2.67** | **-£2.29** |
| Wrong entries | 19 (56%) | 34 (45%) | +15 |

**Loose turns off:** closed-candle color, 2-bar momentum, spike-wait, against-move / local climax.

**Still on:** ARMED-only, structure tip/floor, MoveFlip→reverse next 1m, sticky-trend fight.

## Verdict
Removing those filters **opens more trades but loses more money** on this day. The “unnecessary” shadows overstated edge — many would overlap / chop when actually taken.
