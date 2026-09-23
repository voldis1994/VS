# Regimes

> **Capital live desk** uses TypeScript `classifyRegime` + `decideEntryWithStructure`
> (`apps/control-api/src/services/regimes.ts`, `entryFromRegime.ts`, `structureEntry.ts`).
> Full conditions + executability audit: **[REGIME_CONDITIONS_AUDIT.md](./REGIME_CONDITIONS_AUDIT.md)**.

Regime classification is also available via C++ `RegimeEngine` (`libs/regime-engine`) from `MarketState`. Config: `config/regimes.yaml` (primary horizon 10s). **FAILED_BREAKOUT_*** are live in TS; reserved / unused in C++ `classify()`.

## Structure entry (10s ↔ 1m)

Live Capital orders use `decideEntryWithStructure`:

1. `decideEntryFrom10sRegime` — 10s DIP/RALLY recipe for the current regime  
2. else `structureStartEntry` — zone **half** + closed **1m** color (from same 10s) + MOVING 10s  
3. `structureGate` — **per-regime** soft rules (all 14); block only extreme chase / wrong half  

**Exits** are also per-regime — see **[REGIME_EXITS.md](./REGIME_EXITS.md)** (`entry_regime` frozen at fill + structure invalidation + profile Soft/Peak/Target).

Executable defaults (Gold reality):
- TREND pullbacks allowed mid-zone (not only at LO)
- BREAKOUT must **pierce** zone hi/lo (mid-zone 0.55 was a fake breakout — rejected)
- EXPANSION follow only with impulse + correct half
- RANGE fades: correct **half** only
- COMPRESSION / TRANSITION / UNKNOWN: **wait-only** (no entry)
- FAILED_BREAKOUT: near the failed edge (upper half after failed up, etc.)
- Chase reject only in extreme ~15% of zone with-trend
- `minuteTrendBias` uses **trek** (hi−lo), not open→close net (V-bounce ≠ FLAT)

## Market story (cilvēcīgs 30m stāsts)

`readMarketStory` (`marketStory.ts`) reads ~30m of 1m candles from the same 10s book:

- swings (HH/HL vs LH/LL), net path, red/green count  
- chapters: SELLOFF, RALLY, BOUNCE_IN_SELL, DIP_IN_RALLY, BREAK_*, RANGE_CHOP, …  
- ENTRY WATCH shows `STĀSTS · …`; entry **blocks** directions that fight the story  

## Regime types

| Regime | Name | Typical conditions | Capital entry |
|--------|------|--------------------|---------------|
| `Unknown` | UNKNOWN | Insufficient structure | never |
| `Range` | RANGE | `in_range`, no strong trend | fade dip/rally |
| `TrendUp` | TREND_UP | Positive persistence + velocity | dip-buy only |
| `TrendDown` | TREND_DOWN | Negative persistence + velocity | rally-sell only |
| `PullbackUptrend` | PULLBACK_UPTREND | Prior TrendUp with adverse velocity | resume long on rally |
| `PullbackDowntrend` | PULLBACK_DOWNTREND | Prior TrendDown with adverse velocity | resume short on dip |
| `Compression` | COMPRESSION | Compressed volatility in range | **wait only (no entry)** |
| `Expansion` | EXPANSION | Expanding volatility | follow body |
| `BreakoutUp` | BREAKOUT_UP | Expansion + breakout + up | follow up |
| `BreakoutDown` | BREAKOUT_DOWN | Expansion + breakout + down | follow down |
| `FailedBreakoutUp` | FAILED_BREAKOUT_UP | Prior breakout up, back in range (TS) | fade sell |
| `FailedBreakoutDown` | FAILED_BREAKOUT_DOWN | Prior breakout down, back in range (TS) | fade buy |
| `ReversalCandidate` | REVERSAL_CANDIDATE | Violent adverse bar vs prior trend | reverse (rare) |
| `Transition` | TRANSITION | Leaving prior regime, unclear next | **never** |

## Classification logic (TS summary)

`classifyRegime()` priority:

1. Failed breakout (if previous was BREAKOUT_*)
2. Compression if compressed and in-range
3. Breakout up/down if expanding + breakout + direction
4. Expansion if expanding without clean breakout
5. Pullback variants when prior trend + adverse velocity
6. Trend up/down
7. Reversal candidate
8. Range
9. Otherwise Transition (if previous was meaningful) or Unknown

## RegimeState

- `current` / `previous`
- `confidence`
- `since` — timestamp of last change

## Transitions / entry

On Capital robot, after classification:

- `regimeAllowedForEntry` — operator allowlist (`desk-calibration.json`)
- `decideEntryFrom10sRegime` — setup + direction from the closed 10s bar
- Quiet bars (`!isMoving10s`) → WAIT

C++ **SetupEngine** only builds CONTINUATION/PULLBACK on trend/pullback regimes; other regimes are display/classifier-only on that path.

Primary decision horizon: `primary_horizon_ms: 10000`.
