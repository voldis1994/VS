# APSTIPRINĀŠANAI — kas iet uz smadzenēm

Ārpusē TIKAI 3:
1. lot_size
2. Capital dealing-rules (min stop / point size)
3. Sistēma (session/timers/DB/WS/auth/routing)

Viss zemāk = smadzenes. Režīmus smadzenes var uzlabot, ja rezultāts slikts.
Skala: min solis 0.1 (body/trek = bp).

Kopā uz smadzenēm: **187** (44 jau genome + 143 pārliekamie).

---

## JAU GENOME — paturēt + wire explore (44)

### Peak / Soft atmiņa
1. peak_keep
2. peak_arm_soft_mult
3. peak_trail_soft_cap_mult ← WIRE (stuck)
4. story_fight_peak_arm_soft_mult ← WIRE (stuck)
5. soft_plus_giveback
6. soft_plus_runner_mult ← WIRE (tagad tikai auto-cal)
7. soft_plus_leg_mult ← WIRE
8. soft_layer_unlock_mult ← WIRE
9. pullback_episode_enabled ← WIRE
10. pullback_episode_peak_arm_soft_mult ← WIRE
11. pullback_episode_min_mfe_soft_mult ← WIRE
12. require_1m_trigger
13. wait_on_1m_fight
14. mind_bank_on_turn
15. soft_same_side_pause_closes
16. soft_same_side_pause_min

### Regime body ladder (bp)
17. regime_move (0.8 bp)
18. regime_trend_stay (2.2)
19. regime_trend_enter (3.8)
20. regime_pullback (5.5)
21. regime_reversal (16)
22. regime_move_range (1.2)
23. regime_compress_abs (0.6)
24. regime_expand_abs (6)
25. regime_compress_avg_mult
26. regime_expand_avg_mult
27. regime_near_zone_mid
28. regime_clear_break_frac
29. regime_persist_enter
30. regime_persist_stay
31. regime_persist_pullback
32. regime_range_chop_persist_max
33. regime_range_trek_share_max
34. regime_range_trek_eff_max
35. regime_min_dwell_bars
36. regime_confirm_bars
37. regime_mom_bars
38. regime_persist_window

### Multi-TF / entry
39. mtf_trek_flat_frac (4 bp)
40. mtf_block_higher_fight
41. mtf_require_aligned_side
42. mtf_htf_veto ← WIRE bidirectional
43. entry_story_conf_min
44. entry_chop_conf_max ← WIRE

---

## PĀRLIEKAMI UZ SMADZENĒM (143)

### Soft / Peak / Target / SAFETY
45. soft_l1_abs
46. soft_l2_abs
47. soft_l3_abs / hardinv_abs
48. hardinv_pct
49. peak_mfe_abs
50. peak_mfe_pct
51. peak_retention (viena Keep ar peak_keep)
52. peak_min_giveback_abs
53. target_l1_abs
54. target_l2_abs
55. target_l3_abs / target_abs
56. target_pct
57. safety_tp_rr
58. entry_filter_level
59. enabled_regimes
60. soft_off_regimes
61. soft_l1/l2 fallback fracs
62. target_l1/l2 fallback fracs
63. target_stretch_gate (0.85)
64. layer_suggest_percentiles (p35/p60/p85)
65. target_l3_min_vs_soft (×1.2)

### Exit manage constants
66. PEAK_MFE_RETENTION fallback
67. MAX_MFE_GIVEBACK
68. HARDINV_ABS_FLOOR
69. HARDINV_ABS_CAP
70. PEAK_MFE_ABS_FLOOR
71. PEAK_MIN_GIVEBACK_ABS fallback
72. TARGET_ABS_FLOOR
73. SAFETY_TP_MIN_RR
74. hardinv_grace_ms
75. hardinv_confirm_ms
76. structure_grace_ms
77. structure_confirm_ms
78. timedecay_min_hold_ms
79. timedecay_min_fav_abs
80. DESK_REF_MID
81. layered_soft_post_mult_cap (×1.3)
82. BE_LOCK fracs
83. minProfitBank_policy (Soft×1)
84. safety_tp_vs_minStop_pillow (×1.05)
85. safety_sl_pct_pillow

### regimeExitProfile (visa tabula — smadzenes uzlabo ja slikti)
86. hardinv_mult per family
87. peak_arm mode per family
88. peak_mfe_mult per family
89. peak_giveback_mult per family
90. peak_retention override per family
91. target_mult per family
92. timedecay_hold_ms per family
93. timedecay_min_fav_mult per family
94. structure_invalidation mode per family
95. range_through_mid_slack (width×0.05)

### Soft-exit gate
96. soft_exit_gate_policy

### structureEntry
97. EXTREME_HI
98. EXTREME_LO
99. START_LO
100. START_HI
101. HALF_LO / HALF_HI
102. zone_band_cuts
103. minuteTrendBias_lookback
104. minuteTrendBias_trek_minPath
105. m1_aggregate_min_bars
106. breakout_pierce_pos
107. failed_break_reclaim_pos
108. compression_entry_pos
109. exhaust_tip_chase_block
110. entry_learner_override_margin

### flipFilter
111. SAME_DIR_LOCK_MS
112. SAME_DIR_LOCK_AFTER_LOSS_MS
113. exitReasonWasLoss_taxonomy

### marketStory
114. STORY_MIN_PATH_PCT
115. STORY_CONF_MIN
116. CHASE_EDGE
117. trekFirm_mult
118. sell_buy_struct_pos
119. bounce_dip_1m_color_counts
120. EXHAUST_pos
121. chapter_confidence_table
122. scalp_wick_confirm

### marketContext
123. expanding_range_mult
124. compressed_range_mult
125. velocity_lookback
126. pressure_fight_green_share
127. softplus_storyfight_execFav_mult
128. softplus_storyfight_min_mfe_mult

### traderMind
129. mind_cut_soft_mult (0.75)
130. mind_cut_retention (0.55)
131. greenSoft_arm_mult (0.95)
132. deepGiveback_offset
133. softplus_pullback_story_exec_mult
134. againstUs_soft_mults
135. session_expectancy_cut
136. entry_confidence_ladder
137. left_on_table_frac
138. soft_sized_loss_frac
139. session_E_bank_thresholds

### manageBrain
140. MIN_SAMPLE
141. sessionE_weights
142. windowE_weights
143. path_quality_soft_weights
144. m1_policy_score_weights
145. next_entry_score_weights
146. thesis_regime_story_pressure_weights
147. pressure_with_us_bands
148. near_target_lean_bank
149. score_clamp
150. learner_override_margin
151. peak_mfe_floor_ease

### Soft OFF strong signal
152. strong_htf_aligned_counts
153. strong_conf_min (0.7)
154. fade_allowed_chapters

### regimes residual (smadzenes uzlabo ja slikti)
155. ZONE_BARS
156. MIN_BARS_FOR_ZONE
157. SWITCH_GAP_BARS
158. local_breakout_frac_floor
159. trek_trend_prove (×4, share≥0.35, eff≥0.4)
160. trek_recent_leg_prove (×2, share≥0.25)
161. regime_confidence_map
162. book_confidence_floor_after_switch
163. soft_MOVE_trek_pullback_shortcut ← kill/genome
164. chop_to_trend_confirm
165. sticky_prior_TTL
166. TRANSITION_detect_or_remove
167. playbook_promote_vs_live_unify
168. EXPANSION_vs_TREND_priority

### pullbackEpisode residual
169. TREND_THESIS_regime_set
170. adverse_resume_chapter_sets
171. episode_end_policy
172. episode_softplus_bank_mult

### SAFETY SL (robotDesk)
173. safety_sl_pct_cushion (0.20%)
174. safety_sl_vs_brokerMin_mult (×2.5)
175. safety_sl_vs_spread_mult (×8)
176. safety_abs_floor_table
177. scratch_soft_mfe_learn_thresholds

### entryLearner
178. LR / L2 / TEMP / EXPLORE_EPS / MAX_W
179. feature_zone_bins
180. prior_feature_weights
181. reward_WAIT_boost

### auto-cal → genome bounds (ne paralēla smadze)
182. soft_peak_target_rr_pct_caps
183. soft_tighten_step
184. peak_ease_retention_giveback_steps
185. safety_tp_rr_step
186. MIN_ENABLED_REGIMES
187. CORE_ALWAYS_ON_REGIMES
188. SOFT_PCT_REF_MID
189. raise_streak_before_pullback
190. soft_sized_loss_detect
191. GAP_MOVE_STAY / STAY_ENTER / ENTER_PULLBACK (bp)
192. GAP_PULLBACK_REVERSAL
193. GAP_COMPRESS_EXPAND
194. persist_enter_stay_min_gap

---

## NEDRĪKST (ārpus saraksta)
- lot_size
- Capital dealing-rules min stop / point size
- Sistēma: session, timers, busy, reconnect, DB, WS, auth, routing

---

## Secība pēc apstiprinājuma
1. Wire STUCK Soft× / pullback / mtf_htf / entry_chop (1–16, 42–44)
2. Soft/Peak/Target/SAFETY abs → genome (45–65, 173–177)
3. regimeExitProfile + regimes residual → genome (86–95, 155–168)
4. structure/story/flip/Soft-exit → genome (96–128)
5. Mind/manage/strong → genome (129–154); beigt codePatches
6. Auto-cal → tikai genome propose (182–190)
