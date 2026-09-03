# 1m dump-ride — same-side resume + longDump arm

Gold 2026-09-02 · lot 0.1

| Mode | Trades | P&L | Wrong |
| --- | ---: | ---: | ---: |
| Prior live (#311) | 8 | **£+2.58** | 3 |
| **This** | 8 | **£+2.58** | 3 |

## Live bug (user 10:00–11:30 Gold dump)

Clear 1m dump ~4440→4420. Desk took **2 tiny trades** then sat FLAT for hours.

Root causes:
1. After SELL exit, **same-side dead until flow UP** — dump continues DOWN → forever flat.
2. Mid-swing arm needed **stickyWide** + **!at_floor** — live swing hugs the dump floor → NONE.

## Fix (1m/10s desk, not 1h)

1. **Same-side resume** after soft harvest (`PeakProtection` / `Target` / …) when flow still agrees + mid-swing/flow-flip CONT + **2m** wait. EarlyCut / tip-blip IMPULSE still blocked.
2. **longDump / longRally arm** — `marketTrend` + ≥3pt local run + persist, without overnight stickyWide.
3. **at_floor / at_tip** — block only when local range has no room left (live swing hug).

## Rejected

Blank same-side continue on any CONT → £0.63 / 21 trades spam.
Proven-dump without trend filter → £1.75.
