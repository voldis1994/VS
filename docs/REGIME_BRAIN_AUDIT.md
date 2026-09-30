# Režīmu audits — smadzenes vs virsū + konflikti

Datums: 2026-09-30 · branch `cursor/genome-hardcode-cohesion-e06a`

Politika: viss treidings → smadzenes. Ārpusē: lot · dealing-rules · sistēma.

---

## A. Ko smadzenes PĀRVALDA (OWNED) — 22 knobs

**Body/range/trek skalā = bp (1 bp = 0.0001 frac).** Min solis **0.1** — nekad `0.00008` (round→0). Live: `regimeBpToFrac()`.

| # | Genome atslēga | Default (bp) | Live frac | Loma |
|---|---|---|---|---|
| 1 | `regime_move` | 0.8 | 0.00008 | Persist / failed-break tick |
| 2 | `regime_trend_stay` | 2.2 | 0.00022 | Palikt trend |
| 3 | `regime_trend_enter` | 3.8 | 0.00038 | Jauns trend / breakout body |
| 4 | `regime_pullback` | 5.5 | 0.00055 | Pret-trend pullback body |
| 5 | `regime_reversal` | 16 | 0.0016 | Violent reverse |
| 6 | `regime_move_range` | 1.2 | 0.00012 | isMoving range |
| 7 | `regime_compress_abs` | 0.6 | 0.00006 | Compression abs |
| 8 | `regime_expand_abs` | 6 | 0.0006 | Expansion abs |
| 9 | `regime_compress_avg_mult` | 0.35 | Compress vs avg |
| 10 | `regime_expand_avg_mult` | 1.65 | Expand vs avg |
| 11 | `regime_near_zone_mid` | 0.28 | Near mid |
| 12 | `regime_clear_break_frac` | 0.25 | Clear pierce |
| 13 | `regime_persist_enter` | 0.5 | Enter persist |
| 14 | `regime_persist_stay` | 0.3 | Stay persist |
| 15 | `regime_persist_pullback` | 0.2 | Pullback persist |
| 16 | `regime_range_chop_persist_max` | 0.25 | Positive RANGE persist |
| 17 | `regime_range_trek_share_max` | 0.32 | Positive RANGE trekShare |
| 18 | `regime_range_trek_eff_max` | 0.45 | Positive RANGE trekEff |
| 19 | `regime_min_dwell_bars` | 5 | Soft switch dwell |
| 20 | `regime_confirm_bars` | 3 | Cross-family confirm |
| 21 | `regime_mom_bars` | 8 | Momentum window |
| 22 | `regime_persist_window` | 6 | Persist window |

Ladder atstarpes (bp): GAP_MOVE_STAY / STAY_ENTER / ENTER_PULLBACK = **1.0**; GAP_PULLBACK_REVERSAL = **5.0**; GAP_COMPRESS_EXPAND = **3.5**.  
Smadzeņu explore: `bounceBp` solis ≥ 0.1 (ne `bounceFrac` 0.00001).

---

## B. Kas sēž VIRSŪ smadzenēm (MOVE)

### Hardcode `regimes.ts`
| # | Kas | Vērtība |
|---|---|---|
| 1 | `ZONE_BARS` / `MIN_BARS_FOR_ZONE` | 180 / 90 |
| 2 | TREND-from-trek full | \|trek\|≥ENTER×4, share≥**0.35**, eff≥**0.4** |
| 3 | TREND-from-trek recent leg | \|leg\|≥ENTER×2, share≥**0.25** |
| 4 | Soft MOVE pullback on trek | lastVel < -MOVE (ne PULLBACK) |
| 5 | Local shelf frac | max(0.12, CLEAR×0.5) |
| 6 | `SWITCH_GAP_BARS` | 2 |
| 7 | Chop→trend strong (skip dwell+gap) | 1-bar flash |
| 8 | Structure flip skip gap | BREAKOUT/FAILED/REVERSAL |
| 9 | Sticky prior fall-through | ne-chop → keep previous |
| 10 | `TRANSITION` nekad netiek classify | phantom |

### Desk / Soft OFF
| # | Kas |
|---|---|
| 11 | `enabled_regimes` Hard OFF |
| 12 | `soft_off_regimes` + auto-cal demote |
| 13 | Soft OFF strong bypass conf≥0.7 |
| 14 | `CORE_ALWAYS_ON` incl. TRANSITION |
| 15 | `MIN_ENABLED_REGIMES=5` refill |

### Playbook / entry (pārraksta live label)
| # | Kas |
|---|---|
| 16 | `pickEntryPlaybook` promote RANGE/COMPRESSION → TREND/BREAKOUT |
| 17 | `effectiveEntryRegime` Soft OFF + entry uz promoted |
| 18 | structureEntry bands per regime |
| 19 | minuteTrendBias trek `mid×0.0007` ≠ genome |

### Exit — visa `regimeExitProfile` tabula
| # | Kas |
|---|---|
| 20 | hardinv/target/peak/timedecay/structure per family — hardcode |

---

## C. Konflikti — viens režīms pārraksta otru

### CRITICAL

**C1. RANGE ↔ TREND — trek hardcode vs genome RANGE chop**  
- Trek prove: share≥0.35, eff≥0.4 **pirms** RANGE share≤0.32, eff≤0.45  
- Atstarpe share tikai **0.03**; eff **overlap [0.40–0.45]**  
- Genome var celt RANGE max līdz 0.55/0.7 → caurums pazūd → TREND first-match nozog RANGE  

**C2. Soft MOVE trek-pullback ↔ PULLBACK ladder**  
- Trek path: `lastVel < -MOVE` + under mid → PULLBACK  
- Normal path prasa `≥PULLBACK` (0.00055)  
- Body (MOVE…PULLBACK) → PULLBACK bez ladder atstarpes  

**C3. Playbook promote vs live classify**  
- Live=RANGE, HTF/story → entry TREND/BREAKOUT  
- Soft OFF atslēgas uz **promoted**, ne live → dubulta patiesība  

**C4. Desk Soft OFF / enabled vs brain classify**  
- Brain saka TREND; desk Soft OFF → starve (vai strong bypass)  
- Otra “smadze” uz allowlist  

### HIGH

**C5. recentLeg share≥0.25 nozog RANGE** (RANGE max 0.32 overlap)  

**C6. Bare EXPANSION pirms TREND** — `if (expanding) return EXPANSION` pirms persist TREND → vol nozog direction  

**C7. Chop→trend 1-bar flash** — skip dwell+SWITCH_GAP; recentLeg false positive → instant RANGE→TREND  

**C8. BREAKOUT/FAILED/REVERSAL pierce** skip gap pēc chop→trend → chain vienā svecē  

**C9. TRANSITION phantom** — nekad classify, bet ON desk/core/exit CHOP  

**C10. Genome GAP 0.0001 << factory Gold** — MOVE≈STAY≈ENTER → one-candle-all-regimes  

### MEDIUM

**C11. COMPRESSION ↔ RANGE** — shared CHOP family, thin abs; entry abi FADE  

**C12. Sticky prior** — failed tip keep TREND forever, bloķē RANGE  

**C13. Math.max peak retention** — fade/chop/failed profile 0.7 overrides genome Keep  

**C14. Unscoped pipeline stamp** — hard overwrite book bez stabilize  

---

## D. regimeExitProfile — vienādi iestatījumi (nav diferenciācijas)

| Shared profile | Režīmi | Problēma |
|---|---|---|
| `TREND` | TREND_UP + TREND_DOWN | OK (spoguļi) |
| `PULLBACK` | PULLBACK_UP + PULLBACK_DOWN | OK |
| `BREAKOUT` | BREAKOUT_UP + BREAKOUT_DOWN | OK |
| `FAILED_BREAK` | FAILED_UP + FAILED_DOWN | OK |
| **`CHOP`** | **UNKNOWN + COMPRESSION + TRANSITION** | **identiski** Soft/Peak/Target/TimeDecay — nav atstarpes |
| `RANGE_FADE` | RANGE | structure through_mid |
| `EXPANSION` | EXPANSION | gandrīz = TREND (1.1 vs 1.15, 9m vs 14m) |
| `REVERSAL` | REVERSAL_CANDIDATE | |

**Gandrīz identiski (collapse):**
- FAILED_BREAK ≈ RANGE_FADE — abi reverse_or_mid, Keep 0.7, hold 7m; atšķiras tikai structure + hardinv 0.95 vs 1.0
- REVERSAL ≈ CHOP — abi peak_arm fast, hold 5m, Keep 0.7

---

## E. classifyRegime secība (live)

```
FAILED → BREAKOUT → REVERSAL → PULLBACK → resume TREND
  → EXPANSION → persist TREND → trek TREND/PULLBACK
  → COMPRESSION → positive RANGE → sticky prior → UNKNOWN
```
**TRANSITION nekad netiek piešķirts.**

---

## F. Prioritāte

1. Genome-own TREND-from-trek + assert vs RANGE chop (C1, C5)
2. Kill soft MOVE trek-pullback (C2)
3. Viena režīma patiesība Soft OFF + entry — promote ≠ live (C3, C4)
4. EXPANSION vs TREND priority (C6)
5. Chop→trend confirm / gap (C7, C8)
6. regimeExitProfile → genome + split CHOP (D)
7. Raise GAP_* + remove phantom TRANSITION (C9, C10)
8. Sticky TTL + pipeline stabilize (C12, C14)
