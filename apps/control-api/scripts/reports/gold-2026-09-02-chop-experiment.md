# Experiment — can chop still print?

Gold 2026-09-02 · lot 0.1 · live CONTINUATION (`no_impulse`) + optional NONE→micro

**Question:** chop machine var atnest peļņu, ja filtrējam?

| Mode | Trades | W/L | P&L | Wrong | Micro N | Micro £ | vs live |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Live (ARMED only)** | 8 | 4/4 | **£+1.45** | 3 | 0 | £0 | — |
| micro raw SCALP | 38 | 10/28 | £−1.53 | 24 | 28 | £−2.47 | −£2.98 |
| micro raw LONG | 38 | 10/28 | £−1.53 | 24 | 28 | £−2.47 | −£2.98 |
| micro hour | 10 | 4/6 | £+1.18 | 4 | 2 | £−0.12 | −£0.27 |
| micro impulse | 30 | 8/22 | £−1.15 | 18 | 17 | £−1.62 | −£2.60 |
| micro persist | 8 | 4/4 | £+1.45 | 3 | 0 | £0 | £0 |
| micro room | 34 | 10/24 | £−0.70 | 21 | 26 | £−2.10 | −£2.15 |
| micro cooldown | 36 | 9/27 | £−1.72 | 22 | 25 | £−2.39 | −£3.17 |
| micro strict | 8 | 4/4 | £+1.45 | 3 | 0 | £0 | £0 |
| micro strict+loose | 20 | 8/12 | £−0.56 | 9 | 0 | £0 | −£2.01 |

## What we learned

1. **Raw chop loses** — micro-only slice £−2.47 (6 winners £+2.38 vs 22 losers £−4.85).
2. **LONG vs SCALP book** — identical on this day; exit book is not the issue, **entries** are.
3. **Best soft filter = hour bias** — only 2 micro entries, still **−£0.12**; day £+1.18 (worse than live).
4. **Strict / persist** — kill all micro → same as live. No free lunch.
5. **Oracle:** if we only kept MFE≥2 micros, that slice is £+2.38 — but we cannot know MFE at entry. No tested filter selects those 6 without the 22 losers.

## Verdict

On this Gold day, **chop does not beat ARMED-only live**. Soft filters either still lose or collapse back to live. Do **not** enable `allowNoneImpulse` yet.

Flags:
```
npx tsx scripts/goldDayBacktest.ts --micro-filter=raw|hour|impulse|persist|room|cooldown|strict
npx tsx scripts/goldDayBacktest.ts --micro-filter=hour --micro-book=LONG
```
