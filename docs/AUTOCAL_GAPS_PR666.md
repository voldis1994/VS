# Auto-cal gaps — PR #666 (`genome` 1–212)

Avots: merged PR [#666](https://github.com/voldis1994/VS/pull/666) (`one-market` 200–203 + `regime_runner` 204–212).
Salīdzināts: `BRAIN_CONFIRM_LIST` #1–212 pret `autoCalibrate.ts` (mutate / read) un `hypothesize.ts`.

## Īsumā

| Kategorija | Skaits |
|---|---:|
| Kopā confirm knobs | **212** |
| AutoCal **mutē** (≥1 atslēga) | **37** |
| AutoCal tikai **lasa** (bounds / gate) | **11** |
| **Nav pieejamas** auto-cal | **164** |

Ownership audits (`hypothesize` **vai** auto-cal) = **212/212**.
Bet tīri **automātiskai kalibrēšanai** (`autoCalibrate`) **nav** pieejamas **164** funkcijas — tās evolvē tikai Brain SI / hypothesize.

## PR #666 jaunās (200–212)

| # | Atslēga | AutoCal |
|---:|---|---|
| 200 | `playbook_one_market_truth` | ❌ nav auto-cal (tikai hypothesize) |
| 201 | `playbook_break_overrides_sticky_trend` | ❌ nav auto-cal (tikai hypothesize) |
| 202 | `playbook_htf_require_unanimous` | ❌ nav auto-cal (tikai hypothesize) |
| 203 | `entry_require_regime_setup` | ❌ nav auto-cal (tikai hypothesize) |
| 204 | `regime_runner_enabled` | 👁️ lasa (ne tune) |
| 205 | `regime_runner_score` | ✅ mutē |
| 206 | `regime_runner_score_max` | ❌ nav auto-cal (tikai hypothesize) |
| 207 | `regime_runner_active_min_score` | ❌ nav auto-cal (tikai hypothesize) |
| 208 | `regime_runner_eval_every_n` | 👁️ lasa (ne tune) |
| 209 | `regime_runner_deduct_pts / regime_runner_recover_pts` | ❌ nav auto-cal (tikai hypothesize) |
| 210 | `regime_runner_min_target_layer` | ❌ nav auto-cal (tikai hypothesize) |
| 211 | `regime_runner_success_mfe_retain` | ❌ nav auto-cal (tikai hypothesize) |
| 212 | `regime_runner_eligible_regimes` | ❌ nav auto-cal (tikai hypothesize) |

**No 13 jaunajām:** auto-cal mutē **1** (`#205`), lasa **2** (`#204`, `#208`), **nav pieejamas 10**.

## AutoCal mutē (37)

- **#1** `peak_keep` — peak_keep
- **#2** `peak_arm_soft_mult` — peak_arm_soft_mult
- **#5** `soft_plus_giveback` — soft_plus_giveback
- **#6** `soft_plus_runner_mult` — soft_plus_runner_mult ← WIRE (tagad tikai auto-cal)
- **#7** `soft_plus_leg_mult` — soft_plus_leg_mult ← WIRE
- **#8** `soft_layer_unlock_mult` — soft_layer_unlock_mult ← WIRE
- **#9** `pullback_episode_enabled` — pullback_episode_enabled ← WIRE
- **#10** `pullback_episode_peak_arm_soft_mult` — pullback_episode_peak_arm_soft_mult ← WIRE
- **#11** `pullback_episode_min_mfe_soft_mult` — pullback_episode_min_mfe_soft_mult ← WIRE
- **#15** `soft_same_side_pause_closes` — soft_same_side_pause_closes
- **#32** `regime_range_chop_persist_max` — regime_range_chop_persist_max
- **#33** `regime_range_trek_share_max` — regime_range_trek_share_max
- **#34** `regime_range_trek_eff_max` — regime_range_trek_eff_max
- **#35** `regime_min_dwell_bars` — regime_min_dwell_bars
- **#36** `regime_confirm_bars` — regime_confirm_bars
- **#39** `mtf_trek_flat_frac` — mtf_trek_flat_frac (4 bp)
- **#41** `mtf_require_aligned_side` — mtf_require_aligned_side
- **#42** `mtf_htf_veto` — mtf_htf_veto ← WIRE bidirectional
- **#43** `entry_story_conf_min` — entry_story_conf_min
- **#45** `soft_l1_abs` — soft_l1_abs
- **#46** `soft_l2_abs` — soft_l2_abs
- **#47** `soft_l3_abs` — soft_l3_abs / hardinv_abs
- **#48** `hardinv_pct_bp` — hardinv_pct
- **#49** `peak_mfe_abs` — peak_mfe_abs
- **#50** `peak_mfe_pct_bp` — peak_mfe_pct
- **#51** `peak_retention`, `peak_keep` — peak_retention (viena Keep ar peak_keep)
- **#52** `peak_min_giveback_abs` — peak_min_giveback_abs
- **#53** `target_l1_abs` — target_l1_abs
- **#54** `target_l2_abs` — target_l2_abs
- **#55** `target_l3_abs` — target_l3_abs / target_abs
- **#56** `target_pct_bp` — target_pct
- **#57** `safety_tp_rr` — safety_tp_rr
- **#58** `entry_filter_level` — entry_filter_level
- **#59** `enabled_regimes` — enabled_regimes
- **#60** `soft_off_regimes` — soft_off_regimes
- **#71** `peak_min_giveback_abs` — PEAK_MIN_GIVEBACK_ABS fallback
- **#205** `regime_runner_score` — regime_runner_score — live 0…max (start 10)

## AutoCal tikai lasa (11) — bounds / gate, ne trade-knob tune

- **#182** `auto_cal_max_hardinv_abs`, `auto_cal_max_peak_mfe_abs`, `auto_cal_max_target_abs`, `auto_cal_max_safety_tp_rr`, `auto_cal_min_hardinv_abs`, `auto_cal_max_peak_retention`, `auto_cal_min_peak_retention` — soft_peak_target_rr_pct_caps
- **#183** `soft_tighten_step` — soft_tighten_step
- **#184** `peak_ease_retention_step`, `peak_ease_giveback_step`, `peak_ease_abs_step` — peak_ease_retention_giveback_steps
- **#185** `safety_tp_rr_step`, `safety_tp_rr_pullback_step` — safety_tp_rr_step
- **#186** `min_enabled_regimes` — MIN_ENABLED_REGIMES
- **#187** `core_always_on_regimes` — CORE_ALWAYS_ON_REGIMES
- **#188** `soft_pct_ref_mid` — SOFT_PCT_REF_MID
- **#189** `raise_streak_before_pullback` — raise_streak_before_pullback
- **#190** `soft_sized_loss_detect_min` — soft_sized_loss_detect
- **#204** `regime_runner_enabled` — regime_runner_enabled — ON/OFF
- **#208** `regime_runner_eval_every_n` — regime_runner_eval_every_n — ik N close (factory 5 ar auto-cal)

## Nav pieejamas automātiskai kalibrēšanai (164)

Visas zemāk ir genome + hypothesize, bet `autoCalibrate` tās **nemaina**.

### Peak / Soft atmiņa (6)

- **#3** `peak_trail_soft_cap_mult` — peak_trail_soft_cap_mult ← WIRE (stuck)
- **#4** `story_fight_peak_arm_soft_mult` — story_fight_peak_arm_soft_mult ← WIRE (stuck)
- **#12** `require_1m_trigger` — require_1m_trigger
- **#13** `wait_on_1m_fight` — wait_on_1m_fight
- **#14** `mind_bank_on_turn` — mind_bank_on_turn
- **#16** `soft_same_side_pause_min` — soft_same_side_pause_min

### Regime body ladder (bp) (17)

- **#17** `regime_move` — regime_move (0.8 bp)
- **#18** `regime_trend_stay` — regime_trend_stay (2.2)
- **#19** `regime_trend_enter` — regime_trend_enter (3.8)
- **#20** `regime_pullback` — regime_pullback (5.5)
- **#21** `regime_reversal` — regime_reversal (16)
- **#22** `regime_move_range` — regime_move_range (1.2)
- **#23** `regime_compress_abs` — regime_compress_abs (0.6)
- **#24** `regime_expand_abs` — regime_expand_abs (6)
- **#25** `regime_compress_avg_mult` — regime_compress_avg_mult
- **#26** `regime_expand_avg_mult` — regime_expand_avg_mult
- **#27** `regime_near_zone_mid` — regime_near_zone_mid
- **#28** `regime_clear_break_frac` — regime_clear_break_frac
- **#29** `regime_persist_enter` — regime_persist_enter
- **#30** `regime_persist_stay` — regime_persist_stay
- **#31** `regime_persist_pullback` — regime_persist_pullback
- **#37** `regime_mom_bars` — regime_mom_bars
- **#38** `regime_persist_window` — regime_persist_window

### Multi-TF / entry (2)

- **#40** `mtf_block_higher_fight` — mtf_block_higher_fight
- **#44** `entry_chop_conf_max` — entry_chop_conf_max ← WIRE

### Soft / Peak / Target / SAFETY (5)

- **#61** `soft_l1_fallback_frac`, `soft_l2_fallback_frac` — soft_l1/l2 fallback fracs
- **#62** `target_l1_fallback_frac`, `target_l2_fallback_frac` — target_l1/l2 fallback fracs
- **#63** `target_stretch_gate` — target_stretch_gate (0.85)
- **#64** `layer_suggest_p35`, `layer_suggest_p60`, `layer_suggest_p85` — layer_suggest_percentiles (p35/p60/p85)
- **#65** `target_l3_min_vs_soft` — target_l3_min_vs_soft (×1.2)

### Exit manage constants (19)

- **#66** `peak_mfe_retention_fallback` — PEAK_MFE_RETENTION fallback
- **#67** `max_mfe_giveback` — MAX_MFE_GIVEBACK
- **#68** `hardinv_abs_floor` — HARDINV_ABS_FLOOR
- **#69** `hardinv_abs_cap` — HARDINV_ABS_CAP
- **#70** `peak_mfe_abs_floor` — PEAK_MFE_ABS_FLOOR
- **#72** `target_abs_floor` — TARGET_ABS_FLOOR
- **#73** `safety_tp_min_rr` — SAFETY_TP_MIN_RR
- **#74** `hardinv_grace_ms` — hardinv_grace_ms
- **#75** `hardinv_confirm_ms` — hardinv_confirm_ms
- **#76** `structure_grace_ms` — structure_grace_ms
- **#77** `structure_confirm_ms` — structure_confirm_ms
- **#78** `timedecay_min_hold_ms` — timedecay_min_hold_ms
- **#79** `timedecay_min_fav_abs` — timedecay_min_fav_abs
- **#80** `desk_ref_mid` — DESK_REF_MID
- **#81** `layered_soft_post_mult_cap` — layered_soft_post_mult_cap (×1.3)
- **#82** `be_lock_frac`, `be_lock_exec_frac` — BE_LOCK fracs
- **#83** `min_profit_bank_soft_mult` — minProfitBank_policy (Soft×1)
- **#84** `safety_tp_vs_min_stop_mult` — safety_tp_vs_minStop_pillow (×1.05)
- **#85** `safety_sl_cushion_bp` — safety_sl_pct_pillow

### regimeExitProfile (visa tabula — smadzenes uzlabo ja slikti) (10)

- **#86** `exit_trend_hardinv_mult`, `exit_pullback_hardinv_mult`, `exit_fade_hardinv_mult`, `exit_chop_hardinv_mult…` — hardinv_mult per family
- **#87** `exit_trend_peak_arm`, `exit_pullback_peak_arm`, `exit_fade_peak_arm`, `exit_chop_peak_arm…` — peak_arm mode per family
- **#88** `exit_trend_peak_mfe_mult`, `exit_pullback_peak_mfe_mult`, `exit_fade_peak_mfe_mult`, `exit_chop_peak_mfe_mult…` — peak_mfe_mult per family
- **#89** `exit_trend_peak_giveback_mult`, `exit_pullback_peak_giveback_mult`, `exit_fade_peak_giveback_mult`, `exit_chop_peak_giveback_mult…` — peak_giveback_mult per family
- **#90** `exit_trend_peak_retention`, `exit_pullback_peak_retention`, `exit_fade_peak_retention`, `exit_chop_peak_retention…` — peak_retention override per family
- **#91** `exit_trend_target_mult`, `exit_pullback_target_mult`, `exit_fade_target_mult`, `exit_chop_target_mult…` — target_mult per family
- **#92** `exit_trend_timedecay_hold_ms`, `exit_pullback_timedecay_hold_ms`, `exit_fade_timedecay_hold_ms`, `exit_chop_timedecay_hold_ms…` — timedecay_hold_ms per family
- **#93** `exit_trend_timedecay_min_fav_mult`, `exit_pullback_timedecay_min_fav_mult`, `exit_fade_timedecay_min_fav_mult`, `exit_chop_timedecay_min_fav_mult…` — timedecay_min_fav_mult per family
- **#94** `exit_trend_structure`, `exit_pullback_structure`, `exit_fade_structure`, `exit_chop_structure…` — structure_invalidation mode per family
- **#95** `exit_range_through_mid_slack` — range_through_mid_slack (width×0.05)

### Soft-exit gate (1)

- **#96** `soft_exit_require_1m_change`, `soft_exit_block_same_next_entry` — soft_exit_gate_policy

### structureEntry (14)

- **#97** `struct_extreme_hi` — EXTREME_HI
- **#98** `struct_extreme_lo` — EXTREME_LO
- **#99** `struct_start_lo` — START_LO
- **#100** `struct_start_hi` — START_HI
- **#101** `struct_half_lo`, `struct_half_hi` — HALF_LO / HALF_HI
- **#102** `zone_band_cut_lo`, `zone_band_cut_mid_lo`, `zone_band_cut_mid_hi`, `zone_band_cut_hi` — zone_band_cuts
- **#103** `minute_trend_bias_lookback` — minuteTrendBias_lookback
- **#104** `minute_trend_bias_trek_min_path_bp` — minuteTrendBias_trek_minPath
- **#105** `m1_aggregate_min_bars` — m1_aggregate_min_bars
- **#106** `breakout_pierce_pos_hi`, `breakout_pierce_pos_lo` — breakout_pierce_pos
- **#107** `failed_break_reclaim_pos_lo`, `failed_break_reclaim_pos_hi` — failed_break_reclaim_pos
- **#108** `compression_entry_pos_lo`, `compression_entry_pos_hi` — compression_entry_pos
- **#109** `exhaust_tip_chase_block` — exhaust_tip_chase_block
- **#110** `entry_learner_override_margin` — entry_learner_override_margin

### flipFilter (3)

- **#111** `same_dir_lock_ms` — SAME_DIR_LOCK_MS
- **#112** `same_dir_lock_after_loss_ms` — SAME_DIR_LOCK_AFTER_LOSS_MS
- **#113** `exit_loss_include_hardinv`, `exit_loss_exclude_be_lock` — exitReasonWasLoss_taxonomy

### marketStory (9)

- **#114** `story_min_path_bp` — STORY_MIN_PATH_PCT
- **#115** `story_conf_min` — STORY_CONF_MIN
- **#116** `chase_edge` — CHASE_EDGE
- **#117** `trek_firm_mult` — trekFirm_mult
- **#118** `story_sell_struct_pos`, `story_buy_struct_pos` — sell_buy_struct_pos
- **#119** `bounce_dip_color_delta` — bounce_dip_1m_color_counts
- **#120** `exhaust_pos_lo`, `exhaust_pos_hi` — EXHAUST_pos
- **#121** `story_conf_break`, `story_conf_bounce_dip`, `story_conf_struct`, `story_conf_recent…` — chapter_confidence_table
- **#122** `scalp_wick_confirm` — scalp_wick_confirm

### marketContext (6)

- **#123** `expanding_range_mult` — expanding_range_mult
- **#124** `compressed_range_mult` — compressed_range_mult
- **#125** `velocity_lookback` — velocity_lookback
- **#126** `pressure_fight_green_buy`, `pressure_fight_green_sell` — pressure_fight_green_share
- **#127** `softplus_storyfight_exec_fav_mult` — softplus_storyfight_execFav_mult
- **#128** `softplus_storyfight_min_mfe_mult` — softplus_storyfight_min_mfe_mult

### traderMind (11)

- **#129** `mind_cut_soft_mult` — mind_cut_soft_mult (0.75)
- **#130** `mind_cut_retention` — mind_cut_retention (0.55)
- **#131** `green_soft_arm_mult` — greenSoft_arm_mult (0.95)
- **#132** `deep_giveback_offset` — deepGiveback_offset
- **#133** `softplus_pullback_story_exec_mult` — softplus_pullback_story_exec_mult
- **#134** `against_us_soft_mult_hi`, `against_us_soft_mult_lo` — againstUs_soft_mults
- **#135** `session_expectancy_cut` — session_expectancy_cut
- **#136** `mind_entry_conf_base` — entry_confidence_ladder
- **#137** `left_on_table_peak_tiny_min` — left_on_table_frac
- **#138** `soft_sized_loss_frac` — soft_sized_loss_frac
- **#139** `session_e_bank_hi`, `session_e_bank_lo` — session_E_bank_thresholds

### manageBrain (12)

- **#140** `manage_min_sample` — MIN_SAMPLE
- **#141** `manage_score_session_e_neg`, `manage_score_session_e_pos` — sessionE_weights
- **#142** `manage_score_window_e_neg` — windowE_weights
- **#143** `manage_score_path_soft_green`, `manage_score_path_giveback` — path_quality_soft_weights
- **#144** `manage_score_m1_reverse`, `manage_score_m1_continue` — m1_policy_score_weights
- **#145** `manage_score_next_entry_opp` — next_entry_score_weights
- **#146** `manage_score_thesis_fight` — thesis_regime_story_pressure_weights
- **#147** `pressure_with_us_buy`, `pressure_with_us_sell` — pressure_with_us_bands
- **#148** `near_target_lean_bank` — near_target_lean_bank
- **#149** `manage_score_clamp` — score_clamp
- **#150** `manage_learner_override_margin` — learner_override_margin
- **#151** `peak_mfe_floor_ease` — peak_mfe_floor_ease

### Soft OFF strong signal (3)

- **#152** `strong_htf_aligned_min` — strong_htf_aligned_counts
- **#153** `strong_conf_min` — strong_conf_min (0.7)
- **#154** `fade_allowed_chapters` — fade_allowed_chapters

### regimes residual (smadzenes uzlabo ja slikti) (14)

- **#155** `zone_bars` — ZONE_BARS
- **#156** `min_bars_for_zone` — MIN_BARS_FOR_ZONE
- **#157** `switch_gap_bars` — SWITCH_GAP_BARS
- **#158** `local_breakout_frac_floor` — local_breakout_frac_floor
- **#159** `trek_full_enter_mult`, `trek_share_min`, `trek_eff_min` — trek_trend_prove (×4, share≥0.35, eff≥0.4)
- **#160** `trek_recent_enter_mult`, `trek_recent_share_min` — trek_recent_leg_prove (×2, share≥0.25)
- **#161** `regime_conf_base`, `regime_conf_strength_scale`, `regime_conf_min`, `regime_conf_max` — regime_confidence_map
- **#162** `book_confidence_floor_after_switch` — book_confidence_floor_after_switch
- **#163** `soft_move_trek_pullback_shortcut` — soft_MOVE_trek_pullback_shortcut ← kill/genome
- **#164** `chop_to_trend_confirm_bars` — chop_to_trend_confirm
- **#165** `sticky_prior_enabled` — sticky_prior_TTL
- **#166** `transition_detect_enabled` — TRANSITION_detect_or_remove
- **#167** `playbook_promote_vs_live_unify` — playbook_promote_vs_live_unify
- **#168** `expansion_before_trend` — EXPANSION_vs_TREND_priority

### pullbackEpisode residual (4)

- **#169** `trend_thesis_regimes` — TREND_THESIS_regime_set
- **#170** `adverse_chapters_sell`, `adverse_chapters_buy`, `resume_chapters_sell`, `resume_chapters_buy` — adverse_resume_chapter_sets
- **#171** `episode_end_on_continue` — episode_end_policy
- **#172** `episode_softplus_bank_mult` — episode_softplus_bank_mult

### SAFETY SL (robotDesk) (5)

- **#173** `safety_sl_cushion_bp` — safety_sl_pct_cushion (0.20%)
- **#174** `safety_sl_broker_min_mult` — safety_sl_vs_brokerMin_mult (×2.5)
- **#175** `safety_sl_spread_mult` — safety_sl_vs_spread_mult (×8)
- **#176** `safety_abs_floor_hi`, `safety_abs_floor_mid`, `safety_abs_floor_lo` — safety_abs_floor_table
- **#177** `scratch_soft_mfe_frac` — scratch_soft_mfe_learn_thresholds

### entryLearner (4)

- **#178** `entry_learner_lr`, `entry_learner_l2`, `entry_learner_temp`, `entry_learner_explore_eps…` — LR / L2 / TEMP / EXPLORE_EPS / MAX_W
- **#179** `entry_zone_lo_bin`, `entry_zone_hi_bin` — feature_zone_bins
- **#180** `entry_learner_prior_buy`, `entry_learner_prior_sell`, `entry_learner_prior_wait` — prior_feature_weights
- **#181** `entry_learner_wait_boost` — reward_WAIT_boost

### auto-cal → genome bounds (ne paralēla smadze) (4)

- **#191** `gap_move_stay`, `gap_stay_enter`, `gap_enter_pullback` — GAP_MOVE_STAY / STAY_ENTER / ENTER_PULLBACK (bp)
- **#192** `gap_pullback_reversal` — GAP_PULLBACK_REVERSAL
- **#193** `gap_compress_expand` — GAP_COMPRESS_EXPAND
- **#194** `persist_enter_stay_min_gap` — persist_enter_stay_min_gap

### Playbook priority / SIDE / REVERSAL (smadzenes evolvē) (5)

- **#195** `playbook_require_full_htf_stack` — playbook_require_full_htf_stack — HTF promote tikai ar 30+15+5
- **#196** `playbook_block_htf_promote_on_live_chop` — playbook_block_htf_promote_on_live_chop — SIDE pirms HTF uz live chop
- **#197** `playbook_block_story_promote_on_live_chop` — playbook_block_story_promote_on_live_chop — SIDE pirms stāsta TREND uz chop
- **#198** `playbook_chop_overrides_sticky_trend` — playbook_chop_overrides_sticky_trend — sticky TREND→SIDE uz proven chop
- **#199** `reversal_from_breakout_prior` — reversal_from_breakout_prior — REVERSAL arī no BREAKOUT prior (V)

### One-market truth (visi lasa vienu tirgu) (4)

- **#200** `playbook_one_market_truth` — playbook_one_market_truth — live classify = regime; HTF/stāsts neizdomā TREND
- **#201** `playbook_break_overrides_sticky_trend` — playbook_break_overrides_sticky_trend — BREAK pierce pirms sticky TREND
- **#202** `playbook_htf_require_unanimous` — playbook_htf_require_unanimous — 30/15/5 fight → MIXED (ne majority)
- **#203** `entry_require_regime_setup` — entry_require_regime_setup — entry tikai ar 10s/structure recipe (ne PRĀTS invent)

### Regime runner (hold Target līdz režīma maiņai — ne SIDE) (6)

- **#206** `regime_runner_score_max` — regime_runner_score_max — score griesti
- **#207** `regime_runner_active_min_score` — regime_runner_active_min_score — zemāk → fallback uz parastu Target
- **#209** `regime_runner_deduct_pts`, `regime_runner_recover_pts` — regime_runner_deduct_pts / regime_runner_recover_pts — score soļi
- **#210** `regime_runner_min_target_layer` — regime_runner_min_target_layer — arm pēc T1/T2/T3
- **#211** `regime_runner_success_mfe_retain` — regime_runner_success_mfe_retain — “strādā” = pnl/mfe ≥
- **#212** `regime_runner_eligible_regimes` — regime_runner_eligible_regimes — TREND/PULLBACK/BREAKOUT/EXPANSION (ne RANGE)

---

## Metode

1. Confirm # → genome atslēgas no `scripts/auditGenomeOwnership.ts` `MAP`.
2. **Mutē** = `patch.*` / `syncNum(...)` / `next.*` `autoCalibrate.ts`.
3. **Lasa** = atslēga minēta auto-cal, bet netiek piešķirta.
4. **Nav** = nav auto-cal failā; hypothesize to joprojām var evolvēt.

