# Smadzenes ownership — saraksts + audits

Datums: 2026-10-01 · branch `cursor/block-late-tip-entry-e06a`

## Politika

**Uz smadzenēm:** viss treidings — Soft/Peak/Target forma, SAFETY *trading shape*, regime/entry/story/mind, exit overlays.

**Ārpusē TIKAI 3:**
1. `lot_size` — operators / riska kapitāls
2. Capital dealing-rules (min stop / point size) — broker API, clamp virs genome SAFETY
3. Sistēma — session/timers/busy/reconnect/DB/WS/auth/routing

**Nav smadzenes:** procedūras struktūra (lane maps, zone thirds, priority tree) — kods, ne knob.

**MAP `N/N` nozīme:** schema + consumer wire + hypothesize coverage. **Ne** “nav neviena literāļa kodā”.

---

## Audita skaitļi (live)

| | |
|---|---|
| `EVOLVABLE_GENOME_KEYS` | **556** |
| **BRAIN** (atbilst politikai) | **442** |
| **BORDERLINE** (recipe counts — varēja palikt kodā) | **10** |
| **BLOAT** (nevajadzēja Genome) | **101** |
| Meta bookkeeping | **3** |
| Ownership MAP items (`auditGenomeOwnership`) | **385** |

Live audit skripts: `apps/control-api/scripts/auditGenomeOwnership.ts` → **431/431** schema+wire+hypo.

---

## Ārpusē (NEDRĪKST Genome)

| # | Kas | Kāpēc |
|---|---|---|
| 1 | `lot_size` | operators |
| 2 | Capital min stop / point size | broker dealing-rules |
| 3 | session / timers / busy / reconnect / DB / WS / auth / routing | infra |

---

## SMADZENES — kas IR treidings (442)

### Peak / Soft atmiņa (29)

1. `mind_bank_on_turn`
2. `peak_arm_soft_mult`
3. `peak_ease_abs_step`
4. `peak_ease_giveback_step`
5. `peak_ease_retention_step`
6. `peak_keep`
7. `peak_keep_genome_owns`
8. `peak_mfe_abs`
9. `peak_mfe_abs_floor`
10. `peak_mfe_floor_ease`
11. `peak_mfe_pct_bp`
12. `peak_mfe_retention_fallback`
13. `peak_min_giveback_abs`
14. `peak_retention`
15. `peak_trail_minbank_frac`
16. `peak_trail_soft_cap_mult`
17. `pullback_episode_enabled`
18. `pullback_episode_min_mfe_soft_mult`
19. `pullback_episode_peak_arm_soft_mult`
20. `require_1m_trigger`
21. `soft_layer_unlock_floor`
22. `soft_layer_unlock_mult`
23. `soft_plus_giveback`
24. `soft_plus_leg_mult`
25. `soft_plus_runner_mult`
26. `soft_same_side_pause_closes`
27. `soft_same_side_pause_min`
28. `story_fight_peak_arm_soft_mult`
29. `wait_on_1m_fight`

### Regime classify / ladder (49)

30. `chop_to_trend_confirm_bars`
31. `expansion_before_trend`
32. `gap_compress_expand`
33. `gap_enter_pullback`
34. `gap_move_stay`
35. `gap_pullback_reversal`
36. `gap_stay_enter`
37. `min_bars_for_zone`
38. `persist_enter_stay_min_gap`
39. `regime_clear_break_frac`
40. `regime_compress_abs`
41. `regime_compress_avg_mult`
42. `regime_conf_base`
43. `regime_conf_max`
44. `regime_conf_min`
45. `regime_conf_move_div`
46. `regime_conf_strength_scale`
47. `regime_confirm_bars`
48. `regime_expand_abs`
49. `regime_expand_avg_mult`
50. `regime_min_dwell_bars`
51. `regime_mom_bars`
52. `regime_move`
53. `regime_move_range`
54. `regime_near_zone_mid`
55. `regime_persist_enter`
56. `regime_persist_pullback`
57. `regime_persist_stay`
58. `regime_persist_window`
59. `regime_pullback`
60. `regime_range_chop_persist_max`
61. `regime_range_trek_eff_max`
62. `regime_range_trek_share_max`
63. `regime_reversal`
64. `regime_runner_active_min_score`
65. `regime_runner_bad_retain_frac`
66. `regime_runner_deduct_pts`
67. `regime_runner_eligible_regimes`
68. `regime_runner_enabled`
69. `regime_runner_eval_every_n`
70. `regime_runner_min_target_layer`
71. `regime_runner_recover_pts`
72. `regime_runner_score`
73. `regime_runner_score_max`
74. `regime_runner_success_mfe_retain`
75. `regime_trend_enter`
76. `regime_trend_stay`
77. `switch_gap_bars`
78. `zone_bars`

### Entry / structure / tip / story (94)

79. `bounce_dip_color_delta`
80. `breakout_pierce_pos_hi`
81. `breakout_pierce_pos_lo`
82. `chase_edge`
83. `compression_entry_pos_hi`
84. `compression_entry_pos_lo`
85. `entry_block_post_impulse_tip`
86. `entry_chop_conf_max`
87. `entry_filter_level`
88. `entry_learner_explore_eps`
89. `entry_learner_l2`
90. `entry_learner_lr`
91. `entry_learner_max_w`
92. `entry_learner_min_updates`
93. `entry_learner_override_margin`
94. `entry_learner_prior_buy`
95. `entry_learner_prior_sell`
96. `entry_learner_prior_wait`
97. `entry_learner_temp`
98. `entry_learner_wait_boost`
99. `entry_m1_strong_move_mult`
100. `entry_post_impulse_exempt_lanes`
101. `entry_post_impulse_late_eff_min`
102. `entry_post_impulse_min_bars`
103. `entry_post_impulse_share_min`
104. `entry_post_impulse_zone_bars`
105. `entry_require_regime_setup`
106. `entry_story_conf_min`
107. `entry_tip_block_finished_move`
108. `entry_tip_chase_trend_pullback`
109. `entry_trend_tip_require_reject`
110. `entry_zone_hi_bin`
111. `entry_zone_lo_bin`
112. `exhaust_pos_hi`
113. `exhaust_pos_lo`
114. `exhaust_tip_chase_block`
115. `fade_allowed_chapters`
116. `failed_break_reclaim_pos_hi`
117. `failed_break_reclaim_pos_lo`
118. `local_breakout_clear_frac_mult`
119. `local_breakout_frac_floor`
120. `local_breakout_lookback_max`
121. `local_breakout_lookback_min`
122. `local_breakout_min_struct_bars`
123. `local_breakout_skip_bars`
124. `m1_aggregate_min_bars`
125. `minute_trend_bias_lookback`
126. `minute_trend_bias_trek_min_path_bp`
127. `mtf_block_higher_fight`
128. `mtf_htf_veto`
129. `mtf_require_aligned_side`
130. `mtf_trek_flat_frac`
131. `playbook_block_htf_promote_on_live_chop`
132. `playbook_block_story_promote_on_live_chop`
133. `playbook_break_overrides_sticky_trend`
134. `playbook_chop_overrides_sticky_trend`
135. `playbook_htf_require_unanimous`
136. `playbook_one_market_truth`
137. `playbook_promote_vs_live_unify`
138. `playbook_require_full_htf_stack`
139. `pressure_fight_green_buy`
140. `pressure_fight_green_sell`
141. `pressure_with_us_buy`
142. `pressure_with_us_sell`
143. `scalp_wick_body_frac`
144. `scalp_wick_confirm`
145. `scalp_wick_frac`
146. `story_buy_struct_pos`
147. `story_conf_bounce_dip`
148. `story_conf_break`
149. `story_conf_chop`
150. `story_conf_chop_thin`
151. `story_conf_min`
152. `story_conf_recent`
153. `story_conf_struct`
154. `story_min_path_bp`
155. `story_sell_struct_pos`
156. `struct_extreme_hi`
157. `struct_extreme_lo`
158. `struct_half_hi`
159. `struct_half_lo`
160. `struct_start_hi`
161. `struct_start_lo`
162. `trek_eff_min`
163. `trek_firm_mult`
164. `trek_full_enter_mult`
165. `trek_min_path_abs_pts`
166. `trek_recent_enter_mult`
167. `trek_recent_share_min`
168. `trek_share_min`
169. `zone_band_cut_hi`
170. `zone_band_cut_lo`
171. `zone_band_cut_mid_hi`
172. `zone_band_cut_mid_lo`

### Mind / manage (60)

173. `manage_learner_min_updates`
174. `manage_learner_override_margin`
175. `manage_mae_deep_score`
176. `manage_mae_deep_soft_mult`
177. `manage_min_sample`
178. `manage_path_deep_green_soft_mult`
179. `manage_path_fade_score`
180. `manage_path_fade_soft_mult`
181. `manage_path_stall_mfe_soft_mult`
182. `manage_path_stall_score`
183. `manage_path_stall_upl_soft_mult`
184. `manage_score_chapter_change`
185. `manage_score_clamp`
186. `manage_score_expand_continue`
187. `manage_score_expand_reverse`
188. `manage_score_feed_divergent`
189. `manage_score_feed_strong`
190. `manage_score_m1_continue`
191. `manage_score_m1_reverse`
192. `manage_score_m1_wait`
193. `manage_score_near_target`
194. `manage_score_next_entry_opp`
195. `manage_score_next_same`
196. `manage_score_path_giveback`
197. `manage_score_path_soft_green`
198. `manage_score_pressure_with`
199. `manage_score_session_e_neg`
200. `manage_score_session_e_pos`
201. `manage_score_soft_gate_open`
202. `manage_score_story_fight`
203. `manage_score_story_with`
204. `manage_score_thesis_bonus`
205. `manage_score_thesis_fight`
206. `manage_score_window_e_neg`
207. `mind_cut_retention`
208. `mind_cut_soft_mult`
209. `mind_deep_green_soft_mult`
210. `mind_entry_conf_aligned`
211. `mind_entry_conf_aligned_strong`
212. `mind_entry_conf_base`
213. `mind_entry_conf_bias`
214. `mind_entry_conf_cap`
215. `mind_entry_conf_chop_wait`
216. `mind_entry_conf_flip_after_loss`
217. `mind_entry_conf_hard_veto`
218. `mind_entry_conf_mixed_wait`
219. `mind_entry_conf_pb_resume_floor`
220. `mind_entry_conf_pb_wait`
221. `mind_entry_conf_regime_boost`
222. `mind_entry_conf_regime_hyp`
223. `mind_entry_conf_stack_chapter_wait`
224. `mind_entry_conf_stack_fight`
225. `mind_entry_conf_story_side_floor`
226. `mind_entry_conf_strong_m1`
227. `mind_entry_conf_weak`
228. `mind_manage_conf_bank`
229. `mind_manage_conf_cut`
230. `mind_manage_conf_hold_against`
231. `mind_manage_conf_hold_continue`
232. `mind_manage_conf_trail`

### SAFETY trading shape (14)

233. `safety_abs_floor_hi`
234. `safety_abs_floor_lo`
235. `safety_abs_floor_mid`
236. `safety_abs_floor_nano_bp`
237. `safety_abs_floor_tiny_bp`
238. `safety_sl_broker_min_mult`
239. `safety_sl_cushion_bp`
240. `safety_sl_spread_mult`
241. `safety_spread_fallback_bp`
242. `safety_tp_min_rr`
243. `safety_tp_rr`
244. `safety_tp_rr_pullback_step`
245. `safety_tp_rr_step`
246. `safety_tp_vs_min_stop_mult`

### Soft/Peak/Target abs + regimes book (21)

247. `enabled_regimes`
248. `hardinv_abs_cap`
249. `hardinv_abs_floor`
250. `hardinv_confirm_ms`
251. `hardinv_grace_ms`
252. `hardinv_pct_bp`
253. `soft_l1_abs`
254. `soft_l1_fallback_frac`
255. `soft_l2_abs`
256. `soft_l2_fallback_frac`
257. `soft_l3_abs`
258. `soft_off_regimes`
259. `target_abs_floor`
260. `target_l1_abs`
261. `target_l1_fallback_frac`
262. `target_l2_abs`
263. `target_l2_fallback_frac`
264. `target_l3_abs`
265. `target_l3_min_vs_soft`
266. `target_pct_bp`
267. `target_stretch_gate`

### AutoCal sync / adjustment (50)

268. `auto_cal_asym_win_vs_loss`
269. `auto_cal_choppy_ctx_min`
270. `auto_cal_choppy_dwell_e_max`
271. `auto_cal_choppy_e_max`
272. `auto_cal_demote_recover_e_min`
273. `auto_cal_ease_filter_e_min`
274. `auto_cal_expand_ctx_min`
275. `auto_cal_expand_e_min`
276. `auto_cal_fight_ctx_min`
277. `auto_cal_fight_e_max`
278. `auto_cal_giveback_raise_abs`
279. `auto_cal_healthy_e_min`
280. `auto_cal_healthy_keep_step`
281. `auto_cal_healthy_win_vs_loss`
282. `auto_cal_high_mfe_vs_loss`
283. `auto_cal_left_winner_e_max`
284. `auto_cal_legacy_raise_e_max`
285. `auto_cal_legacy_raise_win_vs_loss`
286. `auto_cal_let_winners_e_min`
287. `auto_cal_max_hardinv_abs`
288. `auto_cal_max_hardinv_pct_bp`
289. `auto_cal_max_peak_mfe_abs`
290. `auto_cal_max_peak_mfe_pct_bp`
291. `auto_cal_max_peak_retention`
292. `auto_cal_max_safety_tp_rr`
293. `auto_cal_max_target_abs`
294. `auto_cal_max_target_pct_bp`
295. `auto_cal_micro_win_vs_loss`
296. `auto_cal_min_hardinv_abs`
297. `auto_cal_min_hardinv_pct_bp`
298. `auto_cal_min_peak_mfe_pct_bp`
299. `auto_cal_min_peak_retention`
300. `auto_cal_min_target_pct_bp`
301. `auto_cal_neg_e_align_max`
302. `auto_cal_peak_pct_raise_mult`
303. `auto_cal_peak_raise_abs`
304. `auto_cal_soft_dom_e_max`
305. `auto_cal_soft_dom_loss_vs_hardinv`
306. `auto_cal_soft_dom_win_vs_loss`
307. `auto_cal_target_ease_abs`
308. `auto_cal_target_pct_ease_div`
309. `auto_cal_target_pct_raise_mult`
310. `auto_cal_target_raise_abs`
311. `auto_calibrate_every_n`
312. `max_mfe_giveback`
313. `min_enabled_regimes`
314. `raise_streak_before_pullback`
315. `soft_sized_loss_detect_min`
316. `soft_sized_loss_frac`
317. `soft_tighten_step`

### Exit / runner / learner / thesis (23)

318. `adverse_chapters_buy`
319. `adverse_chapters_sell`
320. `core_always_on_regimes`
321. `deep_giveback_offset`
322. `episode_end_on_continue`
323. `episode_softplus_bank_mult`
324. `green_soft_arm_mult`
325. `layered_soft_post_mult_cap`
326. `left_on_table_peak_tiny_min`
327. `min_profit_bank_soft_mult`
328. `resume_chapters_buy`
329. `resume_chapters_sell`
330. `session_e_bank_hi`
331. `session_e_bank_lo`
332. `session_expectancy_cut`
333. `softplus_pullback_story_exec_mult`
334. `softplus_storyfight_exec_fav_mult`
335. `softplus_storyfight_min_mfe_mult`
336. `timedecay_fav_pct_bp`
337. `timedecay_min_fav_abs`
338. `timedecay_min_hold_ms`
339. `timedecay_target_frac`
340. `trend_thesis_regimes`

### Other trading (102)

341. `against_us_soft_mult_hi`
342. `against_us_soft_mult_lo`
343. `be_lock_exec_frac`
344. `be_lock_frac`
345. `book_confidence_floor_after_switch`
346. `compressed_range_mult`
347. `desk_ref_mid`
348. `exit_break_fail_hardinv_mult`
349. `exit_break_fail_peak_arm`
350. `exit_break_fail_peak_giveback_mult`
351. `exit_break_fail_peak_mfe_mult`
352. `exit_break_fail_peak_retention`
353. `exit_break_fail_structure`
354. `exit_break_fail_target_mult`
355. `exit_break_fail_timedecay_hold_ms`
356. `exit_break_fail_timedecay_min_fav_mult`
357. `exit_break_hardinv_mult`
358. `exit_break_peak_arm`
359. `exit_break_peak_giveback_mult`
360. `exit_break_peak_mfe_mult`
361. `exit_break_peak_retention`
362. `exit_break_structure`
363. `exit_break_target_mult`
364. `exit_break_timedecay_hold_ms`
365. `exit_break_timedecay_min_fav_mult`
366. `exit_chop_hardinv_mult`
367. `exit_chop_peak_arm`
368. `exit_chop_peak_giveback_mult`
369. `exit_chop_peak_mfe_mult`
370. `exit_chop_peak_retention`
371. `exit_chop_structure`
372. `exit_chop_target_mult`
373. `exit_chop_timedecay_hold_ms`
374. `exit_chop_timedecay_min_fav_mult`
375. `exit_expansion_hardinv_mult`
376. `exit_expansion_peak_arm`
377. `exit_expansion_peak_giveback_mult`
378. `exit_expansion_peak_mfe_mult`
379. `exit_expansion_peak_retention`
380. `exit_expansion_structure`
381. `exit_expansion_target_mult`
382. `exit_expansion_timedecay_hold_ms`
383. `exit_expansion_timedecay_min_fav_mult`
384. `exit_fade_hardinv_mult`
385. `exit_fade_peak_arm`
386. `exit_fade_peak_giveback_mult`
387. `exit_fade_peak_mfe_mult`
388. `exit_fade_peak_retention`
389. `exit_fade_structure`
390. `exit_fade_target_mult`
391. `exit_fade_timedecay_hold_ms`
392. `exit_fade_timedecay_min_fav_mult`
393. `exit_loss_exclude_be_lock`
394. `exit_loss_include_hardinv`
395. `exit_pullback_hardinv_mult`
396. `exit_pullback_peak_arm`
397. `exit_pullback_peak_giveback_mult`
398. `exit_pullback_peak_mfe_mult`
399. `exit_pullback_peak_retention`
400. `exit_pullback_structure`
401. `exit_pullback_target_mult`
402. `exit_pullback_timedecay_hold_ms`
403. `exit_pullback_timedecay_min_fav_mult`
404. `exit_range_through_mid_slack`
405. `exit_reversal_hardinv_mult`
406. `exit_reversal_peak_arm`
407. `exit_reversal_peak_giveback_mult`
408. `exit_reversal_peak_mfe_mult`
409. `exit_reversal_peak_retention`
410. `exit_reversal_structure`
411. `exit_reversal_target_mult`
412. `exit_reversal_timedecay_hold_ms`
413. `exit_reversal_timedecay_min_fav_mult`
414. `exit_trend_hardinv_mult`
415. `exit_trend_peak_arm`
416. `exit_trend_peak_giveback_mult`
417. `exit_trend_peak_mfe_mult`
418. `exit_trend_peak_retention`
419. `exit_trend_structure`
420. `exit_trend_target_mult`
421. `exit_trend_timedecay_hold_ms`
422. `exit_trend_timedecay_min_fav_mult`
423. `expanding_range_mult`
424. `layer_suggest_p35`
425. `layer_suggest_p60`
426. `layer_suggest_p85`
427. `near_target_lean_bank`
428. `reversal_from_breakout_prior`
429. `same_dir_lock_after_loss_ms`
430. `same_dir_lock_ms`
431. `scratch_soft_mfe_frac`
432. `soft_exit_block_same_next_entry`
433. `soft_exit_require_1m_change`
434. `soft_move_trek_pullback_shortcut`
435. `soft_pct_ref_mid`
436. `sticky_prior_enabled`
437. `strong_conf_min`
438. `strong_htf_aligned_min`
439. `structure_confirm_ms`
440. `structure_grace_ms`
441. `transition_detect_enabled`
442. `velocity_lookback`

---

## BORDERLINE — recipe counts (10)

Drīkst būt Genome, bet ownership politikā tie ir *procedūras* sliekšņi (count≥N), ne Soft/Peak forma. Kandidāti sašaurināšanai.

1. `minute_trend_bias_color_votes` — Minute bias vote recipe
2. `minute_trend_bias_window_min` — Minute bias vote recipe
3. `story_bounce_green_hi` — Story chapter recipe counts (could be procedural)
4. `story_bounce_green_lo` — Story chapter recipe counts (could be procedural)
5. `story_bounce_red_min` — Story chapter recipe counts (could be procedural)
6. `story_dip_green_min` — Story chapter recipe counts (could be procedural)
7. `story_dip_red_hi` — Story chapter recipe counts (could be procedural)
8. `story_dip_red_lo` — Story chapter recipe counts (could be procedural)
9. `story_recent_color_min` — Story chapter recipe counts (could be procedural)
10. `story_recent_mins` — Story chapter recipe counts (could be procedural)

---

## BLOAT — nevajadzēja likt uz Genome (101)

### AutoCal mutation meta (learning-of-learning)

- `auto_cal_mut_confirm_bars_max`
- `auto_cal_mut_confirm_bars_min`
- `auto_cal_mut_confirm_bars_step`
- `auto_cal_mut_dwell_bars_max`
- `auto_cal_mut_dwell_bars_min`
- `auto_cal_mut_dwell_bars_step`
- `auto_cal_mut_pb_episode_arm_max`
- `auto_cal_mut_pb_episode_arm_min`
- `auto_cal_mut_pb_episode_arm_step`
- `auto_cal_mut_pb_episode_mfe_max`
- `auto_cal_mut_pb_episode_mfe_min`
- `auto_cal_mut_pb_episode_mfe_step`
- `auto_cal_mut_peak_arm_max`
- `auto_cal_mut_peak_arm_min`
- `auto_cal_mut_peak_arm_step`
- `auto_cal_mut_range_chop_down`
- `auto_cal_mut_range_chop_max`
- `auto_cal_mut_range_chop_min`
- `auto_cal_mut_range_chop_up`
- `auto_cal_mut_range_eff_down`
- `auto_cal_mut_range_eff_max`
- `auto_cal_mut_range_eff_min`
- `auto_cal_mut_range_share_down`
- `auto_cal_mut_range_share_max`
- `auto_cal_mut_range_share_min`
- `auto_cal_mut_soft_layer_unlock_max`
- `auto_cal_mut_soft_layer_unlock_min`
- `auto_cal_mut_soft_layer_unlock_step`
- `auto_cal_mut_soft_plus_giveback_max`
- `auto_cal_mut_soft_plus_giveback_min`
- `auto_cal_mut_soft_plus_giveback_step`
- `auto_cal_mut_soft_plus_leg_max`
- `auto_cal_mut_soft_plus_leg_min`
- `auto_cal_mut_soft_plus_leg_step`
- `auto_cal_mut_soft_plus_runner_max`
- `auto_cal_mut_soft_plus_runner_min`
- `auto_cal_mut_soft_plus_runner_step`
- `auto_cal_mut_story_conf_max`
- `auto_cal_mut_story_conf_min`
- `auto_cal_mut_story_conf_step`
- `auto_cal_mut_trek_flat_max`
- `auto_cal_mut_trek_flat_min`
- `auto_cal_mut_trek_flat_mult`

### SAFETY broker-ops (dealing-adjacent)

- `safety_bucket_hi`
- `safety_bucket_lo`
- `safety_bucket_mid`
- `safety_bucket_tiny`
- `safety_loosen_min_pts_mult`
- `safety_loosen_mult_1`
- `safety_loosen_mult_2`
- `safety_loosen_mult_3`
- `safety_loosen_mult_4`
- `safety_loosen_mult_5`
- `safety_tp_fallback_abs`
- `safety_tp_fallback_frac`

### AutoCal / Mind / regime learning policy counts

- `auto_cal_already_tall_soft_mult`
- `auto_cal_avg_loss_abs_floor`
- `auto_cal_choppy_green_hi`
- `auto_cal_choppy_green_lo`
- `auto_cal_entry_filter_max`
- `auto_cal_entry_filter_min`
- `auto_cal_entry_filter_step`
- `auto_cal_giveback_ease_floor`
- `auto_cal_giveback_raise_ceil`
- `auto_cal_high_mfe_tiny_count_min`
- `auto_cal_micro_win_abs_floor`
- `auto_cal_micro_wins_min`
- `auto_cal_pb_soft_min`
- `auto_cal_peak_exits_min`
- `auto_cal_peak_soft_gap_raise`
- `auto_cal_peak_soft_gap_trigger`
- `auto_cal_peak_vs_soft_floor_add`
- `auto_cal_range_soft_min`
- `auto_cal_range_wins_min`
- `auto_cal_regime_demote_sum_max`
- `auto_cal_regime_keep_n_max`
- `auto_cal_regime_keep_sum_min`
- `auto_cal_regime_promote_n_min`
- `auto_cal_regime_promote_sum_min`
- `auto_cal_safety_rr_floor`
- `auto_cal_same_side_pause_max`
- `auto_cal_same_side_pause_soft_min`
- `auto_cal_same_side_pause_step`
- `auto_cal_soft_dom_loss_count_min`
- `auto_cal_soft_loss_abs_floor`
- `auto_cal_soft_tight_e_max`
- `auto_cal_soft_tight_hardinv_max`
- `auto_cal_soft_tight_high_mfe_min`
- `auto_cal_soft_tight_soft_losses_min`
- `auto_cal_target_soft_gap_raise`
- `auto_cal_target_soft_gap_trigger`
- `auto_cal_target_vs_soft_floor_add`
- `mind_manage_session_closes_min`
- `mind_pressure_delta`
- `mind_session_knife_soft_min`
- `mind_session_soft_cap_abs`
- `mind_session_soft_losses_min`
- `mind_session_soft_sized_min`
- `regime_runner_sample_min`
- `regime_runner_score_floor`
- `regime_same_family_confirm_bars`

---

## Meta (bookkeeping)

- `explore_step`
- `last_lesson`
- `version`

---

## Secinājums

1. **Smadzenes = treidings** (Soft/Peak/Target/SAFETY forma, regime/entry/story/mind/exit).
2. **Ārpusē = 3** (lot / dealing-rules / sistēma).
3. Pašlaik Genome satur **101 bloat** knobs no “katrs literālis → MAP” ceļa (īpaši AutoCal `*_mut_*` + SAFETY loosen/buckets/TP-fallback).
4. Nākamais darbs: **sašaurināt** bloat (ne turpināt MAP++); paturēt tip/Keep/Soft·Peak·Mind wiring.

Skatīt arī: `docs/BRAIN_OWNERSHIP_TARGET.md` (mērķa politika), `docs/BRAIN_CONFIRM_LIST.md` (MAP vēsture).

