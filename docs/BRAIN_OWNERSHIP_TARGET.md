# Smadzenes ownership — mērķa saraksts

Politika: **viss treidings → smadzenes**.  
**Ārpusē tikai:** (1) `lot_size` · (4) Capital dealing-rules · (5) sistēma (infra/ops).

SAFETY SL cushion un SAFETY TP R:R **iet uz smadzenēm** (treidinga riska forma, ne infra).

---

## 0. Smadzenes NEDRĪKST aiztikt (tikai šie)

| # | Kas | Kāpēc |
|---|---|---|
| 1 | `lot_size` | operators / riska kapitāls |
| 4 | Capital dealing-rules min stop / point size | broker API ierobežojums — nevar pārkāpt |
| 5 | Sistēma: session / cycle timers / busy locks / reconnect / DB ledger / WS / encryption / auth / account·epic routing | infra, ne treidings |

---

## 1. JĀBŪT uz smadzenēm — vēl NAV (pārlikt)

### Soft / Peak / Target (tagad desk)
| # | Kas | Tagad |
|---|---|---|
| 1 | Soft L1 / L2 / L3 abs | desk |
| 2 | Soft `hardinv_pct` | desk |
| 3 | Target L1 / L2 / L3 abs | desk |
| 4 | Target `target_pct` | desk |
| 5 | Peak `peak_mfe_abs` / `peak_mfe_pct` | desk |
| 6 | Peak `peak_retention` (viena Keep ar genome) | desk + max(genome) |
| 7 | Peak `peak_min_giveback_abs` | desk |
| 8 | Soft/Target layer percentile shape (p35/p60/p85) | hardcode auto-cal |
| 9 | Target stretch gate `0.85` | hardcode |
| 10 | Soft unlock floor clamp | hardcode |

### SAFETY (tagad hardcode / desk — tagad UZ smadzenēm)
| # | Kas | Tagad |
|---|---|---|
| 11 | SAFETY SL cushion (~0.20%, ≥2.5× min) | hardcode `robotDesk` |
| 12 | SAFETY TP R:R (`safety_tp_rr` + min floor 1.5) | desk + hardcode floor |

### Entry / regimes / Soft OFF
| # | Kas | Tagad |
|---|---|---|
| 13 | `entry_filter_level` 0–3 | desk |
| 14 | `enabled_regimes` | desk |
| 15 | `soft_off_regimes` | desk |
| 16 | Soft OFF strong bypass (`conf≥0.7`, HTF counts) | hardcode |
| 17 | structureEntry EXTREME / START / tip / chase bands | hardcode + codePatches |
| 18 | structure trek flat (`mid*0.0007`) | hardcode ≠ genome trek |
| 19 | marketStory PATH / CHASE / CONF_MIN | hardcode |
| 20 | regimes.ts TREND-from-trek (0.35 / 0.4 / ×4 / ×2) | hardcode |
| 21 | Zone bars (ZONE=180, MIN=90), switch gap | hardcode |
| 22 | flipFilter same-dir lock ms | hardcode + codePatches |

### Exit overlays
| # | Kas | Tagad |
|---|---|---|
| 23 | visa `regimeExitProfile` (hardinv/target/peak/timedecay/structure) | hardcode tabula |
| 24 | Soft-exit market gate policy | hardcode |
| 25 | Soft HardInv grace / confirm ms | hardcode |
| 26 | Structure grace / confirm ms | hardcode |
| 27 | TimeDecay min hold / min fav floors | hardcode |
| 28 | `HARDINV_ABS_FLOOR` / layer Soft overlays | hardcode |
| 29 | Soft+ story-fight bank `exec≥soft*0.95` | hardcode |
| 30 | Pressure fight green_share 0.38 / 0.62 | hardcode |

### Mind / manage
| # | Kas | Tagad |
|---|---|---|
| 31 | Mind Soft+ CUT Soft× 0.75 / 0.85 / 0.95 | hardcode + patches |
| 32 | Mind Soft+ retention bank 0.55 | hardcode + patches |
| 33 | Mind entry confidence ladders | hardcode |
| 34 | Hardcoded 1m fight veto (paralēli genome) | hardcode |
| 35 | manageBrain score weights / green_share | hardcode |

---

## 2. JĀBŪT uz smadzenēm — IR genome, bet SI NEEVOLVĒ (wire)

| # | Atslēga | Status |
|---|---|---|
| 36 | `peak_trail_soft_cap_mult` | stuck factory — wire hypothesize |
| 37 | `story_fight_peak_arm_soft_mult` | stuck factory — wire hypothesize |
| 38 | `entry_chop_conf_max` | dead — wire vai izmest |
| 39 | `soft_plus_runner_mult` | tikai auto-cal → Brain explore |
| 40 | `soft_plus_leg_mult` | tikai auto-cal → Brain explore |
| 41 | `soft_layer_unlock_mult` | tikai auto-cal → Brain explore |
| 42 | `pullback_episode_*` (×3) | tikai auto-cal → Brain explore |
| 43 | `mtf_htf_veto` | vienvirziena → bidirectional explore |

---

## 3. Jau uz smadzenēm (OK — paturēt)

| Grupā | Atslēgas |
|---|---|
| Peak Soft× | `peak_keep`, `peak_arm_soft_mult`, `soft_plus_giveback`, `mind_bank_on_turn` |
| Entry gates | `require_1m_trigger`, `wait_on_1m_fight`, `soft_same_side_pause_*` |
| Regime ladder | visi `regime_*` body/persist/dwell/mom + RANGE chop |
| Multi-TF | `mtf_trek_flat_frac`, `mtf_block_higher_fight`, `mtf_require_aligned_side`, `entry_story_conf_min` |

---

## 4. Auto-cal loma pēc pārlikšanas

Auto-cal = **ieteikums smadzenēm** (raksta genome kandidātu), nevis paralēla Soft/Target “otra smadze” uz desk.
Desk abs knobs → genome abs knobs; operators redz genome.

Capital dealing min stop paliek **clamp** virs genome SAFETY (nevar iet zem broker min) — tas ir #4, ne genome evolūcija.

---

## 5. Darba secība (kad apstiprina)

1. Wire stuck Soft× keys (36–43)  
2. Soft/Peak/Target abs → genome (1–10)  
3. SAFETY SL/TP → genome (11–12) — ar dealing-rules clamp  
4. regimeExitProfile → genome (23)  
5. structure + story + TREND-trek → genome (17–21)  
6. Soft-exit gate + grace/TimeDecay → genome (24–27)  
7. Mind CUT / manage weights → genome (31–35); beigt codePatches  
8. Soft OFF / entry_filter / regimes ON-OFF → genome (13–16)  
9. Auto-cal → genome-only propose
