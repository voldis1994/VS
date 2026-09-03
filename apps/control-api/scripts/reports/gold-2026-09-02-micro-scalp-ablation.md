# Ablation — micro-SCALP (NONE 1m impulse)

Gold 2026-09-02 · lot 0.1 · spread 0.5 · live CONTINUATION policy (`no_impulse`)

**Question:** what if we also catch micro moves when setup is NONE, managed as SCALP?

| Metric | Live (ARMED only) | + micro-SCALP | Δ |
| --- | ---: | ---: | ---: |
| Trades | 8 | **38** | +30 |
| Wins / Losses | 4 / 4 | 10 / 28 | |
| P&L | **£+1.45** | **£−1.53** | **−£2.98** |
| Wrong entries | 3 (38%) | 24 (63%) | +21 |
| Playbooks | LONG 3 / FADE 3 / SCALP 2 | SCALP 31 / LONG 4 / FADE 3 | |

## Micro-only slice (NONE path)

| | |
| --- | ---: |
| Extra trades | 28 |
| Extra P&L | **£−2.47** |
| Wrong among them | 19 |
| Typical exit | ThesisFailure 1–2m · 0 MFE |

A few real scalps exist (e.g. BUY 05:25 **+£1.12**, SELL 03:12 **+£0.49**), but the noise flood dominates — same pattern as the old overnight NONE chop / IMPULSE CONTINUATION spam.

## Verdict

**Do not ship.** Live ARMED-only + no_impulse stays. Micro-move NONE entries are not “kārtīgs scalpings” on this day — they reopen the 0-MFE flip machine.

If we want scalps later: need a **stricter micro filter** (min MFE expectation / persistence / local range), not raw `allowNoneImpulse`.

Flag: `npx tsx scripts/goldDayBacktest.ts --micro-scalp`
