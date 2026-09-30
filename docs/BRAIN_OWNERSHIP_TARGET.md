# Smadzenes ownership — mērķa saraksts

Politika: **viss treidings → smadzenes**.  
**Neskart:** lot size + sistēma (broker safety / infra / ops).

---

## 0. Smadzenes NEDRĪKST aiztikt

| # | Kas | Kāpēc |
|---|---|---|
| 1 | `lot_size` | operators / riska kapitāls |
| 2 | SAFETY SL cushion (~0.20%, ≥2.5× broker min) | broker drošība — ne Soft |
| 3 | SAFETY TP R:R hard floor vs broker min | broker drošība |
| 4 | Capital dealing-rules min stop / point size | broker API |
| 5 | Session / cycle timers, busy locks, reconnect | sistēma |
| 6 | DB ledger, WS emit, encryption, auth | sistēma |
| 7 | Account / epic / connection routing | sistēma |

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

### Entry / regimes / Soft OFF (tagad desk vai hard)
| # | Kas | Tagad |
|---|---|---|
| 11 | `entry_filter_level` 0–3 | desk |
| 12 | `enabled_regimes` | desk |
| 13 | `soft_off_regimes` | desk |
| 14 | Soft OFF strong bypass (`conf≥0.7`, HTF counts) | hardcode |
| 15 | structureEntry EXTREME / START / tip / chase bands | hardcode + codePatches |
| 16 | structure trek flat (`mid*0.0007`) | hardcode ≠ genome trek |
| 17 | marketStory PATH / CHASE / CONF_MIN | hardcode |
| 18 | regimes.ts TREND-from-trek (0.35 / 0.4 / ×4 / ×2) | hardcode |
| 19 | Zone bars (ZONE=180, MIN=90), switch gap | hardcode |
| 20 | flipFilter same-dir lock ms | hardcode + codePatches |

### Exit overlays (tagad hardcode)
| # | Kas | Tagad |
|---|---|---|
| 21 | visa `regimeExitProfile` (hardinv/target/peak/timedecay/structure) | hardcode tabula |
| 22 | Soft-exit market gate policy | hardcode |
| 23 | Soft HardInv grace / confirm ms | hardcode |
| 24 | Structure grace / confirm ms | hardcode |
| 25 | TimeDecay min hold / min fav floors | hardcode |
| 26 | `HARDINV_ABS_FLOOR` / layer Soft overlays | hardcode |
| 27 | Soft+ story-fight bank `exec≥soft*0.95` | hardcode |
| 28 | Pressure fight green_share 0.38 / 0.62 | hardcode |

### Mind / manage (tagad hardcode + codePatches)
| # | Kas | Tagad |
|---|---|---|
| 29 | Mind Soft+ CUT Soft× 0.75 / 0.85 / 0.95 | hardcode + patches |
| 30 | Mind Soft+ retention bank 0.55 | hardcode + patches |
| 31 | Mind entry confidence ladders | hardcode |
| 32 | Hardcoded 1m fight veto (paralēli genome) | hardcode |
| 33 | manageBrain score weights / green_share | hardcode |

---

## 2. JĀBŪT uz smadzenēm — IR genome, bet SI NEEVOLVĒ (wire)

| # | Atslēga | Status |
|---|---|---|
| 34 | `peak_trail_soft_cap_mult` | stuck factory — wire hypothesize |
| 35 | `story_fight_peak_arm_soft_mult` | stuck factory — wire hypothesize |
| 36 | `entry_chop_conf_max` | dead — wire vai izmest |
| 37 | `soft_plus_runner_mult` | tikai auto-cal → Brain explore |
| 38 | `soft_plus_leg_mult` | tikai auto-cal → Brain explore |
| 39 | `soft_layer_unlock_mult` | tikai auto-cal → Brain explore |
| 40 | `pullback_episode_*` (×3) | tikai auto-cal → Brain explore |
| 41 | `mtf_htf_veto` | vienvirziena → bidirectional explore |

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
Desk abs knobs → genome abs knobs; operators redz genome, ne atsevišķu desk Soft.

---

## 5. Darba secība (kad apstiprina)

1. Wire stuck Soft× keys (34–41) — ātrs  
2. Soft/Peak/Target abs → genome (1–10) — kritisks  
3. regimeExitProfile → genome (21) — kritisks  
4. structure + story + TREND-trek → genome (15–19) — kritisks  
5. Soft-exit gate + grace/TimeDecay → genome (22–25)  
6. Mind CUT / manage weights → genome (29–33); beigt codePatches  
7. Soft OFF / entry_filter / regimes ON-OFF → genome (11–14)  
8. Auto-cal pārrakstīt → genome-only propose
