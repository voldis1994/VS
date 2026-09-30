# Pilnais saraksts — ko smadzenēm JĀPĀRVALDA

Politika: viss treidings → smadzenes.  
**Ārpusē tikai:** `lot_size` · Capital dealing-rules · sistēma (infra).

Kopā **187** knobs: **34** jau OWNED · **10** STUCK (wire) · **143** MOVE.

---

## A. Jau uz smadzenēm (OWNED) — 34

1. `peak_keep` — 0.75
2. `peak_arm_soft_mult` — 1.35
3. `soft_plus_giveback` — 0.75
4. `soft_same_side_pause_closes` — 4
5. `soft_same_side_pause_min` — 2
6. `require_1m_trigger` — true
7. `wait_on_1m_fight` — true
8. `mind_bank_on_turn` — true
9. `regime_move` — 0.00008
10. `regime_trend_stay` — 0.00022
11. `regime_trend_enter` — 0.00038
12. `regime_pullback` — 0.00055
13. `regime_reversal` — 0.0016
14. `regime_move_range` — 0.00012
15. `regime_compress_abs` — 0.000055
16. `regime_expand_abs` — 0.0006
17. `regime_compress_avg_mult` — 0.35
18. `regime_expand_avg_mult` — 1.65
19. `regime_near_zone_mid` — 0.28
20. `regime_clear_break_frac` — 0.25
21. `regime_persist_enter` — 0.5
22. `regime_persist_stay` — 0.3
23. `regime_persist_pullback` — 0.2
24. `regime_range_chop_persist_max` — 0.25
25. `regime_range_trek_share_max` — 0.32
26. `regime_range_trek_eff_max` — 0.45
27. `regime_min_dwell_bars` — 5
28. `regime_confirm_bars` — 3
29. `regime_mom_bars` — 8
30. `regime_persist_window` — 6
31. `mtf_trek_flat_frac` — 0.0004
32. `mtf_block_higher_fight` — true
33. `mtf_require_aligned_side` — true
34. `entry_story_conf_min` — 0.55

---

## B. Uz genome, bet SI neevolvē (STUCK — wire) — 10

35. `peak_trail_soft_cap_mult` — 1.75
36. `story_fight_peak_arm_soft_mult` — 1.0
37. `soft_plus_runner_mult` — 1.5 (auto-cal only)
38. `soft_plus_leg_mult` — 1.35 (auto-cal only)
39. `soft_layer_unlock_mult` — 1.0 (auto-cal only)
40. `pullback_episode_enabled` — true
41. `pullback_episode_peak_arm_soft_mult` — 1.0
42. `pullback_episode_min_mfe_soft_mult` — 0.5
43. `mtf_htf_veto` — true (vienvirziena)
44. `entry_chop_conf_max` — 0.45

---

## C. Jāpārliek uz smadzenēm (MOVE) — 143

### Soft / Peak / Target / SAFETY (desk)
45. Soft L3 / `hardinv_abs` — 2.2
46. Soft L1 abs — 1.2
47. Soft L2 abs — 1.8
48. Soft `hardinv_pct` — 0.0008
49. Peak `peak_mfe_abs` — 3.0
50. Peak `peak_mfe_pct` — 0.0009
51. Peak `peak_retention` — 0.72
52. Peak `peak_min_giveback_abs` — 0.85
53. Target L3 / `target_abs` — 5.0
54. Target L1 abs — 2.5
55. Target L2 abs — 3.5
56. Target `target_pct` — 0.0025
57. SAFETY TP R:R `safety_tp_rr` — 1.5
58. `entry_filter_level` — 0…3
59. `enabled_regimes`
60. `soft_off_regimes`

### Soft/Target layer policy
61. Soft L1/L2 fallback fracs (0.55 / 0.8)
62. Target L1/L2 fallback fracs (0.5 / 0.7)
63. Target stretch gate `0.85`
64. Layer suggest percentiles p35/p60/p85
65. Target L3 ≥ Soft L3 × 1.2

### Exit manage constants
66. `PEAK_MFE_RETENTION` fallback — 0.72
67. `MAX_MFE_GIVEBACK` — 0.35
68. `HARDINV_ABS_FLOOR` — 1.5
69. `HARDINV_ABS_CAP` — 2.2
70. `PEAK_MFE_ABS_FLOOR` — 3.0
71. `PEAK_MIN_GIVEBACK_ABS` fallback — 0.85
72. `TARGET_ABS_FLOOR` — 4.0
73. `SAFETY_TP_MIN_RR` — 1.5
74. Soft HardInv grace ms — 12s
75. Soft HardInv confirm ms — 5s
76. Structure grace ms — 8s
77. Structure confirm ms — 3s
78. TimeDecay min hold — 12m
79. TimeDecay min fav abs — 2.0
80. `DESK_REF_MID` — 2000
81. Layered Soft post-mult cap ×1.3
82. BE_LOCK fracs (legacy)
83. minProfitBank = Soft×1
84. SAFETY TP vs minStop ×1.05 pillow
85. SAFETY SL % pillow `abs×0.002`

### regimeExitProfile (visa tabula)
86. `hardinv_mult` per regime family
87. `peak_arm` mode (reverse_1m / reverse_or_mid / fast)
88. `peak_mfe_mult`
89. `peak_giveback_mult`
90. `peak_retention` override per family
91. `target_mult` per family
92. `timedecay_hold_ms` per family
93. `timedecay_min_fav_mult` per family
94. structure invalidation mode
95. RANGE through_mid slack `width×0.05`

### Soft-exit gate
96. Soft-exit gate policy (1m continue / same next-entry HOLD)

### structureEntry
97. `EXTREME_HI` — 0.85
98. `EXTREME_LO` — 0.15
99. `START_LO` — 0.65
100. `START_HI` — 0.35
101. HALF_LO / HALF_HI — 0.5
102. Zone band cuts 0.2/0.4/0.6/0.8
103. minuteTrendBias lookback — 5
104. minuteTrendBias trek minPath `mid×0.0007`
105. 1m aggregate min bars ≥3
106. Breakout pierce pos 0.92 / 0.08
107. Failed-break reclaim pos 0.2 / 0.8
108. Compression entry pos 0.35 / 0.65
109. Exhaust tip chase block 0.8 / 0.2
110. Entry learner override margin (updates≥20, +0.08)

### flipFilter
111. `SAME_DIR_LOCK_MS` — 90s
112. `SAME_DIR_LOCK_AFTER_LOSS_MS` — 90s
113. exitReasonWasLoss taxonomy

### marketStory
114. `STORY_MIN_PATH_PCT` — 0.0007
115. `STORY_CONF_MIN` — 0.4
116. `CHASE_EDGE` — 0.12
117. trekFirm mult ×1.5
118. sell/buyStruct pos 0.45 / 0.55
119. bounce/dip 1m color counts
120. EXHAUST pos 0.2 / 0.8
121. Chapter confidence table
122. scalp wick confirm

### marketContext
123. expanding range ×1.35
124. compressed range ×0.65
125. velocity lookback — 12
126. pressure fight green_share 0.38 / 0.62
127. Soft+ story-fight execFav Soft×0.95
128. Soft+ story-fight min MFE Soft×1

### traderMind
129. Mind CUT Soft×0.75 + retention 0.55
130. greenSoft arm Soft×0.95
131. deepGiveback offset keep−0.12
132. Soft+ pullback/story exec Soft×0.95
133. againstUs Soft×0.75 / Soft×0.5
134. session expectancy cut ←0.2, closes≥3
135. Entry confidence ladder (0.3–0.92)
136. left-on-table pnl < mfe×0.35
137. soft-sized loss frac Soft×0.65
138. session E bank thresholds

### manageBrain
139. MIN_SAMPLE — 3
140. sessionE protect/run weights
141. windowE protect weights
142. path-quality Soft× weights
143. 1m policy score weights
144. next-entry score weights
145. thesis/regime/story/pressure/expand/feed weights
146. pressure-with-us bands 0.58 / 0.42
147. near-Target Soft×0.85 lean BANK
148. score clamp ±2.5
149. learner override margin
150. peak_mfe_floor ease ×0.85

### Soft OFF strong signal
151. HTF aligned counts by setup
152. High-conf non-fade conf≥0.7
153. FADE allowed chapters

### regimes residual
154. `ZONE_BARS` — 180
155. `MIN_BARS_FOR_ZONE` — 90
156. `SWITCH_GAP_BARS` — 2
157. local breakout frac floor
158. Directional trek prove (×4, share≥0.35, eff≥0.4)
159. Recent leg prove (×2, share≥0.25)
160. Regime confidence map
161. Book confidence floor after switch — 0.55

### pullbackEpisode residual
162. TREND_THESIS regime set
163. Adverse / resume chapter sets
164. Episode end policy
165. Episode Soft+ bank Soft×0.95

### SAFETY SL (robotDesk) — uz smadzenēm
166. SAFETY SL pct cushion — 0.20%
167. SAFETY SL vs brokerMin ×2.5
168. SAFETY SL vs spread ×8
169. SAFETY absolute floor table
170. Scratch / Soft-MFE learn Soft×0.5 / Soft×0.75

### entryLearner
171. LR / L2 / TEMP / EXPLORE_EPS / MAX_W
172. Feature zone bins 0.35 / 0.65
173. Prior feature weights
174. Reward WAIT boost

### auto-cal bounds (kļūst genome bounds)
175. Soft/Peak/Target/RR/pct max/min caps
176. Soft tighten step
177. Peak ease / retention / giveback steps
178. safety_tp_rr step
179. MIN_ENABLED_REGIMES — 5
180. CORE_ALWAYS_ON_REGIMES
181. SOFT_PCT_REF_MID — 2750
182. Raise-streak before pullback — 2
183. Soft-sized loss detect Soft×0.65

### Genome ladder gaps (mutation physics)
184. GAP_MOVE_STAY / STAY_ENTER / ENTER_PULLBACK
185. GAP_PULLBACK_REVERSAL
186. GAP_COMPRESS_EXPAND
187. persist enter−stay min gap 0.05

---

## Ārpus saraksta (nedrīkst)

- `lot_size`
- Capital dealing-rules min stop / point size (clamp virs SAFETY)
- Sistēma: session, timers, busy, reconnect, DB, WS, auth, routing
