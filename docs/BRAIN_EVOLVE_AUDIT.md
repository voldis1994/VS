# Smadzenes — ko EVOLVĒ / ko NEEVOLVĒ (pilnais audits)

Datums: 2026-09-30 · branch `cursor/genome-hardcode-cohesion-e06a`

## Īsumā

Brain Self Improve (`hypothesize` + genome ACCEPT) pārklāj Peak Soft× atmiņu + regime ladder + daļu multi-TF.
**Lielākā daļa Soft/Target abs, per-regime exit, Soft-exit gate, structure zones un Mind CUT sliekšņi smadzenes NEEVOLVĒ** — tos tur desk auto-cal, hardcoded tabulas vai `codePatches`.

---

## A. Ko smadzenes EVOLVĒ

| Grupā | Atslēgas | Kas mutē | ACCEPT |
|---|---|---|---|
| Peak/Soft atmiņa | `peak_keep`, `peak_arm_soft_mult`, `soft_plus_giveback`, `require_1m_trigger`, `wait_on_1m_fight`, `mind_bank_on_turn`, `soft_same_side_pause_*` | hypothesize | PEAK_MEMORY (E-flat OK) |
| Regime ladder | visi `regime_*` body/persist/dwell/mom + RANGE chop | hypothesize explore | TRADING_INTEL (jāuzlabo E) |
| Multi-TF / story | `mtf_trek_flat_frac`, `mtf_block_higher_fight`, `mtf_require_aligned_side`, `entry_story_conf_min` | hypothesize explore | TRADING_INTEL |
| Meta | `explore_step`, `version`, `last_lesson` | vienmēr | bookkeeping |

Avots: `brainGenome.ts` → `EVOLVABLE_GENOME_KEYS` / `TRADING_INTEL_GENOME_KEYS` / `PEAK_MEMORY_SAFE_KEYS`.

---

## B. Ko smadzenes NEEVOLVĒ

### B0. Genome atslēgas, kas IR sarakstā, bet Brain SI nekad nebounce

| Atslēga | Factory | Kas lieto live | Kas mutē |
|---|---|---|---|
| `peak_trail_soft_cap_mult` | 1.75 | Peak Soft× trail ceiling | **NEKAS** (stuck factory) |
| `story_fight_peak_arm_soft_mult` | 1.0 | Peak Soft× kad stāsts fights | **NEKAS** |
| `entry_chop_conf_max` | 0.45 | WAIT thesis swap | **NEKAS** (izņemts no TRADING_INTEL) |
| `soft_plus_runner_mult` | 1.5 | MindBank Soft+ runner | tikai **auto-cal** |
| `soft_plus_leg_mult` | 1.35 | MindBank Soft+ leg | tikai **auto-cal** |
| `soft_layer_unlock_mult` | 1.0 | Soft L2/L3 unlock | tikai **auto-cal** |
| `pullback_episode_enabled` | true | V-bounce episode | tikai **auto-cal** |
| `pullback_episode_peak_arm_soft_mult` | 1.0 | Episode Soft× Peak | tikai **auto-cal** |
| `pullback_episode_min_mfe_soft_mult` | 0.5 | Episode min Soft× MFE | tikai **auto-cal** |
| `mtf_htf_veto` | true | Mind HTF veto | auto-cal tikai **true** (vienvirziena) |

---

### B1. Desk-only (auto-cal / operators) — Soft / Target / Peak / entry

| Kas | Kur | Default | Smagums |
|---|---|---|---|
| Soft L1 / L2 / L3 abs (`soft_l*_abs`, `hardinv_abs`) | `deskCalibration.ts` | 1.2 / 1.8 / 2.2 | **CRITICAL** |
| Soft `hardinv_pct` | desk | 0.0008 | HIGH |
| Peak `peak_mfe_abs` / `peak_mfe_pct` | desk | 3.0 / 0.0009 | **CRITICAL** |
| Peak `peak_retention` | desk (sync → genome Keep) | 0.72 | **CRITICAL** — genome nevar atslābināt zem desk (`Math.max`) |
| Peak `peak_min_giveback_abs` | desk | 0.85 | HIGH |
| Target L1 / L2 / L3 abs | desk | 2.5 / 3.5 / 5.0 | **CRITICAL** |
| Target `target_pct` | desk | 0.0025 | HIGH |
| `safety_tp_rr` | desk | 1.5 | HIGH (broker-adjacent) |
| `entry_filter_level` 0–3 | desk → `tradeOpenPolicy.ts` | 0 OPEN | **CRITICAL** |
| `enabled_regimes` / `soft_off_regimes` | desk | visi tradable / [] | **CRITICAL** |
| Soft/Target layer percentile shape | `profitLayers.ts` p35/p60/p85 | hardcoded | HIGH |

---

### B2. Hardcoded overlays virs genome (live, bet Brain neredz)

| Kas | Kur | Vērtība | Smagums |
|---|---|---|---|
| **Visa `regimeExitProfile` tabula** | `regimeExitProfile.ts` | hardinv/target/peak/timedecay/structure per regime | **CRITICAL** |
| Soft-exit market gate | `softExitMarketGate.ts` | 1m continue / same next-entry → HOLD Peak/Target | **CRITICAL** |
| Soft HardInv grace/confirm | `exitManage.ts` | 12s / 5s | HIGH |
| Structure grace/confirm | `exitManage.ts` | 8s / 3s | HIGH |
| `HARDINV_ABS_FLOOR` / `CAP` | `exitManage.ts` | 1.5 / 2.2 | HIGH |
| Layered Soft overlays | `exitManage.ts` | `pct*(layer/3)`, `cap*1.3`, ×profile | **CRITICAL** |
| Target L1/L2 stretch `0.85` | `profitLayers.ts` | `mfe < dN*0.85` | HIGH |
| TimeDecay floors | `exitManage.ts` | 12m hold, fav≥2.0, `abs*0.00035`, `target*0.4` | HIGH |
| Soft+ story-fight bank `0.95` | `marketContext.ts` | `execFav ≥ soft*0.95` | HIGH |
| Pressure fight | `marketContext.ts` | green_share 0.38 / 0.62 | MEDIUM |
| **Mind Soft+ CUT sliekšņi** | `traderMind.ts` | Soft×0.75/0.85/0.95, retention 0.55 | **CRITICAL** |
| Mind entry conf ladders | `traderMind.ts` | 0.3–0.92 | HIGH |
| Hardcoded 1m fight veto | `traderMind.ts` | vienmēr ON (paralēli `wait_on_1m_fight`) | HIGH |
| manageBrain score weights | `manageBrain.ts` | ±0.15…0.95 | HIGH |
| Soft OFF strong bypass | `strongEntrySignal.ts` | conf≥0.7, HTF counts | HIGH |
| **structureEntry zones** | `structureEntry.ts` | EXTREME 0.85/0.15, START 0.65/0.35 | **CRITICAL** |
| structure trek flat | `structureEntry.ts` | `mid*0.0007` ≠ genome `mtf_trek_flat_frac` | HIGH |
| marketStory constants | `marketStory.ts` | PATH 0.0007, CHASE 0.12, CONF_MIN 0.4 | HIGH |
| **TREND-from-trek hardcodes** | `regimes.ts` | trekShare≥0.35, trekEff≥0.4, ×4/×2 | **CRITICAL** |
| Zone bars | `regimes.ts` | ZONE=180, MIN=90 | HIGH |
| flipFilter locks | `flipFilter.ts` | 90s / 90s | HIGH |
| Structure mid pierce | `regimeExitProfile.ts` | width×0.05 | HIGH |

---

### B3. Paralēlie kanāli (ne genome)

| Kanāls | Ko maina | Smagums |
|---|---|---|
| `codePatches` Soft spam | flipFilter lock ms, Mind retention snippet | HIGH |
| `codePatches` micro-scratch | `EXTREME_*` / `START_*` structureEntry | **CRITICAL** |
| `codePatches` bank green | Mind Soft×0.75→0.7, retention 0.55→0.65 | **CRITICAL** |
| Desk auto-cal | Soft/Peak/Target abs + filters + regimes + daļa genome | **CRITICAL** (otra “smadze”) |
| `entry_filter` ladder | flip/structure/same-dir bez genome | HIGH |

---

### B4. Apzināti ārpus Brain (broker / lot / safety)

| Kas | Piezīme |
|---|---|
| `lot_size` | operators |
| SAFETY SL ~0.20% / ≥2.5× min | vienmēr ON |
| SAFETY TP R:R floor 1.5 | desk var celt |
| Capital dealing min stop | broker rules |

---

## C. Prioritāte — ko LIKT uz genome nākamo

1. **Wire hypothesize** priekš `peak_trail_soft_cap_mult` + `story_fight_peak_arm_soft_mult` (live, bet stuck factory)
2. **`regimeExitProfile` knobs** → genome (hardinv/target/peak/timedecay/structure)
3. **structureEntry bands** → genome (beigās codePatches `.ts` rewrite)
4. **Mind Soft+ CUT** Soft×/retention → genome (beigās dual hard+codePatch)
5. **regimes.ts TREND-from-trek** → genome (RANGE chop jau ir)
6. Soft-exit gate policy knobs → genome
7. HardInv/Structure grace+confirm ms → genome/desk
8. Unify auto-cal-only Soft× (`runner/leg/unlock/pullback`) into hypothesize explore
9. `mtf_htf_veto` bidirectional + TRADING_INTEL, vai dzēst
10. `entry_chop_conf_max` evolvēt vai izmest
11. TimeDecay floors + Target stretch `0.85` → genome/desk

---

## Kohēzijas karte

```
Live Soft/Target abs     ← DESK auto-cal          ≠ genome
Live Soft× Peak / Keep   ← GENOME (+ desk max)    + hard clamps
Live per-regime exit     ← regimeExitProfile      ≠ genome
Live Soft-exit allow     ← softExitMarketGate     ≠ genome
Live entry zone bands    ← structureEntry+patches ≠ genome
Live regime body ladder  ← GENOME                 ✓
Live TREND-from-trek     ← HARDCODE regimes.ts    ≠ genome
Live Mind Soft+ CUT      ← HARD + codePatches     ≉ genome soft_plus_*
```
