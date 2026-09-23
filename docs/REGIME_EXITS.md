# Per-regime exits (Capital desk)

Entry is precise per regime → exit must follow the **same thesis**, not one universal Soft/Peak/Target stack.

## Freeze at fill

On order fill (`enterTrade` / pipeline attach):

| Field | Purpose |
|-------|---------|
| `entry_regime` | Soft/Peak/Target/structure use this — live classify flicker must not rewrite exit |
| `entry_setup` | PULLBACK / BREAKOUT / FADE / … |
| `entry_zone` | hi/lo/mid/width for structure invalidation |

## Families

| Family | Regimes | Soft | Peak arm | Target | TimeDecay | Structure kill |
|--------|---------|------|----------|--------|-----------|----------------|
| trend | TREND_* | 1.0× | reverse 1m | 1.15× | 14m | — |
| pullback | PULLBACK_* | 0.9× | reverse 1m | 1.05× | 11m | — |
| break | BREAKOUT_* | 0.85× | reverse 1m | 1.2× | 12m | back inside zone |
| break_fail | FAILED_* | 1.0× | reverse **or** mid | 0.55× | 7m | reclaim failed edge |
| fade | RANGE | 1.15× | reverse **or** mid | 0.55× | 7m | through zone mid |
| expansion | EXPANSION | 1.0× | reverse 1m | 0.95× | 9m | — |
| reversal | REVERSAL_* | 0.75× | fast (MFE>0) | 0.8× | 5m | — |
| chop | COMPRESSION / TRANSITION / UNKNOWN | 0.95× | fast | 0.55× | 5m | — |

Abs floors still go through `scaleDeskAbs(entry/REF)` — one calibration, all markets.

## Structure invalidation

Faster than Soft (8s grace / 3s confirm):

- **BREAKOUT_UP BUY** — mid back under zone hi  
- **BREAKOUT_DOWN SELL** — mid back above zone lo  
- **RANGE fade** — price walks through zone mid against fade  
- **FAILED_BREAKOUT_UP SELL** — reclaim above failed hi  
- **FAILED_BREAKOUT_DOWN BUY** — reclaim below failed lo  

## SAFETY TP (broker)

Opposite of SAFETY SL / Soft HardInv on the **profit** side:

- Attached at open as Capital `profitLevel` / `profitDistance`
- Distance = **max**(desk Target, SAFETY_SL × **1.5**, Soft HardInv × 1.5)
- **Never TP < SL** (RANGE/chop soft Target alone used to invert R:R)
- Soft Peak / Target / TimeDecay still manage earlier exits
- If Capital rejects TP → SL-only fallback (never naked)

Code: `safetyTakeProfitDistance` in `exitManage.ts` · wired in `robotDesk` + `intentFanout`.
