# APSTIPRINĀŠANAI — kas iet uz smadzenēm

Ārpusē TIKAI 3:
1. lot_size
2. Capital dealing-rules (min stop / point size)
3. Sistēma (session/timers/DB/WS/auth/routing)

**Oficiālais ownership saraksts + audits:** [`docs/BRAIN_OWNERSHIP.md`](./BRAIN_OWNERSHIP.md)

Skala: min solis 0.1 (body/trek = bp).

**STATUS 2026-10-01:** MAP audit **431/431** = schema+wire+hypo (ne “viss literālis = smadzenes”).
Ownership politikā ~**101 Genome knobs ir BLOAT/BORDERLINE** (AutoCal mut meta, SAFETY broker-ops, count policy) — skatīt `BRAIN_OWNERSHIP.md`.
Ārpusē tikai lot / dealing-rules / sistēma. Audit: `scripts/auditGenomeOwnership.ts`.

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

### Playbook priority / SIDE / REVERSAL (smadzenes evolvē)
195. playbook_require_full_htf_stack — HTF promote tikai ar 30+15+5
196. playbook_block_htf_promote_on_live_chop — SIDE pirms HTF uz live chop
197. playbook_block_story_promote_on_live_chop — SIDE pirms stāsta TREND uz chop
198. playbook_chop_overrides_sticky_trend — sticky TREND→SIDE uz proven chop
199. reversal_from_breakout_prior — REVERSAL arī no BREAKOUT prior (V)

### One-market truth (visi lasa vienu tirgu)
200. playbook_one_market_truth — live classify = regime; HTF/stāsts neizdomā TREND
201. playbook_break_overrides_sticky_trend — BREAK pierce pirms sticky TREND
202. playbook_htf_require_unanimous — 30/15/5 fight → MIXED (ne majority)
203. entry_require_regime_setup — entry tikai ar 10s/structure recipe (ne PRĀTS invent)

### Regime runner (hold Target līdz režīma maiņai — ne SIDE)
204. regime_runner_enabled — ON/OFF
205. regime_runner_score — live 0…max (start 10)
206. regime_runner_score_max — score griesti
207. regime_runner_active_min_score — zemāk → fallback uz parastu Target
208. regime_runner_eval_every_n — ik N close (factory 5 ar auto-cal)
209. regime_runner_deduct_pts / regime_runner_recover_pts — score soļi
210. regime_runner_min_target_layer — arm pēc T1/T2/T3
211. regime_runner_success_mfe_retain — “strādā” = pnl/mfe ≥
212. regime_runner_eligible_regimes — TREND/PULLBACK/BREAKOUT/EXPANSION (ne RANGE)

### Post-impulse tip (nearmēt kad kustība jau beigusies)
213. entry_block_post_impulse_tip — ON: mid→late leg + tip → block BUY@HI / SELL@LO
214. entry_post_impulse_share_min — min |mid→late|/zoneWidth (factory 0.22)
215. entry_post_impulse_min_bars / entry_post_impulse_zone_bars — min bars + lookback (sanitizer min 30; no consumer floor)
216. entry_post_impulse_exempt_lanes — BREAKOUT/REVERSAL; **[] = no exemptions**

### Tip / Peak wires (vairs neciets kods)
217. entry_tip_chase_trend_pullback — tip-chase uz TREND_PULLBACK
218. entry_tip_block_finished_move — BUY@HI / SELL@LO finished-move
219. entry_trend_tip_require_reject — TREND/PULLBACK tip tikai ar dip/rally
220. peak_keep_genome_owns — Peak Keep = genome (nav desk Math.max floor)

### Manage / Mind / Exit / Safety residual → genome (221–278)
221–242. manage_path_* / manage_score_* / manage_learner_min_updates — manage score Soft× & additives
243–247. mind_manage_conf_* — PRĀTS manage confidence BANK/CUT/HOLD/TRAIL
248. mind_deep_green_soft_mult — deep green Soft×
249–250. timedecay_target_frac / peak_trail_minbank_frac
251–252. scalp_wick_frac / scalp_wick_body_frac
253–257. local_breakout_* lookback/skip/min/clear_mult
258. regime_conf_move_div
259–260. entry_m1_strong_move_mult / trek_min_path_abs_pts
261–263. safety_spread_fallback_bp / safety_abs_floor_tiny_bp / nano_bp (bp, ne 0.0000)
264. regime_runner_bad_retain_frac
265. auto_calibrate_every_n
266–271. auto_cal_*_pct_bp (min/max hardinv/target/peak — bp skala)
272–278. mind_entry_conf_* ladder + boost/cap

---

### Entry learner + Mind residual conf + AutoCal decisions (279–322)
279. entry_learner_min_updates — EntryLearner override after ≥N (kā manage_learner_min_updates)
280. entry_post_impulse_late_eff_min — post-impulse lateChop (ne trek_eff_min)
281–288. mind_entry_conf_regime_hyp / pb_wait / pb_resume_floor / story_side_floor / flip_after_loss / chop_wait / mixed_wait / hard_veto
309–310. mind_entry_conf_stack_fight / stack_chapter_wait — multi-TF stack WAIT conf
289–300. auto_cal_* decision thresholds (micro-win, high-MFE, asymmetry, soft-dom, ease-filter, legacy-raise, soft-tight, healthy E/win×loss)
301–308. auto_cal_* adjustment strength (target ease abs/div, peak/target raise abs, pct raise mults, giveback raise, healthy Keep step)


311–322. auto_cal_let_winners_e_min / choppy_ctx_min / choppy_e_max / neg_e_align_max / expand_ctx_min / expand_e_min / choppy_dwell_e_max / fight_ctx_min / fight_e_max / soft_dom_loss_count_min / soft_dom_loss_vs_hardinv / demote_recover_e_min — genome-path + softDominates residual thresholds


### AutoCal learning policy + MarketStory/Mind residual (323–403)
323. auto_cal_soft_loss_abs_floor
324. auto_cal_micro_win_abs_floor
325. auto_cal_peak_exits_min
326. auto_cal_high_mfe_tiny_count_min
327. auto_cal_micro_wins_min
328. auto_cal_avg_loss_abs_floor
329. auto_cal_already_tall_soft_mult
330. auto_cal_soft_tight_soft_losses_min
331. auto_cal_soft_tight_high_mfe_min
332. auto_cal_soft_tight_hardinv_max
333. auto_cal_regime_promote_n_min
334. auto_cal_regime_promote_sum_min
335. auto_cal_regime_keep_n_max
336. auto_cal_regime_keep_sum_min
337. auto_cal_regime_demote_sum_max
338. auto_cal_mut_soft_plus_giveback_step
339. auto_cal_mut_peak_arm_step
340. auto_cal_mut_soft_layer_unlock_step
341. auto_cal_mut_pb_episode_arm_step
342. auto_cal_mut_pb_episode_mfe_step
343. auto_cal_mut_soft_plus_runner_step
344. auto_cal_mut_soft_plus_leg_step
345. auto_cal_mut_soft_plus_giveback_min
346. auto_cal_mut_soft_plus_giveback_max
347. auto_cal_mut_peak_arm_min
348. auto_cal_mut_peak_arm_max
349. auto_cal_mut_soft_layer_unlock_min
350. auto_cal_mut_soft_layer_unlock_max
351. auto_cal_mut_pb_episode_arm_min
352. auto_cal_mut_pb_episode_arm_max
353. auto_cal_mut_pb_episode_mfe_min
354. auto_cal_mut_pb_episode_mfe_max
355. auto_cal_mut_soft_plus_runner_min
356. auto_cal_mut_soft_plus_runner_max
357. auto_cal_mut_soft_plus_leg_min
358. auto_cal_mut_soft_plus_leg_max
359. auto_cal_range_soft_min
360. auto_cal_range_wins_min
361. auto_cal_pb_soft_min
362. auto_cal_mut_range_chop_down
363. auto_cal_mut_range_share_down
364. auto_cal_mut_range_eff_down
365. auto_cal_mut_range_chop_up
366. auto_cal_mut_range_chop_min
367. auto_cal_mut_range_chop_max
368. auto_cal_mut_range_share_min
369. auto_cal_mut_range_share_max
370. auto_cal_mut_range_eff_min
371. auto_cal_mut_range_eff_max
372. auto_cal_same_side_pause_max
373. auto_cal_same_side_pause_soft_min
374. auto_cal_same_side_pause_step
375. auto_cal_choppy_green_lo
376. auto_cal_choppy_green_hi
377. auto_cal_mut_trek_flat_mult
378. auto_cal_mut_trek_flat_min
379. auto_cal_mut_trek_flat_max
380. auto_cal_mut_story_conf_step
381. auto_cal_mut_story_conf_min
382. auto_cal_mut_story_conf_max
383. auto_cal_mut_confirm_bars_min
384. auto_cal_mut_confirm_bars_max
385. auto_cal_mut_confirm_bars_step
386. auto_cal_mut_dwell_bars_min
387. auto_cal_mut_dwell_bars_max
388. auto_cal_mut_dwell_bars_step
389. story_recent_mins
390. story_recent_color_min
391. story_bounce_green_lo
392. story_bounce_green_hi
393. story_bounce_red_min
394. story_dip_red_lo
395. story_dip_red_hi
396. story_dip_green_min
397. minute_trend_bias_window_min
398. minute_trend_bias_color_votes
399. mind_pressure_delta
400. mind_session_knife_soft_min
401. mind_session_soft_losses_min
402. mind_session_soft_sized_min
403. mind_session_soft_cap_abs


### AutoCal Soft/Peak floors + SAFETY/RegimeRunner residual (404–431)
404. auto_cal_peak_vs_soft_floor_add
405. auto_cal_target_vs_soft_floor_add
406. auto_cal_peak_soft_gap_trigger
407. auto_cal_peak_soft_gap_raise
408. auto_cal_target_soft_gap_trigger
409. auto_cal_target_soft_gap_raise
410. auto_cal_safety_rr_floor
411. auto_cal_giveback_ease_floor
412. auto_cal_giveback_raise_ceil
413. auto_cal_entry_filter_min
414. auto_cal_entry_filter_max
415. auto_cal_entry_filter_step
416. mind_manage_session_closes_min
417. regime_runner_score_floor
418. regime_runner_sample_min
419. regime_same_family_confirm_bars
420. safety_bucket_hi
421. safety_bucket_mid
422. safety_bucket_lo
423. safety_bucket_tiny
424. safety_loosen_mult_1
425. safety_loosen_mult_2
426. safety_loosen_mult_3
427. safety_loosen_mult_4
428. safety_loosen_mult_5
429. safety_loosen_min_pts_mult
430. safety_tp_fallback_frac
431. safety_tp_fallback_abs


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
