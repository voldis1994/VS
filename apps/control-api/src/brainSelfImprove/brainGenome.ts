/**
 * Runtime genome — thresholds the trading brain can evolve without touching lot/broker.
 * Decision code reads these via getBrainGenome(); self-improve mutates genome.json candidates.
 *
 * Trading-intelligence knobs (regime ladder, dwell/confirm, multi-TF stringency) live here
 * so Brain Self Improve can evolve market perception — not only Peak/Soft memory.
 * Soft/Peak/Target/SAFETY abs, regime-exit families, structure/story/flip, mind/manage,
 * and auto-cal bounds are schema-ready (items 45–194). Missing fields from older
 * genome.json fall back to factory (= prior hardcoded values).
 *
 * Micro price fractions (0.0008) are stored as **basis points** (8 bp). Convert live
 * with {@link regimeBpToFrac}. Abs price-pts use 0.1 grid; fractions/mults 0.01; ms ints.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


export type GenomePeakArmMode = 'reverse_1m' | 'reverse_or_mid' | 'fast';
export type GenomeStructureInvalidation =
  | 'none'
  | 'back_in_range'
  | 'through_mid'
  | 'failed_edge_reclaim';

export type BrainGenome = {
  /** Genome schema version */
  version: number;
  /** ISO timestamp of last genome write */
  updated_at: string;
  /** Peak Keep fraction (0.10–0.95) */
  peak_keep: number;
  /** Soft-sized MFE mult before Peak trail arms */
  peak_arm_soft_mult: number;
  /** Cap Peak trail floor vs Soft */
  peak_trail_soft_cap_mult: number;
  /** Peak Soft× arm when 30m story fights open side */
  story_fight_peak_arm_soft_mult: number;
  /** Soft+ giveback bank threshold */
  soft_plus_giveback: number;
  /** Continue Soft+ bank needs MFE ≥ Soft × this */
  soft_plus_runner_mult: number;
  /** Soft+ leg for deep-giveback / desk belt */
  soft_plus_leg_mult: number;
  /** Soft L2/L3 unlock — MFE must reach soft_l{n} × this */
  soft_layer_unlock_mult: number;
  /** Manage pullback-episode detect ON */
  pullback_episode_enabled: boolean;
  /** Peak Soft× arm while episode active */
  pullback_episode_peak_arm_soft_mult: number;
  /** Min Soft× MFE before Soft+ bank in episode */
  pullback_episode_min_mfe_soft_mult: number;
  /** Require 1m agree with bias before PRĀTS entry */
  require_1m_trigger: boolean;
  /** After Soft same-side loss, pause that side for N closes */
  soft_same_side_pause_closes: number;
  /** Min Soft losses same side before pause arms */
  soft_same_side_pause_min: number;
  /** Multi-TF: treat 1m fight as WAIT */
  wait_on_1m_fight: boolean;
  /** Mind BANK when Soft+ and market turns */
  mind_bank_on_turn: boolean;
  /** Monotonic explore counter */
  explore_step: number;
  /** Extra note from last accepted cycle */
  last_lesson: string;
  /** Shared 10s move floor bp */
  regime_move: number;
  /** Stay in existing trend bp */
  regime_trend_stay: number;
  /** Enter fresh trend bp */
  regime_trend_enter: number;
  /** Against-trend pullback body bp */
  regime_pullback: number;
  /** Violent reversal body bp */
  regime_reversal: number;
  /** isMoving range floor bp */
  regime_move_range: number;
  /** Compression absolute range bp */
  regime_compress_abs: number;
  /** Expansion absolute range bp */
  regime_expand_abs: number;
  /** Compression vs prior avg range mult */
  regime_compress_avg_mult: number;
  /** Expansion vs prior avg range mult */
  regime_expand_avg_mult: number;
  /** Compression near zone mid fraction */
  regime_near_zone_mid: number;
  /** Clear breakout pierce fraction of zone width */
  regime_clear_break_frac: number;
  /** Persistence to enter trend */
  regime_persist_enter: number;
  /** Persistence to stay in trend */
  regime_persist_stay: number;
  /** Persistence for pullback classify */
  regime_persist_pullback: number;
  /** Positive RANGE chop — |persistence| ≤ this */
  regime_range_chop_persist_max: number;
  /** Positive RANGE — |zoneTrek|/width ≤ this */
  regime_range_trek_share_max: number;
  /** Positive RANGE — trek efficiency ≤ this */
  regime_range_trek_eff_max: number;
  /** Soft regime switch dwell (10s bars) */
  regime_min_dwell_bars: number;
  /** Cross-family confirm bars after dwell */
  regime_confirm_bars: number;
  /** Momentum window length (10s bars) */
  regime_mom_bars: number;
  /** Persistence mean window inside mom */
  regime_persist_window: number;
  /** Trek flat if range < mid × (this bp → frac). Factory 4 bp */
  mtf_trek_flat_frac: number;
  /** When true, 30m vs 15m fight clears working bias */
  mtf_block_higher_fight: boolean;
  /** When true, sideFromMultiTf requires stack.aligned */
  mtf_require_aligned_side: boolean;
  /** When true, mind vetoes SELL vs UP 30/15 and BUY vs DOWN 30/15 */
  mtf_htf_veto: boolean;
  /** Flat-stack story allow needs story_conf ≥ this */
  entry_story_conf_min: number;
  /** Chop / weak story WAIT when story_conf < this */
  entry_chop_conf_max: number;
  /** Soft HardInv L1 abs (Gold pts at REF) */
  soft_l1_abs: number;
  /** Soft HardInv L2 abs */
  soft_l2_abs: number;
  /** Soft HardInv L3 / hardinv_abs CAP */
  soft_l3_abs: number;
  /** Soft HardInv as bp of price (8 bp ≡ 0.0008). Live: regimeBpToFrac() */
  hardinv_pct_bp: number;
  /** Peak MFE floor abs */
  peak_mfe_abs: number;
  /** Peak MFE floor as bp of price (9 bp ≡ 0.0009) */
  peak_mfe_pct_bp: number;
  /** Desk Peak Keep fraction (MindBank still uses peak_keep) */
  peak_retention: number;
  /** Min absolute giveback before Peak cuts */
  peak_min_giveback_abs: number;
  /** Target L1 abs */
  target_l1_abs: number;
  /** Target L2 abs */
  target_l2_abs: number;
  /** Target L3 / target_abs */
  target_l3_abs: number;
  /** Target as bp of price (25 bp ≡ 0.0025) */
  target_pct_bp: number;
  /** Broker SAFETY TP R:R vs SL */
  safety_tp_rr: number;
  /** Soft entry filter ladder 0…3 */
  entry_filter_level: number;
  /** Regimes allowed to open (UNKNOWN never trades) */
  enabled_regimes: string[];
  /** Soft OFF regimes — demoted, strong may still enter */
  soft_off_regimes: string[];
  /** Soft L1 fallback as frac of L3 when L1 missing */
  soft_l1_fallback_frac: number;
  /** Soft L2 fallback as frac of L3 */
  soft_l2_fallback_frac: number;
  /** Target L1 fallback as frac of L3 */
  target_l1_fallback_frac: number;
  /** Target L2 fallback as frac of L3 */
  target_l2_fallback_frac: number;
  /** Bank L1/L2 only if MFE < next layer × this */
  target_stretch_gate: number;
  /** Auto-cal Soft/Target layer percentile L1 */
  layer_suggest_p35: number;
  /** Auto-cal Soft/Target layer percentile L2 */
  layer_suggest_p60: number;
  /** Auto-cal Soft/Target layer percentile L3 */
  layer_suggest_p85: number;
  /** Target L3 must be ≥ Soft L3 × this */
  target_l3_min_vs_soft: number;
  /** Floor clamp on soft_layer_unlock_mult — factory 0.5 */
  soft_layer_unlock_floor: number;
  /** Peak MFE retention factory fallback */
  peak_mfe_retention_fallback: number;
  /** Max MFE giveback fraction */
  max_mfe_giveback: number;
  /** Soft HardInv abs floor (REF pts) */
  hardinv_abs_floor: number;
  /** Soft HardInv abs CAP */
  hardinv_abs_cap: number;
  /** Peak MFE abs floor fallback */
  peak_mfe_abs_floor: number;
  /** Soft Target abs floor fallback */
  target_abs_floor: number;
  /** SAFETY TP min R:R floor */
  safety_tp_min_rr: number;
  /** Soft HardInv grace after fill (ms) */
  hardinv_grace_ms: number;
  /** Soft HardInv breach confirm (ms) */
  hardinv_confirm_ms: number;
  /** Structure invalidation grace (ms) */
  structure_grace_ms: number;
  /** Structure breach confirm (ms) */
  structure_confirm_ms: number;
  /** TimeDecay default min hold (ms) */
  timedecay_min_hold_ms: number;
  /** TimeDecay min fav abs (REF pts) */
  timedecay_min_fav_abs: number;
  /** TimeDecay fav as bp of entry (factory 3.5 bp ≡ 0.00035) */
  timedecay_fav_pct_bp: number;
  /** Desk abs scale reference mid */
  desk_ref_mid: number;
  /** Layered Soft post-regime-mult CAP × active abs */
  layered_soft_post_mult_cap: number;
  /** BE-lock frac (deprecated Soft no longer BE-locks) */
  be_lock_frac: number;
  /** BE-lock exec frac (deprecated) */
  be_lock_exec_frac: number;
  /** minProfitBank = Soft × this */
  min_profit_bank_soft_mult: number;
  /** SAFETY TP vs minStop pillow mult */
  safety_tp_vs_min_stop_mult: number;
  /** SAFETY SL cushion as bp of price (20 bp ≡ 0.002) */
  safety_sl_cushion_bp: number;
  /** SAFETY SL ≥ broker min × this */
  safety_sl_broker_min_mult: number;
  /** SAFETY SL ≥ spread × this */
  safety_sl_spread_mult: number;
  /** SAFETY abs floor when |mid|≥1000 */
  safety_abs_floor_hi: number;
  /** SAFETY abs floor when |mid|≥100 */
  safety_abs_floor_mid: number;
  /** SAFETY abs floor when |mid|≥10 */
  safety_abs_floor_lo: number;
  /** Scratch detect: |pnl| < Soft × this */
  scratch_soft_mfe_frac: number;
  /** trend Soft HardInv mult */
  exit_trend_hardinv_mult: number;
  /** trend Peak arm mode */
  exit_trend_peak_arm: GenomePeakArmMode;
  /** trend Peak MFE floor mult */
  exit_trend_peak_mfe_mult: number;
  /** trend Peak min-giveback mult */
  exit_trend_peak_giveback_mult: number;
  /** trend Peak retention override (0 = use desk) */
  exit_trend_peak_retention: number;
  /** trend Target distance mult */
  exit_trend_target_mult: number;
  /** trend TimeDecay min hold ms */
  exit_trend_timedecay_hold_ms: number;
  /** trend TimeDecay min-fav mult */
  exit_trend_timedecay_min_fav_mult: number;
  /** trend Structure invalidation mode */
  exit_trend_structure: GenomeStructureInvalidation;
  /** pullback Soft HardInv mult */
  exit_pullback_hardinv_mult: number;
  /** pullback Peak arm mode */
  exit_pullback_peak_arm: GenomePeakArmMode;
  /** pullback Peak MFE floor mult */
  exit_pullback_peak_mfe_mult: number;
  /** pullback Peak min-giveback mult */
  exit_pullback_peak_giveback_mult: number;
  /** pullback Peak retention override (0 = use desk) */
  exit_pullback_peak_retention: number;
  /** pullback Target distance mult */
  exit_pullback_target_mult: number;
  /** pullback TimeDecay min hold ms */
  exit_pullback_timedecay_hold_ms: number;
  /** pullback TimeDecay min-fav mult */
  exit_pullback_timedecay_min_fav_mult: number;
  /** pullback Structure invalidation mode */
  exit_pullback_structure: GenomeStructureInvalidation;
  /** break Soft HardInv mult */
  exit_break_hardinv_mult: number;
  /** break Peak arm mode */
  exit_break_peak_arm: GenomePeakArmMode;
  /** break Peak MFE floor mult */
  exit_break_peak_mfe_mult: number;
  /** break Peak min-giveback mult */
  exit_break_peak_giveback_mult: number;
  /** break Peak retention override (0 = use desk) */
  exit_break_peak_retention: number;
  /** break Target distance mult */
  exit_break_target_mult: number;
  /** break TimeDecay min hold ms */
  exit_break_timedecay_hold_ms: number;
  /** break TimeDecay min-fav mult */
  exit_break_timedecay_min_fav_mult: number;
  /** break Structure invalidation mode */
  exit_break_structure: GenomeStructureInvalidation;
  /** break_fail Soft HardInv mult */
  exit_break_fail_hardinv_mult: number;
  /** break_fail Peak arm mode */
  exit_break_fail_peak_arm: GenomePeakArmMode;
  /** break_fail Peak MFE floor mult */
  exit_break_fail_peak_mfe_mult: number;
  /** break_fail Peak min-giveback mult */
  exit_break_fail_peak_giveback_mult: number;
  /** break_fail Peak retention override (0 = use desk) */
  exit_break_fail_peak_retention: number;
  /** break_fail Target distance mult */
  exit_break_fail_target_mult: number;
  /** break_fail TimeDecay min hold ms */
  exit_break_fail_timedecay_hold_ms: number;
  /** break_fail TimeDecay min-fav mult */
  exit_break_fail_timedecay_min_fav_mult: number;
  /** break_fail Structure invalidation mode */
  exit_break_fail_structure: GenomeStructureInvalidation;
  /** fade Soft HardInv mult */
  exit_fade_hardinv_mult: number;
  /** fade Peak arm mode */
  exit_fade_peak_arm: GenomePeakArmMode;
  /** fade Peak MFE floor mult */
  exit_fade_peak_mfe_mult: number;
  /** fade Peak min-giveback mult */
  exit_fade_peak_giveback_mult: number;
  /** fade Peak retention override (0 = use desk) */
  exit_fade_peak_retention: number;
  /** fade Target distance mult */
  exit_fade_target_mult: number;
  /** fade TimeDecay min hold ms */
  exit_fade_timedecay_hold_ms: number;
  /** fade TimeDecay min-fav mult */
  exit_fade_timedecay_min_fav_mult: number;
  /** fade Structure invalidation mode */
  exit_fade_structure: GenomeStructureInvalidation;
  /** expansion Soft HardInv mult */
  exit_expansion_hardinv_mult: number;
  /** expansion Peak arm mode */
  exit_expansion_peak_arm: GenomePeakArmMode;
  /** expansion Peak MFE floor mult */
  exit_expansion_peak_mfe_mult: number;
  /** expansion Peak min-giveback mult */
  exit_expansion_peak_giveback_mult: number;
  /** expansion Peak retention override (0 = use desk) */
  exit_expansion_peak_retention: number;
  /** expansion Target distance mult */
  exit_expansion_target_mult: number;
  /** expansion TimeDecay min hold ms */
  exit_expansion_timedecay_hold_ms: number;
  /** expansion TimeDecay min-fav mult */
  exit_expansion_timedecay_min_fav_mult: number;
  /** expansion Structure invalidation mode */
  exit_expansion_structure: GenomeStructureInvalidation;
  /** reversal Soft HardInv mult */
  exit_reversal_hardinv_mult: number;
  /** reversal Peak arm mode */
  exit_reversal_peak_arm: GenomePeakArmMode;
  /** reversal Peak MFE floor mult */
  exit_reversal_peak_mfe_mult: number;
  /** reversal Peak min-giveback mult */
  exit_reversal_peak_giveback_mult: number;
  /** reversal Peak retention override (0 = use desk) */
  exit_reversal_peak_retention: number;
  /** reversal Target distance mult */
  exit_reversal_target_mult: number;
  /** reversal TimeDecay min hold ms */
  exit_reversal_timedecay_hold_ms: number;
  /** reversal TimeDecay min-fav mult */
  exit_reversal_timedecay_min_fav_mult: number;
  /** reversal Structure invalidation mode */
  exit_reversal_structure: GenomeStructureInvalidation;
  /** chop Soft HardInv mult */
  exit_chop_hardinv_mult: number;
  /** chop Peak arm mode */
  exit_chop_peak_arm: GenomePeakArmMode;
  /** chop Peak MFE floor mult */
  exit_chop_peak_mfe_mult: number;
  /** chop Peak min-giveback mult */
  exit_chop_peak_giveback_mult: number;
  /** chop Peak retention override (0 = use desk) */
  exit_chop_peak_retention: number;
  /** chop Target distance mult */
  exit_chop_target_mult: number;
  /** chop TimeDecay min hold ms */
  exit_chop_timedecay_hold_ms: number;
  /** chop TimeDecay min-fav mult */
  exit_chop_timedecay_min_fav_mult: number;
  /** chop Structure invalidation mode */
  exit_chop_structure: GenomeStructureInvalidation;
  /** RANGE fade through-mid slack as width×this */
  exit_range_through_mid_slack: number;
  /** Soft profit exit requires 1m reverse/change (not continue) */
  soft_exit_require_1m_change: boolean;
  /** HOLD soft exit when next entry same side */
  soft_exit_block_same_next_entry: boolean;
  /** Zone pos extreme HI band */
  struct_extreme_hi: number;
  /** Zone pos extreme LO band */
  struct_extreme_lo: number;
  /** Structure start LO threshold */
  struct_start_lo: number;
  /** Structure start HI threshold */
  struct_start_hi: number;
  /** Half-zone LO for fade gate */
  struct_half_lo: number;
  /** Half-zone HI for fade gate */
  struct_half_hi: number;
  /** Zone band cut LO */
  zone_band_cut_lo: number;
  /** Zone band cut MID_LO */
  zone_band_cut_mid_lo: number;
  /** Zone band cut MID_HI */
  zone_band_cut_mid_hi: number;
  /** Zone band cut HI */
  zone_band_cut_hi: number;
  /** minuteTrendBias lookback (closed 1m) */
  minute_trend_bias_lookback: number;
  /** minuteTrendBias min path as bp (7 ≡ 0.0007) */
  minute_trend_bias_trek_min_path_bp: number;
  /** Min 10s bars for closed 1m aggregate */
  m1_aggregate_min_bars: number;
  /** BREAKOUT_UP pierce zone pos */
  breakout_pierce_pos_hi: number;
  /** BREAKOUT_DOWN pierce zone pos */
  breakout_pierce_pos_lo: number;
  /** Failed-break reclaim LO pos */
  failed_break_reclaim_pos_lo: number;
  /** Failed-break reclaim HI pos */
  failed_break_reclaim_pos_hi: number;
  /** COMPRESSION entry LO pos */
  compression_entry_pos_lo: number;
  /** COMPRESSION entry HI pos */
  compression_entry_pos_hi: number;
  /** Block tip-chase on EXHAUST chapters */
  exhaust_tip_chase_block: boolean;
  /** Learner may override playbook when conf ≥ thought+this */
  entry_learner_override_margin: number;
  /** SAME-DIR flip lock after close (ms) */
  same_dir_lock_ms: number;
  /** SAME-DIR lock after Soft loss (ms) */
  same_dir_lock_after_loss_ms: number;
  /** exitReasonWasLoss: HardInvalidation counts as loss */
  exit_loss_include_hardinv: boolean;
  /** exitReasonWasLoss: BE-lock Soft does NOT count as loss */
  exit_loss_exclude_be_lock: boolean;
  /** STORY_MIN_PATH as bp (7 ≡ 0.0007) */
  story_min_path_bp: number;
  /** Story confidence floor for directional allow */
  story_conf_min: number;
  /** Zone edge chase band */
  chase_edge: number;
  /** Firm trek = minPath × this */
  trek_firm_mult: number;
  /** Sell-structure zone pos ceiling */
  story_sell_struct_pos: number;
  /** Buy-structure zone pos floor */
  story_buy_struct_pos: number;
  /** red≥green+N / green≥red+N for bounce/dip */
  bounce_dip_color_delta: number;
  /** EXHAUST_LO when sellStruct and pos≤this */
  exhaust_pos_lo: number;
  /** EXHAUST_HI when buyStruct and pos≥this */
  exhaust_pos_hi: number;
  /** Chapter conf: BREAK_UP/DOWN */
  story_conf_break: number;
  /** Chapter conf: BOUNCE/DIP */
  story_conf_bounce_dip: number;
  /** Chapter conf: SELLOFF/RALLY struct */
  story_conf_struct: number;
  /** Chapter conf: recent 1m color */
  story_conf_recent: number;
  /** Chapter conf: thin trek chop */
  story_conf_chop_thin: number;
  /** Chapter conf: RANGE_CHOP */
  story_conf_chop: number;
  /** 1m scalp requires wick/body confirm vs chase */
  scalp_wick_confirm: boolean;
  /** Expanding if lastRange > avg × this */
  expanding_range_mult: number;
  /** Compressed if lastRange < avg × this */
  compressed_range_mult: number;
  /** Velocity/range lookback (10s bars) */
  velocity_lookback: number;
  /** BUY pressure-fights when green_share < this */
  pressure_fight_green_buy: number;
  /** SELL pressure-fights when green_share > this */
  pressure_fight_green_sell: number;
  /** Soft+ story-fight bank needs execFav ≥ Soft×this */
  softplus_storyfight_exec_fav_mult: number;
  /** Soft+ story-fight bank needs MFE ≥ Soft×this */
  softplus_storyfight_min_mfe_mult: number;
  /** MindCut when againstUs and MFE ≥ Soft×this */
  mind_cut_soft_mult: number;
  /** MindCut when retention < this */
  mind_cut_retention: number;
  /** greenSoft when upl ≥ Soft×this */
  green_soft_arm_mult: number;
  /** deepGiveback when retention < keep − this */
  deep_giveback_offset: number;
  /** Soft+ pullback story bank execFav mult */
  softplus_pullback_story_exec_mult: number;
  /** againstUs Soft× high band */
  against_us_soft_mult_hi: number;
  /** againstUs Soft× low band */
  against_us_soft_mult_lo: number;
  /** Session E risk flag below this */
  session_expectancy_cut: number;
  /** Mind entry confidence base */
  mind_entry_conf_base: number;
  /** left-on-table: ≥N tiny Peak closes */
  left_on_table_peak_tiny_min: number;
  /** Soft-sized loss |pnl| ≥ SoftCap×this */
  soft_sized_loss_frac: number;
  /** Session E high — let winners run */
  session_e_bank_hi: number;
  /** Session E low — protect sooner */
  session_e_bank_lo: number;
  /** Min closes before session-E score active */
  manage_min_sample: number;
  /** Score + when sessionE < lo */
  manage_score_session_e_neg: number;
  /** Score − when sessionE > hi */
  manage_score_session_e_pos: number;
  /** Score + when windowE weak */
  manage_score_window_e_neg: number;
  /** Path quality soft-green weight */
  manage_score_path_soft_green: number;
  /** Path giveback weight */
  manage_score_path_giveback: number;
  /** 1m reverse policy weight */
  manage_score_m1_reverse: number;
  /** 1m continue policy weight */
  manage_score_m1_continue: number;
  /** Opposite next-entry weight */
  manage_score_next_entry_opp: number;
  /** Thesis/regime/story fight weight */
  manage_score_thesis_fight: number;
  /** Pressure with BUY when green≥this */
  pressure_with_us_buy: number;
  /** Pressure with SELL when green≤this */
  pressure_with_us_sell: number;
  /** Near-target lean bank when upl ≥ target×this */
  near_target_lean_bank: number;
  /** Manage score clamp ±this */
  manage_score_clamp: number;
  /** Manage learner override margin */
  manage_learner_override_margin: number;
  /** BANK/CUT ease Peak MFE floor × this */
  peak_mfe_floor_ease: number;
  /** Strong signal needs ≥N HTF aligned */
  strong_htf_aligned_min: number;
  /** Strong signal story conf min */
  strong_conf_min: number;
  /** FADE Soft-OFF allowed chapters */
  fade_allowed_chapters: string[];
  /** Regime zone window (10s bars) */
  zone_bars: number;
  /** Min bars before zone classify */
  min_bars_for_zone: number;
  /** Bars after switch before re-pend */
  switch_gap_bars: number;
  /** Local shelf breakout frac floor */
  local_breakout_frac_floor: number;
  /** Full trek |zoneTrek| ≥ TREND_ENTER × this */
  trek_full_enter_mult: number;
  /** Full trek share min */
  trek_share_min: number;
  /** Full trek efficiency min */
  trek_eff_min: number;
  /** Recent leg |recentLeg| ≥ TREND_ENTER × this */
  trek_recent_enter_mult: number;
  /** Recent leg share min */
  trek_recent_share_min: number;
  /** Regime confidence map base */
  regime_conf_base: number;
  /** Regime confidence + strength×this */
  regime_conf_strength_scale: number;
  /** Regime confidence clamp min */
  regime_conf_min: number;
  /** Regime confidence clamp max */
  regime_conf_max: number;
  /** Book confidence floor after switch */
  book_confidence_floor_after_switch: number;
  /** Soft MOVE tip against trek → pullback shortcut */
  soft_move_trek_pullback_shortcut: boolean;
  /** Chop→trend pending confirm bars (factory 1 = prior immediate strong flip) */
  chop_to_trend_confirm_bars: number;
  /** Sticky prior instead of dead TRANSITION */
  sticky_prior_enabled: boolean;
  /** TRANSITION detect (false = sticky prior path) */
  transition_detect_enabled: boolean;
  /** Unify playbook promote vs live regime */
  playbook_promote_vs_live_unify: boolean;
  /** EXPANSION priority before TREND when both fire */
  expansion_before_trend: boolean;
  /** TREND thesis regime set for episodes */
  trend_thesis_regimes: string[];
  /** Adverse chapters vs SELL open */
  adverse_chapters_sell: string[];
  /** Adverse chapters vs BUY open */
  adverse_chapters_buy: string[];
  /** Resume chapters with SELL */
  resume_chapters_sell: string[];
  /** Resume chapters with BUY */
  resume_chapters_buy: string[];
  /** End episode on 1m continue with side */
  episode_end_on_continue: boolean;
  /** Soft+ bank Soft× while episode active */
  episode_softplus_bank_mult: number;
  /** EntryLearner learning rate */
  entry_learner_lr: number;
  /** EntryLearner L2 weight decay */
  entry_learner_l2: number;
  /** EntryLearner softmax temperature */
  entry_learner_temp: number;
  /** EntryLearner explore epsilon */
  entry_learner_explore_eps: number;
  /** EntryLearner weight clamp */
  entry_learner_max_w: number;
  /** Feature zone_lo when pos ≤ this */
  entry_zone_lo_bin: number;
  /** Feature zone_hi when pos ≥ this */
  entry_zone_hi_bin: number;
  /** WAIT reward boost mult on update */
  entry_learner_wait_boost: number;
  /** Auto-cal SAFETY TP RR cap */
  auto_cal_max_safety_tp_rr: number;
  /** Auto-cal Target abs cap */
  auto_cal_max_target_abs: number;
  /** Auto-cal Peak MFE abs cap */
  auto_cal_max_peak_mfe_abs: number;
  /** Auto-cal Peak retention cap */
  auto_cal_max_peak_retention: number;
  /** Auto-cal Peak retention floor */
  auto_cal_min_peak_retention: number;
  /** Auto-cal Soft CAP floor */
  auto_cal_min_hardinv_abs: number;
  /** Auto-cal Soft CAP ceiling */
  auto_cal_max_hardinv_abs: number;
  /** Soft CAP tighten step (abs) */
  soft_tighten_step: number;
  /** Peak MFE ease step (abs) */
  peak_ease_abs_step: number;
  /** Peak retention ease/tighten step */
  peak_ease_retention_step: number;
  /** Peak min-giveback ease step */
  peak_ease_giveback_step: number;
  /** SAFETY TP RR raise step */
  safety_tp_rr_step: number;
  /** SAFETY TP RR pullback step */
  safety_tp_rr_pullback_step: number;
  /** Never drop allowlist below this */
  min_enabled_regimes: number;
  /** Preferred liquid regimes at factory open */
  core_always_on_regimes: string[];
  /** Soft pct derived from Soft abs / this mid */
  soft_pct_ref_mid: number;
  /** Consecutive raise cycles before pullback */
  raise_streak_before_pullback: number;
  /** Soft-sized loss count to trigger Soft path */
  soft_sized_loss_detect_min: number;
  /** Regime ladder gap MOVE→STAY (bp) */
  gap_move_stay: number;
  /** Regime ladder gap STAY→ENTER (bp) */
  gap_stay_enter: number;
  /** Regime ladder gap ENTER→PULLBACK (bp) */
  gap_enter_pullback: number;
  /** Regime ladder gap PULLBACK→REVERSAL (bp) */
  gap_pullback_reversal: number;
  /** Regime ladder gap COMPRESS→EXPAND (bp) */
  gap_compress_expand: number;
  /** Min persist_enter − persist_stay gap */
  persist_enter_stay_min_gap: number;
};

/** Factory enabled regimes — all tradable; UNKNOWN never included. */
const DEFAULT_ENABLED_REGIMES: string[] = [
  'RANGE',
  'TREND_UP',
  'TREND_DOWN',
  'PULLBACK_UPTREND',
  'PULLBACK_DOWNTREND',
  'COMPRESSION',
  'EXPANSION',
  'BREAKOUT_UP',
  'BREAKOUT_DOWN',
  'FAILED_BREAKOUT_UP',
  'FAILED_BREAKOUT_DOWN',
  'REVERSAL_CANDIDATE',
  'TRANSITION',
];

const DEFAULT_CORE_ALWAYS_ON: string[] = [
  'RANGE',
  'TREND_UP',
  'TREND_DOWN',
  'PULLBACK_UPTREND',
  'PULLBACK_DOWNTREND',
  'EXPANSION',
  'COMPRESSION',
  'TRANSITION',
];

const DEFAULT_TREND_THESIS: string[] = [
  'TREND_UP',
  'TREND_DOWN',
  'PULLBACK_UPTREND',
  'PULLBACK_DOWNTREND',
];

const DEFAULT_ADVERSE_SELL: string[] = ['BOUNCE_IN_SELL', 'EXHAUST_LO', 'RALLY', 'BREAK_UP'];
const DEFAULT_ADVERSE_BUY: string[] = ['DIP_IN_RALLY', 'EXHAUST_HI', 'SELLOFF', 'BREAK_DOWN'];
const DEFAULT_RESUME_SELL: string[] = ['SELLOFF', 'BREAK_DOWN'];
const DEFAULT_RESUME_BUY: string[] = ['RALLY', 'BREAK_UP'];
const DEFAULT_FADE_CHAPTERS: string[] = [
  'EXHAUST_HI',
  'EXHAUST_LO',
  'FAILED_BREAKOUT_UP',
  'FAILED_BREAKOUT_DOWN',
  'BOUNCE_IN_SELL',
  'DIP_IN_RALLY',
];

const KNOWN_REGIMES = new Set<string>([
  ...DEFAULT_ENABLED_REGIMES,
  'UNKNOWN',
]);


/** Factory = prior hardcoded behaviour across desk/exit/regime/structure/mind. */
const DEFAULT_GENOME: BrainGenome = {
  version: 1,
  updated_at: new Date(0).toISOString(),
  peak_keep: 0.75,
  peak_arm_soft_mult: 1.35,
  peak_trail_soft_cap_mult: 1.75,
  story_fight_peak_arm_soft_mult: 1,
  soft_plus_giveback: 0.75,
  soft_plus_runner_mult: 1.5,
  soft_plus_leg_mult: 1.35,
  soft_layer_unlock_mult: 1,
  pullback_episode_enabled: true,
  pullback_episode_peak_arm_soft_mult: 1,
  pullback_episode_min_mfe_soft_mult: 0.5,
  require_1m_trigger: true,
  soft_same_side_pause_closes: 4,
  soft_same_side_pause_min: 2,
  wait_on_1m_fight: true,
  mind_bank_on_turn: true,
  explore_step: 0,
  last_lesson: 'factory genome',
  regime_move: 0.8,
  regime_trend_stay: 2.2,
  regime_trend_enter: 3.8,
  regime_pullback: 5.5,
  regime_reversal: 16,
  regime_move_range: 1.2,
  regime_compress_abs: 0.6,
  regime_expand_abs: 6,
  regime_compress_avg_mult: 0.35,
  regime_expand_avg_mult: 1.65,
  regime_near_zone_mid: 0.28,
  regime_clear_break_frac: 0.25,
  regime_persist_enter: 0.5,
  regime_persist_stay: 0.3,
  regime_persist_pullback: 0.2,
  regime_range_chop_persist_max: 0.25,
  regime_range_trek_share_max: 0.32,
  regime_range_trek_eff_max: 0.45,
  regime_min_dwell_bars: 5,
  regime_confirm_bars: 3,
  regime_mom_bars: 8,
  regime_persist_window: 6,
  mtf_trek_flat_frac: 4,
  mtf_block_higher_fight: true,
  mtf_require_aligned_side: true,
  mtf_htf_veto: true,
  entry_story_conf_min: 0.55,
  entry_chop_conf_max: 0.45,
  soft_l1_abs: 1.2,
  soft_l2_abs: 1.8,
  soft_l3_abs: 2.2,
  hardinv_pct_bp: 8,
  peak_mfe_abs: 3,
  peak_mfe_pct_bp: 9,
  peak_retention: 0.72,
  peak_min_giveback_abs: 0.85,
  target_l1_abs: 2.5,
  target_l2_abs: 3.5,
  target_l3_abs: 5,
  target_pct_bp: 25,
  safety_tp_rr: 1.5,
  entry_filter_level: 0,
  enabled_regimes: DEFAULT_ENABLED_REGIMES,
  soft_off_regimes: [],
  soft_l1_fallback_frac: 0.55,
  soft_l2_fallback_frac: 0.8,
  target_l1_fallback_frac: 0.5,
  target_l2_fallback_frac: 0.7,
  target_stretch_gate: 0.85,
  layer_suggest_p35: 0.35,
  layer_suggest_p60: 0.6,
  layer_suggest_p85: 0.85,
  target_l3_min_vs_soft: 1.2,
  soft_layer_unlock_floor: 0.5,
  peak_mfe_retention_fallback: 0.72,
  max_mfe_giveback: 0.35,
  hardinv_abs_floor: 1.5,
  hardinv_abs_cap: 2.2,
  peak_mfe_abs_floor: 3,
  target_abs_floor: 4,
  safety_tp_min_rr: 1.5,
  hardinv_grace_ms: 12000,
  hardinv_confirm_ms: 5000,
  structure_grace_ms: 8000,
  structure_confirm_ms: 3000,
  timedecay_min_hold_ms: 720000,
  timedecay_min_fav_abs: 2,
  timedecay_fav_pct_bp: 3.5,
  desk_ref_mid: 2000,
  layered_soft_post_mult_cap: 1.3,
  be_lock_frac: 0,
  be_lock_exec_frac: 0.25,
  min_profit_bank_soft_mult: 1,
  safety_tp_vs_min_stop_mult: 1.05,
  safety_sl_cushion_bp: 20,
  safety_sl_broker_min_mult: 2.5,
  safety_sl_spread_mult: 8,
  safety_abs_floor_hi: 0.5,
  safety_abs_floor_mid: 0.25,
  safety_abs_floor_lo: 0.05,
  scratch_soft_mfe_frac: 0.5,
  exit_trend_hardinv_mult: 1,
  exit_trend_peak_arm: 'reverse_1m',
  exit_trend_peak_mfe_mult: 1,
  exit_trend_peak_giveback_mult: 1,
  exit_trend_peak_retention: 0,
  exit_trend_target_mult: 1.15,
  exit_trend_timedecay_hold_ms: 840000,
  exit_trend_timedecay_min_fav_mult: 1,
  exit_trend_structure: 'none',
  exit_pullback_hardinv_mult: 0.9,
  exit_pullback_peak_arm: 'reverse_1m',
  exit_pullback_peak_mfe_mult: 1,
  exit_pullback_peak_giveback_mult: 1,
  exit_pullback_peak_retention: 0,
  exit_pullback_target_mult: 1.05,
  exit_pullback_timedecay_hold_ms: 660000,
  exit_pullback_timedecay_min_fav_mult: 0.95,
  exit_pullback_structure: 'none',
  exit_break_hardinv_mult: 0.85,
  exit_break_peak_arm: 'reverse_1m',
  exit_break_peak_mfe_mult: 1,
  exit_break_peak_giveback_mult: 1,
  exit_break_peak_retention: 0,
  exit_break_target_mult: 1.2,
  exit_break_timedecay_hold_ms: 720000,
  exit_break_timedecay_min_fav_mult: 1,
  exit_break_structure: 'back_in_range',
  exit_break_fail_hardinv_mult: 0.95,
  exit_break_fail_peak_arm: 'reverse_or_mid',
  exit_break_fail_peak_mfe_mult: 1,
  exit_break_fail_peak_giveback_mult: 1,
  exit_break_fail_peak_retention: 0.7,
  exit_break_fail_target_mult: 1,
  exit_break_fail_timedecay_hold_ms: 420000,
  exit_break_fail_timedecay_min_fav_mult: 0.85,
  exit_break_fail_structure: 'failed_edge_reclaim',
  exit_fade_hardinv_mult: 1,
  exit_fade_peak_arm: 'reverse_or_mid',
  exit_fade_peak_mfe_mult: 1,
  exit_fade_peak_giveback_mult: 1,
  exit_fade_peak_retention: 0.7,
  exit_fade_target_mult: 1.05,
  exit_fade_timedecay_hold_ms: 420000,
  exit_fade_timedecay_min_fav_mult: 0.85,
  exit_fade_structure: 'through_mid',
  exit_expansion_hardinv_mult: 1,
  exit_expansion_peak_arm: 'reverse_1m',
  exit_expansion_peak_mfe_mult: 1,
  exit_expansion_peak_giveback_mult: 1,
  exit_expansion_peak_retention: 0,
  exit_expansion_target_mult: 1.1,
  exit_expansion_timedecay_hold_ms: 540000,
  exit_expansion_timedecay_min_fav_mult: 0.9,
  exit_expansion_structure: 'none',
  exit_reversal_hardinv_mult: 0.8,
  exit_reversal_peak_arm: 'fast',
  exit_reversal_peak_mfe_mult: 1,
  exit_reversal_peak_giveback_mult: 1,
  exit_reversal_peak_retention: 0.7,
  exit_reversal_target_mult: 1.05,
  exit_reversal_timedecay_hold_ms: 300000,
  exit_reversal_timedecay_min_fav_mult: 0.85,
  exit_reversal_structure: 'none',
  exit_chop_hardinv_mult: 0.95,
  exit_chop_peak_arm: 'fast',
  exit_chop_peak_mfe_mult: 1,
  exit_chop_peak_giveback_mult: 1,
  exit_chop_peak_retention: 0.7,
  exit_chop_target_mult: 1,
  exit_chop_timedecay_hold_ms: 300000,
  exit_chop_timedecay_min_fav_mult: 0.85,
  exit_chop_structure: 'none',
  exit_range_through_mid_slack: 0.05,
  soft_exit_require_1m_change: true,
  soft_exit_block_same_next_entry: true,
  struct_extreme_hi: 0.85,
  struct_extreme_lo: 0.15,
  struct_start_lo: 0.65,
  struct_start_hi: 0.35,
  struct_half_lo: 0.5,
  struct_half_hi: 0.5,
  zone_band_cut_lo: 0.2,
  zone_band_cut_mid_lo: 0.4,
  zone_band_cut_mid_hi: 0.6,
  zone_band_cut_hi: 0.8,
  minute_trend_bias_lookback: 5,
  minute_trend_bias_trek_min_path_bp: 7,
  m1_aggregate_min_bars: 3,
  breakout_pierce_pos_hi: 0.92,
  breakout_pierce_pos_lo: 0.08,
  failed_break_reclaim_pos_lo: 0.2,
  failed_break_reclaim_pos_hi: 0.8,
  compression_entry_pos_lo: 0.35,
  compression_entry_pos_hi: 0.65,
  exhaust_tip_chase_block: true,
  entry_learner_override_margin: 0.08,
  same_dir_lock_ms: 90000,
  same_dir_lock_after_loss_ms: 90000,
  exit_loss_include_hardinv: true,
  exit_loss_exclude_be_lock: true,
  story_min_path_bp: 7,
  story_conf_min: 0.4,
  chase_edge: 0.12,
  trek_firm_mult: 1.5,
  story_sell_struct_pos: 0.45,
  story_buy_struct_pos: 0.55,
  bounce_dip_color_delta: 2,
  exhaust_pos_lo: 0.2,
  exhaust_pos_hi: 0.8,
  story_conf_break: 0.8,
  story_conf_bounce_dip: 0.85,
  story_conf_struct: 0.75,
  story_conf_recent: 0.7,
  story_conf_chop_thin: 0.35,
  story_conf_chop: 0.4,
  scalp_wick_confirm: true,
  expanding_range_mult: 1.35,
  compressed_range_mult: 0.65,
  velocity_lookback: 12,
  pressure_fight_green_buy: 0.38,
  pressure_fight_green_sell: 0.62,
  softplus_storyfight_exec_fav_mult: 0.95,
  softplus_storyfight_min_mfe_mult: 1,
  mind_cut_soft_mult: 0.75,
  mind_cut_retention: 0.55,
  green_soft_arm_mult: 0.95,
  deep_giveback_offset: 0.12,
  softplus_pullback_story_exec_mult: 0.95,
  against_us_soft_mult_hi: 0.75,
  against_us_soft_mult_lo: 0.5,
  session_expectancy_cut: -0.2,
  mind_entry_conf_base: 0.55,
  left_on_table_peak_tiny_min: 2,
  soft_sized_loss_frac: 0.65,
  session_e_bank_hi: 0.25,
  session_e_bank_lo: -0.15,
  manage_min_sample: 3,
  manage_score_session_e_neg: 0.7,
  manage_score_session_e_pos: 0.35,
  manage_score_window_e_neg: 0.55,
  manage_score_path_soft_green: 0.25,
  manage_score_path_giveback: 0.9,
  manage_score_m1_reverse: 0.95,
  manage_score_m1_continue: 0.85,
  manage_score_next_entry_opp: 0.7,
  manage_score_thesis_fight: 0.55,
  pressure_with_us_buy: 0.58,
  pressure_with_us_sell: 0.42,
  near_target_lean_bank: 0.85,
  manage_score_clamp: 2.5,
  manage_learner_override_margin: 0.08,
  peak_mfe_floor_ease: 0.85,
  strong_htf_aligned_min: 2,
  strong_conf_min: 0.7,
  fade_allowed_chapters: DEFAULT_FADE_CHAPTERS,
  zone_bars: 180,
  min_bars_for_zone: 90,
  switch_gap_bars: 2,
  local_breakout_frac_floor: 0.12,
  trek_full_enter_mult: 4,
  trek_share_min: 0.35,
  trek_eff_min: 0.4,
  trek_recent_enter_mult: 2,
  trek_recent_share_min: 0.25,
  regime_conf_base: 0.35,
  regime_conf_strength_scale: 0.5,
  regime_conf_min: 0.2,
  regime_conf_max: 0.95,
  book_confidence_floor_after_switch: 0.55,
  soft_move_trek_pullback_shortcut: true,
  chop_to_trend_confirm_bars: 1,
  sticky_prior_enabled: true,
  transition_detect_enabled: false,
  playbook_promote_vs_live_unify: true,
  expansion_before_trend: false,
  trend_thesis_regimes: DEFAULT_TREND_THESIS,
  adverse_chapters_sell: DEFAULT_ADVERSE_SELL,
  adverse_chapters_buy: DEFAULT_ADVERSE_BUY,
  resume_chapters_sell: DEFAULT_RESUME_SELL,
  resume_chapters_buy: DEFAULT_RESUME_BUY,
  episode_end_on_continue: true,
  episode_softplus_bank_mult: 1,
  entry_learner_lr: 0.1,
  entry_learner_l2: 0.002,
  entry_learner_temp: 0.9,
  entry_learner_explore_eps: 0.05,
  entry_learner_max_w: 4,
  entry_zone_lo_bin: 0.35,
  entry_zone_hi_bin: 0.65,
  entry_learner_wait_boost: 0.35,
  auto_cal_max_safety_tp_rr: 3,
  auto_cal_max_target_abs: 12,
  auto_cal_max_peak_mfe_abs: 8,
  auto_cal_max_peak_retention: 0.95,
  auto_cal_min_peak_retention: 0.1,
  auto_cal_min_hardinv_abs: 0.5,
  auto_cal_max_hardinv_abs: 8,
  soft_tighten_step: 0.3,
  peak_ease_abs_step: 0.5,
  peak_ease_retention_step: 0.05,
  peak_ease_giveback_step: 0.15,
  safety_tp_rr_step: 0.15,
  safety_tp_rr_pullback_step: 0.25,
  min_enabled_regimes: 5,
  core_always_on_regimes: DEFAULT_CORE_ALWAYS_ON,
  soft_pct_ref_mid: 2750,
  raise_streak_before_pullback: 2,
  soft_sized_loss_detect_min: 2,
  gap_move_stay: 1,
  gap_stay_enter: 1,
  gap_enter_pullback: 1,
  gap_pullback_reversal: 5,
  gap_compress_expand: 3.5,
  persist_enter_stay_min_gap: 0.05,};

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../');
}

export function genomePath(): string {
  const env = process.env.BRAIN_GENOME_PATH?.trim();
  if (env) return env;
  return path.join(repoRoot(), 'data', 'brain-self-improve', 'genome.json');
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clampInt(raw: unknown, fb: number, lo: number, hi: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fb;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Genome body/range/trek unit: basis points of price.
 * 1 bp = 0.0001 fraction = 0.01% of mid. Factory MOVE 0.8 bp ≡ old 0.00008.
 * Live classify always converts via {@link regimeBpToFrac}.
 */
export const REGIME_BP = 1e-4;

/** bp → price fraction for classify / isMoving / trek / Soft pct knobs. */
export function regimeBpToFrac(bp: number): number {
  return Math.max(0, Number(bp) || 0) * REGIME_BP;
}

/** Round to 1 decimal — min human step 0.1 (no 0.00008 dust → round-to-0). */
export function roundRegimeBp(n: number): number {
  return Math.round(clamp(n, 0.1, 1e6) * 10) / 10;
}

function bumpAbove(floor: number, gap: number): number {
  return roundRegimeBp(floor + gap);
}

/**
 * Legacy genome.json / desk used price fractions (0.00008 / 0.0008).
 * New scale is bp (0.8 / 8). Detect fraction payloads and ×10000 once.
 */
function coerceRegimeBp(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n > 0 && n < 0.05) return roundRegimeBp(n * 10_000);
  return roundRegimeBp(n);
}

/** Soft/Peak/Target pct micro → bp (0.0008 → 8). Also accepts already-bp values. */
function coerceMicroBp(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  // Fraction era: hardinv_pct 0.0008, target_pct 0.0025, safety 0.002
  if (n > 0 && n < 0.05) return roundRegimeBp(n * 10_000);
  return roundRegimeBp(n);
}

function sanitizePeakArm(raw: unknown, fb: string): GenomePeakArmMode {
  const s = String(raw || fb);
  if (s === 'reverse_1m' || s === 'reverse_or_mid' || s === 'fast') return s;
  return fb as GenomePeakArmMode;
}

function sanitizeStructure(raw: unknown, fb: string): GenomeStructureInvalidation {
  const s = String(raw || fb);
  if (
    s === 'none' ||
    s === 'back_in_range' ||
    s === 'through_mid' ||
    s === 'failed_edge_reclaim'
  ) {
    return s;
  }
  return fb as GenomeStructureInvalidation;
}

function sanitizeStringArray(raw: unknown, fb: string[]): string[] {
  if (!Array.isArray(raw)) return [...fb];
  const out = [
    ...new Set(
      raw
        .map((x) => String(x || '').trim().toUpperCase())
        .filter((x) => x.length > 0 && x.length < 64)
    ),
  ];
  return out.length ? out : [...fb];
}

function sanitizeEnabledRegimes(raw: unknown, fb: string[]): string[] {
  if (!Array.isArray(raw)) return [...fb];
  const out = [
    ...new Set(
      raw
        .map((x) => String(x || '').trim().toUpperCase())
        .filter((x) => KNOWN_REGIMES.has(x) && x !== 'UNKNOWN')
    ),
  ];
  return out;
}

function sanitizeSoftOffRegimes(raw: unknown, enabled: string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const en = new Set(enabled);
  return [
    ...new Set(
      raw
        .map((x) => String(x || '').trim().toUpperCase())
        .filter((x) => KNOWN_REGIMES.has(x) && x !== 'UNKNOWN' && !en.has(x))
    ),
  ];
}

/**
 * Migrate legacy desk-style keys on old genome blobs:
 * hardinv_pct / peak_mfe_pct / target_pct (fractions) → *_pct_bp
 * hardinv_abs → soft_l3_abs; target_abs → target_l3_abs
 */
function migrateLegacyDeskKeys(p: Record<string, unknown>): void {
  if (p.hardinv_pct_bp == null && p.hardinv_pct != null) {
    p.hardinv_pct_bp = p.hardinv_pct;
  }
  if (p.peak_mfe_pct_bp == null && p.peak_mfe_pct != null) {
    p.peak_mfe_pct_bp = p.peak_mfe_pct;
  }
  if (p.target_pct_bp == null && p.target_pct != null) {
    p.target_pct_bp = p.target_pct;
  }
  if (p.soft_l3_abs == null && p.hardinv_abs != null) {
    p.soft_l3_abs = p.hardinv_abs;
  }
  if (p.target_l3_abs == null && p.target_abs != null) {
    p.target_l3_abs = p.target_abs;
  }
  if (p.safety_sl_cushion_bp == null && p.safety_sl_pct != null) {
    p.safety_sl_cushion_bp = p.safety_sl_pct;
  }
}

function enforceSoftTargetLadder(g: BrainGenome): void {
  const soft = [g.soft_l1_abs, g.soft_l2_abs, g.soft_l3_abs].sort((a, b) => a - b);
  g.soft_l1_abs = soft[0]!;
  g.soft_l2_abs = soft[1]!;
  g.soft_l3_abs = soft[2]!;
  g.hardinv_abs_cap = g.soft_l3_abs;
  const tgt = [g.target_l1_abs, g.target_l2_abs, g.target_l3_abs].sort((a, b) => a - b);
  g.target_l1_abs = tgt[0]!;
  g.target_l2_abs = tgt[1]!;
  g.target_l3_abs = tgt[2]!;
  // Target L3 ≥ Soft L3 × min
  const minT3 = round1(g.soft_l3_abs * g.target_l3_min_vs_soft);
  if (g.target_l3_abs < minT3) g.target_l3_abs = minT3;
}

function enforceRegimeLadder(g: BrainGenome): void {
  const GAP_MOVE_STAY = g.gap_move_stay;
  const GAP_STAY_ENTER = g.gap_stay_enter;
  const GAP_ENTER_PULLBACK = g.gap_enter_pullback;
  const GAP_PULLBACK_REVERSAL = g.gap_pullback_reversal;
  const GAP_COMPRESS_EXPAND = g.gap_compress_expand;
  const persistGap = g.persist_enter_stay_min_gap;

  if (!(g.regime_compress_abs < g.regime_move)) {
    g.regime_compress_abs = roundRegimeBp(Math.min(g.regime_compress_abs, g.regime_move - 0.1));
  }
  if (g.regime_trend_stay < g.regime_move + GAP_MOVE_STAY) {
    g.regime_trend_stay = bumpAbove(g.regime_move, GAP_MOVE_STAY);
  }
  if (g.regime_trend_enter < g.regime_trend_stay + GAP_STAY_ENTER) {
    g.regime_trend_enter = bumpAbove(g.regime_trend_stay, GAP_STAY_ENTER);
  }
  if (g.regime_pullback < g.regime_trend_enter + GAP_ENTER_PULLBACK) {
    g.regime_pullback = bumpAbove(g.regime_trend_enter, GAP_ENTER_PULLBACK);
  }
  if (g.regime_reversal < g.regime_pullback + GAP_PULLBACK_REVERSAL) {
    g.regime_reversal = bumpAbove(g.regime_pullback, GAP_PULLBACK_REVERSAL);
  }
  if (!(g.regime_move <= g.regime_move_range)) {
    g.regime_move_range = g.regime_move;
  }
  if (!(g.regime_move_range <= g.regime_trend_stay)) {
    g.regime_move_range = g.regime_trend_stay;
  }
  if (g.regime_expand_abs <= g.regime_trend_enter) {
    g.regime_expand_abs = bumpAbove(g.regime_trend_enter, GAP_STAY_ENTER);
  }
  if (g.regime_expand_abs - g.regime_compress_abs < GAP_COMPRESS_EXPAND) {
    g.regime_expand_abs = roundRegimeBp(g.regime_compress_abs + GAP_COMPRESS_EXPAND);
  }
  if (!(g.regime_persist_stay <= g.regime_persist_enter)) {
    g.regime_persist_stay = Math.min(g.regime_persist_stay, g.regime_persist_enter);
  }
  if (!(g.regime_persist_pullback <= g.regime_persist_enter)) {
    g.regime_persist_pullback = Math.min(g.regime_persist_pullback, g.regime_persist_enter);
  }
  if (g.regime_persist_enter - g.regime_persist_stay < persistGap - 1e-12) {
    g.regime_persist_stay =
      Math.round(Math.max(0.1, g.regime_persist_enter - persistGap) * 100) / 100;
  }
}


export function sanitizeGenome(raw: Partial<BrainGenome> | null | undefined): BrainGenome {
  const p0 = { ...(raw || {}) } as Record<string, unknown>;
  migrateLegacyDeskKeys(p0);
  const p = p0 as Partial<BrainGenome> & Record<string, unknown>;
  const d = DEFAULT_GENOME;

  const g: BrainGenome = {
    version: Math.max(1, Math.floor(Number(p.version) || 1)),
    updated_at: String(p.updated_at || new Date().toISOString()),
    peak_keep: round2(clamp(Number(p.peak_keep ?? d.peak_keep), 0.1, 0.95)),
    peak_arm_soft_mult: round2(clamp(Number(p.peak_arm_soft_mult ?? d.peak_arm_soft_mult), 0.5, 2.0)),
    peak_trail_soft_cap_mult: round2(clamp(Number(p.peak_trail_soft_cap_mult ?? d.peak_trail_soft_cap_mult), 1.2, 2.5)),
    story_fight_peak_arm_soft_mult: round2(clamp(Number(p.story_fight_peak_arm_soft_mult ?? d.story_fight_peak_arm_soft_mult), 0.5, 1.35)),
    soft_plus_giveback: round2(clamp(Number(p.soft_plus_giveback ?? d.soft_plus_giveback), 0.55, 0.85)),
    soft_plus_runner_mult: round2(clamp(Number(p.soft_plus_runner_mult ?? d.soft_plus_runner_mult), 1.1, 2.5)),
    soft_plus_leg_mult: round2(clamp(Number(p.soft_plus_leg_mult ?? d.soft_plus_leg_mult), 1.0, 2.0)),
    soft_layer_unlock_mult: round2(clamp(Number(p.soft_layer_unlock_mult ?? d.soft_layer_unlock_mult), 0.5, 1.5)),
    pullback_episode_enabled: p.pullback_episode_enabled !== false,
    pullback_episode_peak_arm_soft_mult: round2(clamp(Number(p.pullback_episode_peak_arm_soft_mult ?? d.pullback_episode_peak_arm_soft_mult), 0.5, 1.35)),
    pullback_episode_min_mfe_soft_mult: round2(clamp(Number(p.pullback_episode_min_mfe_soft_mult ?? d.pullback_episode_min_mfe_soft_mult), 0.25, 1.0)),
    require_1m_trigger: p.require_1m_trigger !== false,
    soft_same_side_pause_closes: clampInt(p.soft_same_side_pause_closes, d.soft_same_side_pause_closes, 1, 12),
    soft_same_side_pause_min: clampInt(p.soft_same_side_pause_min, d.soft_same_side_pause_min, 1, 6),
    wait_on_1m_fight: p.wait_on_1m_fight !== false,
    mind_bank_on_turn: p.mind_bank_on_turn !== false,
    explore_step: clampInt(p.explore_step, d.explore_step, 0, 1000000000),
    last_lesson: String(p.last_lesson || d.last_lesson).slice(0, 240),
    regime_move: clamp(coerceRegimeBp(p.regime_move, d.regime_move), 0.4, 2.0),
    regime_trend_stay: clamp(coerceRegimeBp(p.regime_trend_stay, d.regime_trend_stay), 1.0, 5.0),
    regime_trend_enter: clamp(coerceRegimeBp(p.regime_trend_enter, d.regime_trend_enter), 2.0, 8.0),
    regime_pullback: clamp(coerceRegimeBp(p.regime_pullback, d.regime_pullback), 3.0, 12.0),
    regime_reversal: clamp(coerceRegimeBp(p.regime_reversal, d.regime_reversal), 8.0, 40.0),
    regime_move_range: clamp(coerceRegimeBp(p.regime_move_range, d.regime_move_range), 0.6, 4.0),
    regime_compress_abs: clamp(coerceRegimeBp(p.regime_compress_abs, d.regime_compress_abs), 0.2, 1.2),
    regime_expand_abs: clamp(coerceRegimeBp(p.regime_expand_abs, d.regime_expand_abs), 3.0, 20.0),
    regime_compress_avg_mult: round2(clamp(Number(p.regime_compress_avg_mult ?? d.regime_compress_avg_mult), 0.15, 0.7)),
    regime_expand_avg_mult: round2(clamp(Number(p.regime_expand_avg_mult ?? d.regime_expand_avg_mult), 1.2, 2.5)),
    regime_near_zone_mid: round2(clamp(Number(p.regime_near_zone_mid ?? d.regime_near_zone_mid), 0.12, 0.45)),
    regime_clear_break_frac: round2(clamp(Number(p.regime_clear_break_frac ?? d.regime_clear_break_frac), 0.1, 0.5)),
    regime_persist_enter: round2(clamp(Number(p.regime_persist_enter ?? d.regime_persist_enter), 0.25, 0.85)),
    regime_persist_stay: round2(clamp(Number(p.regime_persist_stay ?? d.regime_persist_stay), 0.1, 0.7)),
    regime_persist_pullback: round2(clamp(Number(p.regime_persist_pullback ?? d.regime_persist_pullback), 0.1, 0.6)),
    regime_range_chop_persist_max: round2(clamp(Number(p.regime_range_chop_persist_max ?? d.regime_range_chop_persist_max), 0.1, 0.55)),
    regime_range_trek_share_max: round2(clamp(Number(p.regime_range_trek_share_max ?? d.regime_range_trek_share_max), 0.12, 0.55)),
    regime_range_trek_eff_max: round2(clamp(Number(p.regime_range_trek_eff_max ?? d.regime_range_trek_eff_max), 0.15, 0.7)),
    regime_min_dwell_bars: clampInt(p.regime_min_dwell_bars, d.regime_min_dwell_bars, 2, 12),
    regime_confirm_bars: clampInt(p.regime_confirm_bars, d.regime_confirm_bars, 1, 8),
    regime_mom_bars: clampInt(p.regime_mom_bars, d.regime_mom_bars, 4, 16),
    regime_persist_window: clampInt(p.regime_persist_window, d.regime_persist_window, 3, 12),
    mtf_trek_flat_frac: clamp(coerceRegimeBp(p.mtf_trek_flat_frac, d.mtf_trek_flat_frac), 1.5, 12.0),
    mtf_block_higher_fight: p.mtf_block_higher_fight !== false,
    mtf_require_aligned_side: p.mtf_require_aligned_side !== false,
    mtf_htf_veto: p.mtf_htf_veto !== false,
    entry_story_conf_min: round2(clamp(Number(p.entry_story_conf_min ?? d.entry_story_conf_min), 0.35, 0.8)),
    entry_chop_conf_max: round2(clamp(Number(p.entry_chop_conf_max ?? d.entry_chop_conf_max), 0.25, 0.65)),
    soft_l1_abs: round1(clamp(Number(p.soft_l1_abs ?? d.soft_l1_abs), 0.2, 50)),
    soft_l2_abs: round1(clamp(Number(p.soft_l2_abs ?? d.soft_l2_abs), 0.2, 50)),
    soft_l3_abs: round1(clamp(Number(p.soft_l3_abs ?? d.soft_l3_abs), 0.2, 50)),
    hardinv_pct_bp: clamp(coerceMicroBp(p.hardinv_pct_bp, d.hardinv_pct_bp), 0.1, 200),
    peak_mfe_abs: round1(clamp(Number(p.peak_mfe_abs ?? d.peak_mfe_abs), 0.2, 50)),
    peak_mfe_pct_bp: clamp(coerceMicroBp(p.peak_mfe_pct_bp, d.peak_mfe_pct_bp), 0.1, 200),
    peak_retention: round2(clamp(Number(p.peak_retention ?? d.peak_retention), 0.1, 0.95)),
    peak_min_giveback_abs: round2(
      clamp(Number(p.peak_min_giveback_abs ?? d.peak_min_giveback_abs), 0.1, 20)
    ),
    target_l1_abs: round1(clamp(Number(p.target_l1_abs ?? d.target_l1_abs), 0.5, 100)),
    target_l2_abs: round1(clamp(Number(p.target_l2_abs ?? d.target_l2_abs), 0.5, 100)),
    target_l3_abs: round1(clamp(Number(p.target_l3_abs ?? d.target_l3_abs), 0.5, 100)),
    target_pct_bp: clamp(coerceMicroBp(p.target_pct_bp, d.target_pct_bp), 0.1, 500),
    safety_tp_rr: round2(clamp(Number(p.safety_tp_rr ?? d.safety_tp_rr), 1.5, 4.0)),
    entry_filter_level: clampInt(p.entry_filter_level, d.entry_filter_level, 0, 3),
    enabled_regimes: sanitizeEnabledRegimes(p.enabled_regimes, d.enabled_regimes),
    soft_off_regimes: [] as string[], // filled after enabled
    soft_l1_fallback_frac: round2(clamp(Number(p.soft_l1_fallback_frac ?? d.soft_l1_fallback_frac), 0.2, 0.95)),
    soft_l2_fallback_frac: round2(clamp(Number(p.soft_l2_fallback_frac ?? d.soft_l2_fallback_frac), 0.3, 0.99)),
    target_l1_fallback_frac: round2(clamp(Number(p.target_l1_fallback_frac ?? d.target_l1_fallback_frac), 0.2, 0.95)),
    target_l2_fallback_frac: round2(clamp(Number(p.target_l2_fallback_frac ?? d.target_l2_fallback_frac), 0.3, 0.99)),
    target_stretch_gate: round2(clamp(Number(p.target_stretch_gate ?? d.target_stretch_gate), 0.5, 1.0)),
    layer_suggest_p35: round2(clamp(Number(p.layer_suggest_p35 ?? d.layer_suggest_p35), 0.1, 0.5)),
    layer_suggest_p60: round2(clamp(Number(p.layer_suggest_p60 ?? d.layer_suggest_p60), 0.4, 0.8)),
    layer_suggest_p85: round2(clamp(Number(p.layer_suggest_p85 ?? d.layer_suggest_p85), 0.6, 0.99)),
    target_l3_min_vs_soft: round2(clamp(Number(p.target_l3_min_vs_soft ?? d.target_l3_min_vs_soft), 1.0, 2.0)),
    soft_layer_unlock_floor: round2(
      clamp(Number(p.soft_layer_unlock_floor ?? d.soft_layer_unlock_floor), 0.25, 1.5)
    ),
    peak_mfe_retention_fallback: round2(clamp(Number(p.peak_mfe_retention_fallback ?? d.peak_mfe_retention_fallback), 0.1, 0.95)),
    max_mfe_giveback: round2(clamp(Number(p.max_mfe_giveback ?? d.max_mfe_giveback), 0.1, 0.7)),
    hardinv_abs_floor: round1(clamp(Number(p.hardinv_abs_floor ?? d.hardinv_abs_floor), 0.2, 20)),
    hardinv_abs_cap: round1(clamp(Number(p.hardinv_abs_cap ?? d.hardinv_abs_cap), 0.5, 20)),
    peak_mfe_abs_floor: round1(clamp(Number(p.peak_mfe_abs_floor ?? d.peak_mfe_abs_floor), 0.5, 30)),
    target_abs_floor: round1(clamp(Number(p.target_abs_floor ?? d.target_abs_floor), 0.5, 50)),
    safety_tp_min_rr: round2(clamp(Number(p.safety_tp_min_rr ?? d.safety_tp_min_rr), 1.5, 4.0)),
    hardinv_grace_ms: clampInt(p.hardinv_grace_ms, d.hardinv_grace_ms, 0, 120000),
    hardinv_confirm_ms: clampInt(p.hardinv_confirm_ms, d.hardinv_confirm_ms, 0, 60000),
    structure_grace_ms: clampInt(p.structure_grace_ms, d.structure_grace_ms, 0, 60000),
    structure_confirm_ms: clampInt(p.structure_confirm_ms, d.structure_confirm_ms, 0, 30000),
    timedecay_min_hold_ms: clampInt(p.timedecay_min_hold_ms, d.timedecay_min_hold_ms, 60000, 3600000),
    timedecay_min_fav_abs: round1(clamp(Number(p.timedecay_min_fav_abs ?? d.timedecay_min_fav_abs), 0.2, 20)),
    timedecay_fav_pct_bp: clamp(coerceMicroBp(p.timedecay_fav_pct_bp, d.timedecay_fav_pct_bp), 0.1, 50),
    desk_ref_mid: round1(clamp(Number(p.desk_ref_mid ?? d.desk_ref_mid), 100, 10000)),
    layered_soft_post_mult_cap: round2(clamp(Number(p.layered_soft_post_mult_cap ?? d.layered_soft_post_mult_cap), 1.0, 2.0)),
    be_lock_frac: round2(clamp(Number(p.be_lock_frac ?? d.be_lock_frac), 0, 1)),
    be_lock_exec_frac: round2(clamp(Number(p.be_lock_exec_frac ?? d.be_lock_exec_frac), 0, 1)),
    min_profit_bank_soft_mult: round2(clamp(Number(p.min_profit_bank_soft_mult ?? d.min_profit_bank_soft_mult), 0.5, 2.0)),
    safety_tp_vs_min_stop_mult: round2(clamp(Number(p.safety_tp_vs_min_stop_mult ?? d.safety_tp_vs_min_stop_mult), 1.0, 1.5)),
    safety_sl_cushion_bp: clamp(coerceMicroBp(p.safety_sl_cushion_bp, d.safety_sl_cushion_bp), 1, 100),
    safety_sl_broker_min_mult: round2(clamp(Number(p.safety_sl_broker_min_mult ?? d.safety_sl_broker_min_mult), 1.0, 10)),
    safety_sl_spread_mult: round2(clamp(Number(p.safety_sl_spread_mult ?? d.safety_sl_spread_mult), 2, 30)),
    safety_abs_floor_hi: round1(clamp(Number(p.safety_abs_floor_hi ?? d.safety_abs_floor_hi), 0.05, 5)),
    safety_abs_floor_mid: round1(clamp(Number(p.safety_abs_floor_mid ?? d.safety_abs_floor_mid), 0.02, 2)),
    safety_abs_floor_lo: round1(clamp(Number(p.safety_abs_floor_lo ?? d.safety_abs_floor_lo), 0.001, 1)),
    scratch_soft_mfe_frac: round2(clamp(Number(p.scratch_soft_mfe_frac ?? d.scratch_soft_mfe_frac), 0.1, 1.0)),
    exit_trend_hardinv_mult: round2(clamp(Number(p.exit_trend_hardinv_mult ?? d.exit_trend_hardinv_mult), 0.5, 1.5)),
    exit_trend_peak_arm: sanitizePeakArm(p.exit_trend_peak_arm, d.exit_trend_peak_arm),
    exit_trend_peak_mfe_mult: round2(clamp(Number(p.exit_trend_peak_mfe_mult ?? d.exit_trend_peak_mfe_mult), 0.5, 2.0)),
    exit_trend_peak_giveback_mult: round2(clamp(Number(p.exit_trend_peak_giveback_mult ?? d.exit_trend_peak_giveback_mult), 0.5, 2.0)),
    exit_trend_peak_retention: round2(clamp(Number(p.exit_trend_peak_retention ?? d.exit_trend_peak_retention), 0, 0.95)),
    exit_trend_target_mult: round2(clamp(Number(p.exit_trend_target_mult ?? d.exit_trend_target_mult), 0.5, 2.0)),
    exit_trend_timedecay_hold_ms: clampInt(p.exit_trend_timedecay_hold_ms, d.exit_trend_timedecay_hold_ms, 60000, 3600000),
    exit_trend_timedecay_min_fav_mult: round2(clamp(Number(p.exit_trend_timedecay_min_fav_mult ?? d.exit_trend_timedecay_min_fav_mult), 0.5, 1.5)),
    exit_trend_structure: sanitizeStructure(p.exit_trend_structure, d.exit_trend_structure),
    exit_pullback_hardinv_mult: round2(clamp(Number(p.exit_pullback_hardinv_mult ?? d.exit_pullback_hardinv_mult), 0.5, 1.5)),
    exit_pullback_peak_arm: sanitizePeakArm(p.exit_pullback_peak_arm, d.exit_pullback_peak_arm),
    exit_pullback_peak_mfe_mult: round2(clamp(Number(p.exit_pullback_peak_mfe_mult ?? d.exit_pullback_peak_mfe_mult), 0.5, 2.0)),
    exit_pullback_peak_giveback_mult: round2(clamp(Number(p.exit_pullback_peak_giveback_mult ?? d.exit_pullback_peak_giveback_mult), 0.5, 2.0)),
    exit_pullback_peak_retention: round2(clamp(Number(p.exit_pullback_peak_retention ?? d.exit_pullback_peak_retention), 0, 0.95)),
    exit_pullback_target_mult: round2(clamp(Number(p.exit_pullback_target_mult ?? d.exit_pullback_target_mult), 0.5, 2.0)),
    exit_pullback_timedecay_hold_ms: clampInt(p.exit_pullback_timedecay_hold_ms, d.exit_pullback_timedecay_hold_ms, 60000, 3600000),
    exit_pullback_timedecay_min_fav_mult: round2(clamp(Number(p.exit_pullback_timedecay_min_fav_mult ?? d.exit_pullback_timedecay_min_fav_mult), 0.5, 1.5)),
    exit_pullback_structure: sanitizeStructure(p.exit_pullback_structure, d.exit_pullback_structure),
    exit_break_hardinv_mult: round2(clamp(Number(p.exit_break_hardinv_mult ?? d.exit_break_hardinv_mult), 0.5, 1.5)),
    exit_break_peak_arm: sanitizePeakArm(p.exit_break_peak_arm, d.exit_break_peak_arm),
    exit_break_peak_mfe_mult: round2(clamp(Number(p.exit_break_peak_mfe_mult ?? d.exit_break_peak_mfe_mult), 0.5, 2.0)),
    exit_break_peak_giveback_mult: round2(clamp(Number(p.exit_break_peak_giveback_mult ?? d.exit_break_peak_giveback_mult), 0.5, 2.0)),
    exit_break_peak_retention: round2(clamp(Number(p.exit_break_peak_retention ?? d.exit_break_peak_retention), 0, 0.95)),
    exit_break_target_mult: round2(clamp(Number(p.exit_break_target_mult ?? d.exit_break_target_mult), 0.5, 2.0)),
    exit_break_timedecay_hold_ms: clampInt(p.exit_break_timedecay_hold_ms, d.exit_break_timedecay_hold_ms, 60000, 3600000),
    exit_break_timedecay_min_fav_mult: round2(clamp(Number(p.exit_break_timedecay_min_fav_mult ?? d.exit_break_timedecay_min_fav_mult), 0.5, 1.5)),
    exit_break_structure: sanitizeStructure(p.exit_break_structure, d.exit_break_structure),
    exit_break_fail_hardinv_mult: round2(clamp(Number(p.exit_break_fail_hardinv_mult ?? d.exit_break_fail_hardinv_mult), 0.5, 1.5)),
    exit_break_fail_peak_arm: sanitizePeakArm(p.exit_break_fail_peak_arm, d.exit_break_fail_peak_arm),
    exit_break_fail_peak_mfe_mult: round2(clamp(Number(p.exit_break_fail_peak_mfe_mult ?? d.exit_break_fail_peak_mfe_mult), 0.5, 2.0)),
    exit_break_fail_peak_giveback_mult: round2(clamp(Number(p.exit_break_fail_peak_giveback_mult ?? d.exit_break_fail_peak_giveback_mult), 0.5, 2.0)),
    exit_break_fail_peak_retention: round2(clamp(Number(p.exit_break_fail_peak_retention ?? d.exit_break_fail_peak_retention), 0, 0.95)),
    exit_break_fail_target_mult: round2(clamp(Number(p.exit_break_fail_target_mult ?? d.exit_break_fail_target_mult), 0.5, 2.0)),
    exit_break_fail_timedecay_hold_ms: clampInt(p.exit_break_fail_timedecay_hold_ms, d.exit_break_fail_timedecay_hold_ms, 60000, 3600000),
    exit_break_fail_timedecay_min_fav_mult: round2(clamp(Number(p.exit_break_fail_timedecay_min_fav_mult ?? d.exit_break_fail_timedecay_min_fav_mult), 0.5, 1.5)),
    exit_break_fail_structure: sanitizeStructure(p.exit_break_fail_structure, d.exit_break_fail_structure),
    exit_fade_hardinv_mult: round2(clamp(Number(p.exit_fade_hardinv_mult ?? d.exit_fade_hardinv_mult), 0.5, 1.5)),
    exit_fade_peak_arm: sanitizePeakArm(p.exit_fade_peak_arm, d.exit_fade_peak_arm),
    exit_fade_peak_mfe_mult: round2(clamp(Number(p.exit_fade_peak_mfe_mult ?? d.exit_fade_peak_mfe_mult), 0.5, 2.0)),
    exit_fade_peak_giveback_mult: round2(clamp(Number(p.exit_fade_peak_giveback_mult ?? d.exit_fade_peak_giveback_mult), 0.5, 2.0)),
    exit_fade_peak_retention: round2(clamp(Number(p.exit_fade_peak_retention ?? d.exit_fade_peak_retention), 0, 0.95)),
    exit_fade_target_mult: round2(clamp(Number(p.exit_fade_target_mult ?? d.exit_fade_target_mult), 0.5, 2.0)),
    exit_fade_timedecay_hold_ms: clampInt(p.exit_fade_timedecay_hold_ms, d.exit_fade_timedecay_hold_ms, 60000, 3600000),
    exit_fade_timedecay_min_fav_mult: round2(clamp(Number(p.exit_fade_timedecay_min_fav_mult ?? d.exit_fade_timedecay_min_fav_mult), 0.5, 1.5)),
    exit_fade_structure: sanitizeStructure(p.exit_fade_structure, d.exit_fade_structure),
    exit_expansion_hardinv_mult: round2(clamp(Number(p.exit_expansion_hardinv_mult ?? d.exit_expansion_hardinv_mult), 0.5, 1.5)),
    exit_expansion_peak_arm: sanitizePeakArm(p.exit_expansion_peak_arm, d.exit_expansion_peak_arm),
    exit_expansion_peak_mfe_mult: round2(clamp(Number(p.exit_expansion_peak_mfe_mult ?? d.exit_expansion_peak_mfe_mult), 0.5, 2.0)),
    exit_expansion_peak_giveback_mult: round2(clamp(Number(p.exit_expansion_peak_giveback_mult ?? d.exit_expansion_peak_giveback_mult), 0.5, 2.0)),
    exit_expansion_peak_retention: round2(clamp(Number(p.exit_expansion_peak_retention ?? d.exit_expansion_peak_retention), 0, 0.95)),
    exit_expansion_target_mult: round2(clamp(Number(p.exit_expansion_target_mult ?? d.exit_expansion_target_mult), 0.5, 2.0)),
    exit_expansion_timedecay_hold_ms: clampInt(p.exit_expansion_timedecay_hold_ms, d.exit_expansion_timedecay_hold_ms, 60000, 3600000),
    exit_expansion_timedecay_min_fav_mult: round2(clamp(Number(p.exit_expansion_timedecay_min_fav_mult ?? d.exit_expansion_timedecay_min_fav_mult), 0.5, 1.5)),
    exit_expansion_structure: sanitizeStructure(p.exit_expansion_structure, d.exit_expansion_structure),
    exit_reversal_hardinv_mult: round2(clamp(Number(p.exit_reversal_hardinv_mult ?? d.exit_reversal_hardinv_mult), 0.5, 1.5)),
    exit_reversal_peak_arm: sanitizePeakArm(p.exit_reversal_peak_arm, d.exit_reversal_peak_arm),
    exit_reversal_peak_mfe_mult: round2(clamp(Number(p.exit_reversal_peak_mfe_mult ?? d.exit_reversal_peak_mfe_mult), 0.5, 2.0)),
    exit_reversal_peak_giveback_mult: round2(clamp(Number(p.exit_reversal_peak_giveback_mult ?? d.exit_reversal_peak_giveback_mult), 0.5, 2.0)),
    exit_reversal_peak_retention: round2(clamp(Number(p.exit_reversal_peak_retention ?? d.exit_reversal_peak_retention), 0, 0.95)),
    exit_reversal_target_mult: round2(clamp(Number(p.exit_reversal_target_mult ?? d.exit_reversal_target_mult), 0.5, 2.0)),
    exit_reversal_timedecay_hold_ms: clampInt(p.exit_reversal_timedecay_hold_ms, d.exit_reversal_timedecay_hold_ms, 60000, 3600000),
    exit_reversal_timedecay_min_fav_mult: round2(clamp(Number(p.exit_reversal_timedecay_min_fav_mult ?? d.exit_reversal_timedecay_min_fav_mult), 0.5, 1.5)),
    exit_reversal_structure: sanitizeStructure(p.exit_reversal_structure, d.exit_reversal_structure),
    exit_chop_hardinv_mult: round2(clamp(Number(p.exit_chop_hardinv_mult ?? d.exit_chop_hardinv_mult), 0.5, 1.5)),
    exit_chop_peak_arm: sanitizePeakArm(p.exit_chop_peak_arm, d.exit_chop_peak_arm),
    exit_chop_peak_mfe_mult: round2(clamp(Number(p.exit_chop_peak_mfe_mult ?? d.exit_chop_peak_mfe_mult), 0.5, 2.0)),
    exit_chop_peak_giveback_mult: round2(clamp(Number(p.exit_chop_peak_giveback_mult ?? d.exit_chop_peak_giveback_mult), 0.5, 2.0)),
    exit_chop_peak_retention: round2(clamp(Number(p.exit_chop_peak_retention ?? d.exit_chop_peak_retention), 0, 0.95)),
    exit_chop_target_mult: round2(clamp(Number(p.exit_chop_target_mult ?? d.exit_chop_target_mult), 0.5, 2.0)),
    exit_chop_timedecay_hold_ms: clampInt(p.exit_chop_timedecay_hold_ms, d.exit_chop_timedecay_hold_ms, 60000, 3600000),
    exit_chop_timedecay_min_fav_mult: round2(clamp(Number(p.exit_chop_timedecay_min_fav_mult ?? d.exit_chop_timedecay_min_fav_mult), 0.5, 1.5)),
    exit_chop_structure: sanitizeStructure(p.exit_chop_structure, d.exit_chop_structure),
    exit_range_through_mid_slack: round2(clamp(Number(p.exit_range_through_mid_slack ?? d.exit_range_through_mid_slack), 0.01, 0.25)),
    soft_exit_require_1m_change: p.soft_exit_require_1m_change !== false,
    soft_exit_block_same_next_entry: p.soft_exit_block_same_next_entry !== false,
    struct_extreme_hi: round2(clamp(Number(p.struct_extreme_hi ?? d.struct_extreme_hi), 0.6, 0.99)),
    struct_extreme_lo: round2(clamp(Number(p.struct_extreme_lo ?? d.struct_extreme_lo), 0.01, 0.4)),
    struct_start_lo: round2(clamp(Number(p.struct_start_lo ?? d.struct_start_lo), 0.4, 0.9)),
    struct_start_hi: round2(clamp(Number(p.struct_start_hi ?? d.struct_start_hi), 0.1, 0.6)),
    struct_half_lo: round2(clamp(Number(p.struct_half_lo ?? d.struct_half_lo), 0.3, 0.7)),
    struct_half_hi: round2(clamp(Number(p.struct_half_hi ?? d.struct_half_hi), 0.3, 0.7)),
    zone_band_cut_lo: round2(clamp(Number(p.zone_band_cut_lo ?? d.zone_band_cut_lo), 0.05, 0.4)),
    zone_band_cut_mid_lo: round2(clamp(Number(p.zone_band_cut_mid_lo ?? d.zone_band_cut_mid_lo), 0.2, 0.55)),
    zone_band_cut_mid_hi: round2(clamp(Number(p.zone_band_cut_mid_hi ?? d.zone_band_cut_mid_hi), 0.45, 0.8)),
    zone_band_cut_hi: round2(clamp(Number(p.zone_band_cut_hi ?? d.zone_band_cut_hi), 0.6, 0.95)),
    minute_trend_bias_lookback: clampInt(p.minute_trend_bias_lookback, d.minute_trend_bias_lookback, 3, 20),
    minute_trend_bias_trek_min_path_bp: clamp(coerceMicroBp(p.minute_trend_bias_trek_min_path_bp, d.minute_trend_bias_trek_min_path_bp), 0.1, 50),
    m1_aggregate_min_bars: clampInt(p.m1_aggregate_min_bars, d.m1_aggregate_min_bars, 2, 6),
    breakout_pierce_pos_hi: round2(clamp(Number(p.breakout_pierce_pos_hi ?? d.breakout_pierce_pos_hi), 0.7, 0.99)),
    breakout_pierce_pos_lo: round2(clamp(Number(p.breakout_pierce_pos_lo ?? d.breakout_pierce_pos_lo), 0.01, 0.3)),
    failed_break_reclaim_pos_lo: round2(clamp(Number(p.failed_break_reclaim_pos_lo ?? d.failed_break_reclaim_pos_lo), 0.05, 0.5)),
    failed_break_reclaim_pos_hi: round2(clamp(Number(p.failed_break_reclaim_pos_hi ?? d.failed_break_reclaim_pos_hi), 0.5, 0.95)),
    compression_entry_pos_lo: round2(clamp(Number(p.compression_entry_pos_lo ?? d.compression_entry_pos_lo), 0.1, 0.5)),
    compression_entry_pos_hi: round2(clamp(Number(p.compression_entry_pos_hi ?? d.compression_entry_pos_hi), 0.5, 0.9)),
    exhaust_tip_chase_block: p.exhaust_tip_chase_block !== false,
    entry_learner_override_margin: round2(clamp(Number(p.entry_learner_override_margin ?? d.entry_learner_override_margin), 0.02, 0.3)),
    same_dir_lock_ms: clampInt(p.same_dir_lock_ms, d.same_dir_lock_ms, 0, 600000),
    same_dir_lock_after_loss_ms: clampInt(p.same_dir_lock_after_loss_ms, d.same_dir_lock_after_loss_ms, 0, 600000),
    exit_loss_include_hardinv: p.exit_loss_include_hardinv !== false,
    exit_loss_exclude_be_lock: p.exit_loss_exclude_be_lock !== false,
    story_min_path_bp: clamp(coerceMicroBp(p.story_min_path_bp, d.story_min_path_bp), 0.1, 50),
    story_conf_min: round2(clamp(Number(p.story_conf_min ?? d.story_conf_min), 0.15, 0.8)),
    chase_edge: round2(clamp(Number(p.chase_edge ?? d.chase_edge), 0.05, 0.3)),
    trek_firm_mult: round2(clamp(Number(p.trek_firm_mult ?? d.trek_firm_mult), 1.0, 3.0)),
    story_sell_struct_pos: round2(clamp(Number(p.story_sell_struct_pos ?? d.story_sell_struct_pos), 0.2, 0.7)),
    story_buy_struct_pos: round2(clamp(Number(p.story_buy_struct_pos ?? d.story_buy_struct_pos), 0.3, 0.8)),
    bounce_dip_color_delta: clampInt(p.bounce_dip_color_delta, d.bounce_dip_color_delta, 1, 5),
    exhaust_pos_lo: round2(clamp(Number(p.exhaust_pos_lo ?? d.exhaust_pos_lo), 0.05, 0.4)),
    exhaust_pos_hi: round2(clamp(Number(p.exhaust_pos_hi ?? d.exhaust_pos_hi), 0.6, 0.95)),
    story_conf_break: round2(clamp(Number(p.story_conf_break ?? d.story_conf_break), 0.4, 0.99)),
    story_conf_bounce_dip: round2(clamp(Number(p.story_conf_bounce_dip ?? d.story_conf_bounce_dip), 0.4, 0.99)),
    story_conf_struct: round2(clamp(Number(p.story_conf_struct ?? d.story_conf_struct), 0.4, 0.99)),
    story_conf_recent: round2(clamp(Number(p.story_conf_recent ?? d.story_conf_recent), 0.3, 0.95)),
    story_conf_chop_thin: round2(clamp(Number(p.story_conf_chop_thin ?? d.story_conf_chop_thin), 0.1, 0.6)),
    story_conf_chop: round2(clamp(Number(p.story_conf_chop ?? d.story_conf_chop), 0.1, 0.7)),
    scalp_wick_confirm: p.scalp_wick_confirm !== false,
    expanding_range_mult: round2(clamp(Number(p.expanding_range_mult ?? d.expanding_range_mult), 1.05, 2.5)),
    compressed_range_mult: round2(clamp(Number(p.compressed_range_mult ?? d.compressed_range_mult), 0.2, 0.95)),
    velocity_lookback: clampInt(p.velocity_lookback, d.velocity_lookback, 4, 48),
    pressure_fight_green_buy: round2(clamp(Number(p.pressure_fight_green_buy ?? d.pressure_fight_green_buy), 0.2, 0.5)),
    pressure_fight_green_sell: round2(clamp(Number(p.pressure_fight_green_sell ?? d.pressure_fight_green_sell), 0.5, 0.8)),
    softplus_storyfight_exec_fav_mult: round2(clamp(Number(p.softplus_storyfight_exec_fav_mult ?? d.softplus_storyfight_exec_fav_mult), 0.5, 1.2)),
    softplus_storyfight_min_mfe_mult: round2(clamp(Number(p.softplus_storyfight_min_mfe_mult ?? d.softplus_storyfight_min_mfe_mult), 0.5, 1.5)),
    mind_cut_soft_mult: round2(clamp(Number(p.mind_cut_soft_mult ?? d.mind_cut_soft_mult), 0.4, 1.2)),
    mind_cut_retention: round2(clamp(Number(p.mind_cut_retention ?? d.mind_cut_retention), 0.3, 0.85)),
    green_soft_arm_mult: round2(clamp(Number(p.green_soft_arm_mult ?? d.green_soft_arm_mult), 0.7, 1.2)),
    deep_giveback_offset: round2(clamp(Number(p.deep_giveback_offset ?? d.deep_giveback_offset), 0.02, 0.3)),
    softplus_pullback_story_exec_mult: round2(clamp(Number(p.softplus_pullback_story_exec_mult ?? d.softplus_pullback_story_exec_mult), 0.5, 1.2)),
    against_us_soft_mult_hi: round2(clamp(Number(p.against_us_soft_mult_hi ?? d.against_us_soft_mult_hi), 0.4, 1.2)),
    against_us_soft_mult_lo: round2(clamp(Number(p.against_us_soft_mult_lo ?? d.against_us_soft_mult_lo), 0.2, 1.0)),
    session_expectancy_cut: round2(clamp(Number(p.session_expectancy_cut ?? d.session_expectancy_cut), -2.0, 0.5)),
    mind_entry_conf_base: round2(clamp(Number(p.mind_entry_conf_base ?? d.mind_entry_conf_base), 0.2, 0.9)),
    left_on_table_peak_tiny_min: clampInt(p.left_on_table_peak_tiny_min, d.left_on_table_peak_tiny_min, 1, 10),
    soft_sized_loss_frac: round2(clamp(Number(p.soft_sized_loss_frac ?? d.soft_sized_loss_frac), 0.3, 1.0)),
    session_e_bank_hi: round2(clamp(Number(p.session_e_bank_hi ?? d.session_e_bank_hi), 0.05, 1.0)),
    session_e_bank_lo: round2(clamp(Number(p.session_e_bank_lo ?? d.session_e_bank_lo), -1.0, 0.2)),
    manage_min_sample: clampInt(p.manage_min_sample, d.manage_min_sample, 1, 20),
    manage_score_session_e_neg: round2(clamp(Number(p.manage_score_session_e_neg ?? d.manage_score_session_e_neg), 0.1, 2.0)),
    manage_score_session_e_pos: round2(clamp(Number(p.manage_score_session_e_pos ?? d.manage_score_session_e_pos), 0.1, 2.0)),
    manage_score_window_e_neg: round2(clamp(Number(p.manage_score_window_e_neg ?? d.manage_score_window_e_neg), 0.1, 2.0)),
    manage_score_path_soft_green: round2(clamp(Number(p.manage_score_path_soft_green ?? d.manage_score_path_soft_green), 0.05, 2.0)),
    manage_score_path_giveback: round2(clamp(Number(p.manage_score_path_giveback ?? d.manage_score_path_giveback), 0.1, 2.0)),
    manage_score_m1_reverse: round2(clamp(Number(p.manage_score_m1_reverse ?? d.manage_score_m1_reverse), 0.1, 2.0)),
    manage_score_m1_continue: round2(clamp(Number(p.manage_score_m1_continue ?? d.manage_score_m1_continue), 0.1, 2.0)),
    manage_score_next_entry_opp: round2(clamp(Number(p.manage_score_next_entry_opp ?? d.manage_score_next_entry_opp), 0.1, 2.0)),
    manage_score_thesis_fight: round2(clamp(Number(p.manage_score_thesis_fight ?? d.manage_score_thesis_fight), 0.1, 2.0)),
    pressure_with_us_buy: round2(clamp(Number(p.pressure_with_us_buy ?? d.pressure_with_us_buy), 0.5, 0.8)),
    pressure_with_us_sell: round2(clamp(Number(p.pressure_with_us_sell ?? d.pressure_with_us_sell), 0.2, 0.5)),
    near_target_lean_bank: round2(clamp(Number(p.near_target_lean_bank ?? d.near_target_lean_bank), 0.5, 1.0)),
    manage_score_clamp: round2(clamp(Number(p.manage_score_clamp ?? d.manage_score_clamp), 1.0, 5.0)),
    manage_learner_override_margin: round2(clamp(Number(p.manage_learner_override_margin ?? d.manage_learner_override_margin), 0.02, 0.3)),
    peak_mfe_floor_ease: round2(clamp(Number(p.peak_mfe_floor_ease ?? d.peak_mfe_floor_ease), 0.5, 1.0)),
    strong_htf_aligned_min: clampInt(p.strong_htf_aligned_min, d.strong_htf_aligned_min, 1, 3),
    strong_conf_min: round2(clamp(Number(p.strong_conf_min ?? d.strong_conf_min), 0.4, 0.95)),
    fade_allowed_chapters: sanitizeStringArray(p.fade_allowed_chapters, d.fade_allowed_chapters),
    zone_bars: clampInt(p.zone_bars, d.zone_bars, 60, 360),
    min_bars_for_zone: clampInt(p.min_bars_for_zone, d.min_bars_for_zone, 30, 240),
    switch_gap_bars: clampInt(p.switch_gap_bars, d.switch_gap_bars, 1, 10),
    local_breakout_frac_floor: round2(clamp(Number(p.local_breakout_frac_floor ?? d.local_breakout_frac_floor), 0.05, 0.4)),
    trek_full_enter_mult: round2(clamp(Number(p.trek_full_enter_mult ?? d.trek_full_enter_mult), 2, 8)),
    trek_share_min: round2(clamp(Number(p.trek_share_min ?? d.trek_share_min), 0.1, 0.7)),
    trek_eff_min: round2(clamp(Number(p.trek_eff_min ?? d.trek_eff_min), 0.15, 0.8)),
    trek_recent_enter_mult: round2(clamp(Number(p.trek_recent_enter_mult ?? d.trek_recent_enter_mult), 1, 6)),
    trek_recent_share_min: round2(clamp(Number(p.trek_recent_share_min ?? d.trek_recent_share_min), 0.1, 0.6)),
    regime_conf_base: round2(clamp(Number(p.regime_conf_base ?? d.regime_conf_base), 0.1, 0.7)),
    regime_conf_strength_scale: round2(clamp(Number(p.regime_conf_strength_scale ?? d.regime_conf_strength_scale), 0.1, 1.0)),
    regime_conf_min: round2(clamp(Number(p.regime_conf_min ?? d.regime_conf_min), 0.05, 0.5)),
    regime_conf_max: round2(clamp(Number(p.regime_conf_max ?? d.regime_conf_max), 0.5, 1.0)),
    book_confidence_floor_after_switch: round2(clamp(Number(p.book_confidence_floor_after_switch ?? d.book_confidence_floor_after_switch), 0.2, 0.9)),
    soft_move_trek_pullback_shortcut: p.soft_move_trek_pullback_shortcut !== false,
    chop_to_trend_confirm_bars: clampInt(p.chop_to_trend_confirm_bars, d.chop_to_trend_confirm_bars, 1, 8),
    sticky_prior_enabled: p.sticky_prior_enabled !== false,
    transition_detect_enabled: p.transition_detect_enabled === true,
    playbook_promote_vs_live_unify: p.playbook_promote_vs_live_unify !== false,
    expansion_before_trend: p.expansion_before_trend === true,
    trend_thesis_regimes: sanitizeStringArray(p.trend_thesis_regimes, d.trend_thesis_regimes),
    adverse_chapters_sell: sanitizeStringArray(p.adverse_chapters_sell, d.adverse_chapters_sell),
    adverse_chapters_buy: sanitizeStringArray(p.adverse_chapters_buy, d.adverse_chapters_buy),
    resume_chapters_sell: sanitizeStringArray(p.resume_chapters_sell, d.resume_chapters_sell),
    resume_chapters_buy: sanitizeStringArray(p.resume_chapters_buy, d.resume_chapters_buy),
    episode_end_on_continue: p.episode_end_on_continue !== false,
    episode_softplus_bank_mult: round2(clamp(Number(p.episode_softplus_bank_mult ?? d.episode_softplus_bank_mult), 0.5, 1.5)),
    entry_learner_lr: round2(clamp(Number(p.entry_learner_lr ?? d.entry_learner_lr), 0.01, 0.5)),
    entry_learner_l2: round2(clamp(Number(p.entry_learner_l2 ?? d.entry_learner_l2), 0.0, 0.05)),
    entry_learner_temp: round2(clamp(Number(p.entry_learner_temp ?? d.entry_learner_temp), 0.3, 2.0)),
    entry_learner_explore_eps: round2(clamp(Number(p.entry_learner_explore_eps ?? d.entry_learner_explore_eps), 0, 0.3)),
    entry_learner_max_w: round2(clamp(Number(p.entry_learner_max_w ?? d.entry_learner_max_w), 1, 10)),
    entry_zone_lo_bin: round2(clamp(Number(p.entry_zone_lo_bin ?? d.entry_zone_lo_bin), 0.1, 0.5)),
    entry_zone_hi_bin: round2(clamp(Number(p.entry_zone_hi_bin ?? d.entry_zone_hi_bin), 0.5, 0.9)),
    entry_learner_wait_boost: round2(clamp(Number(p.entry_learner_wait_boost ?? d.entry_learner_wait_boost), 0.05, 1.0)),
    auto_cal_max_safety_tp_rr: round2(clamp(Number(p.auto_cal_max_safety_tp_rr ?? d.auto_cal_max_safety_tp_rr), 1.5, 5.0)),
    auto_cal_max_target_abs: round1(clamp(Number(p.auto_cal_max_target_abs ?? d.auto_cal_max_target_abs), 2, 50)),
    auto_cal_max_peak_mfe_abs: round1(clamp(Number(p.auto_cal_max_peak_mfe_abs ?? d.auto_cal_max_peak_mfe_abs), 1, 30)),
    auto_cal_max_peak_retention: round2(clamp(Number(p.auto_cal_max_peak_retention ?? d.auto_cal_max_peak_retention), 0.5, 0.99)),
    auto_cal_min_peak_retention: round2(clamp(Number(p.auto_cal_min_peak_retention ?? d.auto_cal_min_peak_retention), 0.05, 0.7)),
    auto_cal_min_hardinv_abs: round1(clamp(Number(p.auto_cal_min_hardinv_abs ?? d.auto_cal_min_hardinv_abs), 0.2, 5)),
    auto_cal_max_hardinv_abs: round1(clamp(Number(p.auto_cal_max_hardinv_abs ?? d.auto_cal_max_hardinv_abs), 1, 30)),
    soft_tighten_step: round1(clamp(Number(p.soft_tighten_step ?? d.soft_tighten_step), 0.1, 2)),
    peak_ease_abs_step: round1(clamp(Number(p.peak_ease_abs_step ?? d.peak_ease_abs_step), 0.1, 2)),
    peak_ease_retention_step: round2(clamp(Number(p.peak_ease_retention_step ?? d.peak_ease_retention_step), 0.01, 0.15)),
    peak_ease_giveback_step: round1(clamp(Number(p.peak_ease_giveback_step ?? d.peak_ease_giveback_step), 0.05, 1)),
    safety_tp_rr_step: round2(clamp(Number(p.safety_tp_rr_step ?? d.safety_tp_rr_step), 0.05, 0.5)),
    safety_tp_rr_pullback_step: round2(clamp(Number(p.safety_tp_rr_pullback_step ?? d.safety_tp_rr_pullback_step), 0.05, 0.5)),
    min_enabled_regimes: clampInt(p.min_enabled_regimes, d.min_enabled_regimes, 1, 13),
    core_always_on_regimes: sanitizeStringArray(p.core_always_on_regimes, d.core_always_on_regimes),
    soft_pct_ref_mid: round1(clamp(Number(p.soft_pct_ref_mid ?? d.soft_pct_ref_mid), 500, 10000)),
    raise_streak_before_pullback: clampInt(p.raise_streak_before_pullback, d.raise_streak_before_pullback, 1, 10),
    soft_sized_loss_detect_min: clampInt(p.soft_sized_loss_detect_min, d.soft_sized_loss_detect_min, 1, 10),
    gap_move_stay: round1(clamp(Number(p.gap_move_stay ?? d.gap_move_stay), 0.1, 5)),
    gap_stay_enter: round1(clamp(Number(p.gap_stay_enter ?? d.gap_stay_enter), 0.1, 5)),
    gap_enter_pullback: round1(clamp(Number(p.gap_enter_pullback ?? d.gap_enter_pullback), 0.1, 5)),
    gap_pullback_reversal: round1(clamp(Number(p.gap_pullback_reversal ?? d.gap_pullback_reversal), 1, 20)),
    gap_compress_expand: round1(clamp(Number(p.gap_compress_expand ?? d.gap_compress_expand), 1, 15)),
    persist_enter_stay_min_gap: round2(clamp(Number(p.persist_enter_stay_min_gap ?? d.persist_enter_stay_min_gap), 0.02, 0.3)),
  };

  g.soft_off_regimes = sanitizeSoftOffRegimes(p.soft_off_regimes, g.enabled_regimes);

  if (!(g.entry_chop_conf_max < g.entry_story_conf_min)) {
    g.entry_chop_conf_max = Math.min(g.entry_chop_conf_max, g.entry_story_conf_min - 0.01);
  }
  if (!(g.struct_extreme_lo < g.struct_extreme_hi)) {
    g.struct_extreme_lo = Math.min(g.struct_extreme_lo, g.struct_extreme_hi - 0.05);
  }
  if (!(g.struct_start_hi < g.struct_start_lo)) {
    g.struct_start_hi = Math.min(g.struct_start_hi, g.struct_start_lo - 0.05);
  }

  enforceSoftTargetLadder(g);
  enforceRegimeLadder(g);
  if (g.regime_persist_window > g.regime_mom_bars) {
    g.regime_persist_window = g.regime_mom_bars;
  }
  return g;
}

let cache: BrainGenome | null = null;
/** Disk mtime of last successful genome load — BRAIN process writes, API hot-reloads. */
let cacheMtimeMs = Number.NaN;

export function getBrainGenome(): BrainGenome {
  const p = genomePath();
  try {
    if (fs.existsSync(p)) {
      const mtimeMs = fs.statSync(p).mtimeMs;
      if (cache && Number.isFinite(cacheMtimeMs) && mtimeMs === cacheMtimeMs) {
        return cache;
      }
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<BrainGenome>;
      cache = sanitizeGenome(raw);
      cacheMtimeMs = mtimeMs;
      return cache;
    }
  } catch {
    /* factory */
  }
  if (cache) return cache;
  cache = { ...DEFAULT_GENOME, updated_at: new Date().toISOString() };
  cacheMtimeMs = Number.NaN;
  return cache;
}

export function setBrainGenome(next: Partial<BrainGenome>): BrainGenome {
  const merged = sanitizeGenome({ ...getBrainGenome(), ...next, updated_at: new Date().toISOString() });
  const p = genomePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  cache = merged;
  try {
    cacheMtimeMs = fs.statSync(p).mtimeMs;
  } catch {
    cacheMtimeMs = Number.NaN;
  }
  return merged;
}

export function reloadBrainGenome(): BrainGenome {
  cache = null;
  cacheMtimeMs = Number.NaN;
  return getBrainGenome();
}

export function defaultBrainGenome(): BrainGenome {
  return {
    ...DEFAULT_GENOME,
    enabled_regimes: [...DEFAULT_GENOME.enabled_regimes],
    soft_off_regimes: [...DEFAULT_GENOME.soft_off_regimes],
    fade_allowed_chapters: [...DEFAULT_GENOME.fade_allowed_chapters],
    trend_thesis_regimes: [...DEFAULT_GENOME.trend_thesis_regimes],
    adverse_chapters_sell: [...DEFAULT_GENOME.adverse_chapters_sell],
    adverse_chapters_buy: [...DEFAULT_GENOME.adverse_chapters_buy],
    resume_chapters_sell: [...DEFAULT_GENOME.resume_chapters_sell],
    resume_chapters_buy: [...DEFAULT_GENOME.resume_chapters_buy],
    core_always_on_regimes: [...DEFAULT_GENOME.core_always_on_regimes],
  };
}

/**
 * Soft/Peak/Target/SAFETY + regime gates as desk-shaped knobs.
 * Desk calibration reads these so BrainGenome is source of truth.
 * Pct fields are returned as price fractions (bp → frac via {@link regimeBpToFrac}).
 */
export function deskKnobsFromGenome(): {
  soft_l1_abs: number;
  soft_l2_abs: number;
  soft_l3_abs: number;
  hardinv_abs: number;
  hardinv_pct: number;
  peak_mfe_abs: number;
  peak_mfe_pct: number;
  peak_retention: number;
  peak_min_giveback_abs: number;
  target_abs: number;
  target_l1_abs: number;
  target_l2_abs: number;
  target_l3_abs: number;
  target_pct: number;
  safety_tp_rr: number;
  entry_filter_level: number;
  enabled_regimes: string[];
  soft_off_regimes: string[];
} {
  const g = getBrainGenome();
  return {
    soft_l1_abs: g.soft_l1_abs,
    soft_l2_abs: g.soft_l2_abs,
    soft_l3_abs: g.soft_l3_abs,
    hardinv_abs: g.soft_l3_abs,
    hardinv_pct: regimeBpToFrac(g.hardinv_pct_bp),
    peak_mfe_abs: g.peak_mfe_abs,
    peak_mfe_pct: regimeBpToFrac(g.peak_mfe_pct_bp),
    peak_retention: g.peak_retention,
    peak_min_giveback_abs: g.peak_min_giveback_abs,
    target_abs: g.target_l3_abs,
    target_l1_abs: g.target_l1_abs,
    target_l2_abs: g.target_l2_abs,
    target_l3_abs: g.target_l3_abs,
    target_pct: regimeBpToFrac(g.target_pct_bp),
    safety_tp_rr: g.safety_tp_rr,
    entry_filter_level: g.entry_filter_level,
    enabled_regimes: [...g.enabled_regimes],
    soft_off_regimes: [...g.soft_off_regimes],
  };
}

/** Keys Brain Self Improve may safely evolve (not lot/broker dealing-rules). */
export const EVOLVABLE_GENOME_KEYS: ReadonlyArray<keyof BrainGenome> = [
  'peak_keep',
  'peak_arm_soft_mult',
  'peak_trail_soft_cap_mult',
  'story_fight_peak_arm_soft_mult',
  'soft_plus_giveback',
  'soft_plus_runner_mult',
  'soft_plus_leg_mult',
  'soft_layer_unlock_mult',
  'pullback_episode_enabled',
  'pullback_episode_peak_arm_soft_mult',
  'pullback_episode_min_mfe_soft_mult',
  'require_1m_trigger',
  'soft_same_side_pause_closes',
  'soft_same_side_pause_min',
  'wait_on_1m_fight',
  'mind_bank_on_turn',
  'explore_step',
  'version',
  'last_lesson',
  'regime_move',
  'regime_trend_stay',
  'regime_trend_enter',
  'regime_pullback',
  'regime_reversal',
  'regime_move_range',
  'regime_compress_abs',
  'regime_expand_abs',
  'regime_compress_avg_mult',
  'regime_expand_avg_mult',
  'regime_near_zone_mid',
  'regime_clear_break_frac',
  'regime_persist_enter',
  'regime_persist_stay',
  'regime_persist_pullback',
  'regime_range_chop_persist_max',
  'regime_range_trek_share_max',
  'regime_range_trek_eff_max',
  'regime_min_dwell_bars',
  'regime_confirm_bars',
  'regime_mom_bars',
  'regime_persist_window',
  'mtf_trek_flat_frac',
  'mtf_block_higher_fight',
  'mtf_require_aligned_side',
  'mtf_htf_veto',
  'entry_story_conf_min',
  'entry_chop_conf_max',
  'soft_l1_abs',
  'soft_l2_abs',
  'soft_l3_abs',
  'hardinv_pct_bp',
  'peak_mfe_abs',
  'peak_mfe_pct_bp',
  'peak_retention',
  'peak_min_giveback_abs',
  'target_l1_abs',
  'target_l2_abs',
  'target_l3_abs',
  'target_pct_bp',
  'safety_tp_rr',
  'entry_filter_level',
  'enabled_regimes',
  'soft_off_regimes',
  'soft_l1_fallback_frac',
  'soft_l2_fallback_frac',
  'target_l1_fallback_frac',
  'target_l2_fallback_frac',
  'target_stretch_gate',
  'layer_suggest_p35',
  'layer_suggest_p60',
  'layer_suggest_p85',
  'target_l3_min_vs_soft',
  'soft_layer_unlock_floor',
  'peak_mfe_retention_fallback',
  'max_mfe_giveback',
  'hardinv_abs_floor',
  'hardinv_abs_cap',
  'peak_mfe_abs_floor',
  'target_abs_floor',
  'safety_tp_min_rr',
  'hardinv_grace_ms',
  'hardinv_confirm_ms',
  'structure_grace_ms',
  'structure_confirm_ms',
  'timedecay_min_hold_ms',
  'timedecay_min_fav_abs',
  'timedecay_fav_pct_bp',
  'desk_ref_mid',
  'layered_soft_post_mult_cap',
  'be_lock_frac',
  'be_lock_exec_frac',
  'min_profit_bank_soft_mult',
  'safety_tp_vs_min_stop_mult',
  'safety_sl_cushion_bp',
  'safety_sl_broker_min_mult',
  'safety_sl_spread_mult',
  'safety_abs_floor_hi',
  'safety_abs_floor_mid',
  'safety_abs_floor_lo',
  'scratch_soft_mfe_frac',
  'exit_trend_hardinv_mult',
  'exit_trend_peak_arm',
  'exit_trend_peak_mfe_mult',
  'exit_trend_peak_giveback_mult',
  'exit_trend_peak_retention',
  'exit_trend_target_mult',
  'exit_trend_timedecay_hold_ms',
  'exit_trend_timedecay_min_fav_mult',
  'exit_trend_structure',
  'exit_pullback_hardinv_mult',
  'exit_pullback_peak_arm',
  'exit_pullback_peak_mfe_mult',
  'exit_pullback_peak_giveback_mult',
  'exit_pullback_peak_retention',
  'exit_pullback_target_mult',
  'exit_pullback_timedecay_hold_ms',
  'exit_pullback_timedecay_min_fav_mult',
  'exit_pullback_structure',
  'exit_break_hardinv_mult',
  'exit_break_peak_arm',
  'exit_break_peak_mfe_mult',
  'exit_break_peak_giveback_mult',
  'exit_break_peak_retention',
  'exit_break_target_mult',
  'exit_break_timedecay_hold_ms',
  'exit_break_timedecay_min_fav_mult',
  'exit_break_structure',
  'exit_break_fail_hardinv_mult',
  'exit_break_fail_peak_arm',
  'exit_break_fail_peak_mfe_mult',
  'exit_break_fail_peak_giveback_mult',
  'exit_break_fail_peak_retention',
  'exit_break_fail_target_mult',
  'exit_break_fail_timedecay_hold_ms',
  'exit_break_fail_timedecay_min_fav_mult',
  'exit_break_fail_structure',
  'exit_fade_hardinv_mult',
  'exit_fade_peak_arm',
  'exit_fade_peak_mfe_mult',
  'exit_fade_peak_giveback_mult',
  'exit_fade_peak_retention',
  'exit_fade_target_mult',
  'exit_fade_timedecay_hold_ms',
  'exit_fade_timedecay_min_fav_mult',
  'exit_fade_structure',
  'exit_expansion_hardinv_mult',
  'exit_expansion_peak_arm',
  'exit_expansion_peak_mfe_mult',
  'exit_expansion_peak_giveback_mult',
  'exit_expansion_peak_retention',
  'exit_expansion_target_mult',
  'exit_expansion_timedecay_hold_ms',
  'exit_expansion_timedecay_min_fav_mult',
  'exit_expansion_structure',
  'exit_reversal_hardinv_mult',
  'exit_reversal_peak_arm',
  'exit_reversal_peak_mfe_mult',
  'exit_reversal_peak_giveback_mult',
  'exit_reversal_peak_retention',
  'exit_reversal_target_mult',
  'exit_reversal_timedecay_hold_ms',
  'exit_reversal_timedecay_min_fav_mult',
  'exit_reversal_structure',
  'exit_chop_hardinv_mult',
  'exit_chop_peak_arm',
  'exit_chop_peak_mfe_mult',
  'exit_chop_peak_giveback_mult',
  'exit_chop_peak_retention',
  'exit_chop_target_mult',
  'exit_chop_timedecay_hold_ms',
  'exit_chop_timedecay_min_fav_mult',
  'exit_chop_structure',
  'exit_range_through_mid_slack',
  'soft_exit_require_1m_change',
  'soft_exit_block_same_next_entry',
  'struct_extreme_hi',
  'struct_extreme_lo',
  'struct_start_lo',
  'struct_start_hi',
  'struct_half_lo',
  'struct_half_hi',
  'zone_band_cut_lo',
  'zone_band_cut_mid_lo',
  'zone_band_cut_mid_hi',
  'zone_band_cut_hi',
  'minute_trend_bias_lookback',
  'minute_trend_bias_trek_min_path_bp',
  'm1_aggregate_min_bars',
  'breakout_pierce_pos_hi',
  'breakout_pierce_pos_lo',
  'failed_break_reclaim_pos_lo',
  'failed_break_reclaim_pos_hi',
  'compression_entry_pos_lo',
  'compression_entry_pos_hi',
  'exhaust_tip_chase_block',
  'entry_learner_override_margin',
  'same_dir_lock_ms',
  'same_dir_lock_after_loss_ms',
  'exit_loss_include_hardinv',
  'exit_loss_exclude_be_lock',
  'story_min_path_bp',
  'story_conf_min',
  'chase_edge',
  'trek_firm_mult',
  'story_sell_struct_pos',
  'story_buy_struct_pos',
  'bounce_dip_color_delta',
  'exhaust_pos_lo',
  'exhaust_pos_hi',
  'story_conf_break',
  'story_conf_bounce_dip',
  'story_conf_struct',
  'story_conf_recent',
  'story_conf_chop_thin',
  'story_conf_chop',
  'scalp_wick_confirm',
  'expanding_range_mult',
  'compressed_range_mult',
  'velocity_lookback',
  'pressure_fight_green_buy',
  'pressure_fight_green_sell',
  'softplus_storyfight_exec_fav_mult',
  'softplus_storyfight_min_mfe_mult',
  'mind_cut_soft_mult',
  'mind_cut_retention',
  'green_soft_arm_mult',
  'deep_giveback_offset',
  'softplus_pullback_story_exec_mult',
  'against_us_soft_mult_hi',
  'against_us_soft_mult_lo',
  'session_expectancy_cut',
  'mind_entry_conf_base',
  'left_on_table_peak_tiny_min',
  'soft_sized_loss_frac',
  'session_e_bank_hi',
  'session_e_bank_lo',
  'manage_min_sample',
  'manage_score_session_e_neg',
  'manage_score_session_e_pos',
  'manage_score_window_e_neg',
  'manage_score_path_soft_green',
  'manage_score_path_giveback',
  'manage_score_m1_reverse',
  'manage_score_m1_continue',
  'manage_score_next_entry_opp',
  'manage_score_thesis_fight',
  'pressure_with_us_buy',
  'pressure_with_us_sell',
  'near_target_lean_bank',
  'manage_score_clamp',
  'manage_learner_override_margin',
  'peak_mfe_floor_ease',
  'strong_htf_aligned_min',
  'strong_conf_min',
  'fade_allowed_chapters',
  'zone_bars',
  'min_bars_for_zone',
  'switch_gap_bars',
  'local_breakout_frac_floor',
  'trek_full_enter_mult',
  'trek_share_min',
  'trek_eff_min',
  'trek_recent_enter_mult',
  'trek_recent_share_min',
  'regime_conf_base',
  'regime_conf_strength_scale',
  'regime_conf_min',
  'regime_conf_max',
  'book_confidence_floor_after_switch',
  'soft_move_trek_pullback_shortcut',
  'chop_to_trend_confirm_bars',
  'sticky_prior_enabled',
  'transition_detect_enabled',
  'playbook_promote_vs_live_unify',
  'expansion_before_trend',
  'trend_thesis_regimes',
  'adverse_chapters_sell',
  'adverse_chapters_buy',
  'resume_chapters_sell',
  'resume_chapters_buy',
  'episode_end_on_continue',
  'episode_softplus_bank_mult',
  'entry_learner_lr',
  'entry_learner_l2',
  'entry_learner_temp',
  'entry_learner_explore_eps',
  'entry_learner_max_w',
  'entry_zone_lo_bin',
  'entry_zone_hi_bin',
  'entry_learner_wait_boost',
  'auto_cal_max_safety_tp_rr',
  'auto_cal_max_target_abs',
  'auto_cal_max_peak_mfe_abs',
  'auto_cal_max_peak_retention',
  'auto_cal_min_peak_retention',
  'auto_cal_min_hardinv_abs',
  'auto_cal_max_hardinv_abs',
  'soft_tighten_step',
  'peak_ease_abs_step',
  'peak_ease_retention_step',
  'peak_ease_giveback_step',
  'safety_tp_rr_step',
  'safety_tp_rr_pullback_step',
  'min_enabled_regimes',
  'core_always_on_regimes',
  'soft_pct_ref_mid',
  'raise_streak_before_pullback',
  'soft_sized_loss_detect_min',
  'gap_move_stay',
  'gap_stay_enter',
  'gap_enter_pullback',
  'gap_pullback_reversal',
  'gap_compress_expand',
  'persist_enter_stay_min_gap',
];

/**
 * Trading-intelligence keys that require measurable eval improvement to ACCEPT.
 * Regime ladder + multi-TF / entry conf — must have explore bounce + discriminative probes.
 * Soft/Peak/Target abs evolve via PEAK_MEMORY_SAFE_KEYS / explore Soft-layer variants.
 */
export const TRADING_INTEL_GENOME_KEYS: ReadonlyArray<keyof BrainGenome> = [
  'regime_move',
  'regime_trend_stay',
  'regime_trend_enter',
  'regime_pullback',
  'regime_reversal',
  'regime_move_range',
  'regime_compress_abs',
  'regime_expand_abs',
  'regime_compress_avg_mult',
  'regime_expand_avg_mult',
  'regime_near_zone_mid',
  'regime_clear_break_frac',
  'regime_persist_enter',
  'regime_persist_stay',
  'regime_persist_pullback',
  'regime_range_chop_persist_max',
  'regime_range_trek_share_max',
  'regime_range_trek_eff_max',
  'regime_min_dwell_bars',
  'regime_confirm_bars',
  'regime_mom_bars',
  'regime_persist_window',
  'mtf_trek_flat_frac',
  'mtf_block_higher_fight',
  'mtf_require_aligned_side',
  'mtf_htf_veto',
  'entry_story_conf_min',
  'entry_chop_conf_max',
];

/** Peak / Soft / Target / SAFETY / exit-timing keys that may ACCEPT on E-flat defensive path. */
export const PEAK_MEMORY_SAFE_KEYS: ReadonlyArray<keyof BrainGenome> = [
  'peak_keep',
  'peak_arm_soft_mult',
  'peak_trail_soft_cap_mult',
  'story_fight_peak_arm_soft_mult',
  'soft_plus_giveback',
  'soft_plus_runner_mult',
  'soft_plus_leg_mult',
  'soft_layer_unlock_mult',
  'pullback_episode_enabled',
  'pullback_episode_peak_arm_soft_mult',
  'pullback_episode_min_mfe_soft_mult',
  'require_1m_trigger',
  'soft_same_side_pause_closes',
  'soft_same_side_pause_min',
  'wait_on_1m_fight',
  'mind_bank_on_turn',
  'explore_step',
  'version',
  'last_lesson',
  'soft_l1_abs',
  'soft_l2_abs',
  'soft_l3_abs',
  'hardinv_pct_bp',
  'peak_mfe_abs',
  'peak_mfe_pct_bp',
  'peak_retention',
  'peak_min_giveback_abs',
  'target_l1_abs',
  'target_l2_abs',
  'target_l3_abs',
  'target_pct_bp',
  'safety_tp_rr',
  'soft_l1_fallback_frac',
  'soft_l2_fallback_frac',
  'target_l1_fallback_frac',
  'target_l2_fallback_frac',
  'target_stretch_gate',
  'layer_suggest_p35',
  'layer_suggest_p60',
  'layer_suggest_p85',
  'target_l3_min_vs_soft',
  'soft_layer_unlock_floor',
  'peak_mfe_retention_fallback',
  'max_mfe_giveback',
  'hardinv_abs_floor',
  'hardinv_abs_cap',
  'peak_mfe_abs_floor',
  'target_abs_floor',
  'safety_tp_min_rr',
  'hardinv_grace_ms',
  'hardinv_confirm_ms',
  'structure_grace_ms',
  'structure_confirm_ms',
  'timedecay_min_hold_ms',
  'timedecay_min_fav_abs',
  'timedecay_fav_pct_bp',
  'desk_ref_mid',
  'layered_soft_post_mult_cap',
  'be_lock_frac',
  'be_lock_exec_frac',
  'min_profit_bank_soft_mult',
  'safety_tp_vs_min_stop_mult',
  'safety_sl_cushion_bp',
  'safety_sl_broker_min_mult',
  'safety_sl_spread_mult',
  'safety_abs_floor_hi',
  'safety_abs_floor_mid',
  'safety_abs_floor_lo',
  'scratch_soft_mfe_frac',
  'exit_trend_hardinv_mult',
  'exit_trend_peak_arm',
  'exit_trend_peak_mfe_mult',
  'exit_trend_peak_giveback_mult',
  'exit_trend_peak_retention',
  'exit_trend_target_mult',
  'exit_trend_timedecay_hold_ms',
  'exit_trend_timedecay_min_fav_mult',
  'exit_trend_structure',
  'exit_pullback_hardinv_mult',
  'exit_pullback_peak_arm',
  'exit_pullback_peak_mfe_mult',
  'exit_pullback_peak_giveback_mult',
  'exit_pullback_peak_retention',
  'exit_pullback_target_mult',
  'exit_pullback_timedecay_hold_ms',
  'exit_pullback_timedecay_min_fav_mult',
  'exit_pullback_structure',
  'exit_break_hardinv_mult',
  'exit_break_peak_arm',
  'exit_break_peak_mfe_mult',
  'exit_break_peak_giveback_mult',
  'exit_break_peak_retention',
  'exit_break_target_mult',
  'exit_break_timedecay_hold_ms',
  'exit_break_timedecay_min_fav_mult',
  'exit_break_structure',
  'exit_break_fail_hardinv_mult',
  'exit_break_fail_peak_arm',
  'exit_break_fail_peak_mfe_mult',
  'exit_break_fail_peak_giveback_mult',
  'exit_break_fail_peak_retention',
  'exit_break_fail_target_mult',
  'exit_break_fail_timedecay_hold_ms',
  'exit_break_fail_timedecay_min_fav_mult',
  'exit_break_fail_structure',
  'exit_fade_hardinv_mult',
  'exit_fade_peak_arm',
  'exit_fade_peak_mfe_mult',
  'exit_fade_peak_giveback_mult',
  'exit_fade_peak_retention',
  'exit_fade_target_mult',
  'exit_fade_timedecay_hold_ms',
  'exit_fade_timedecay_min_fav_mult',
  'exit_fade_structure',
  'exit_expansion_hardinv_mult',
  'exit_expansion_peak_arm',
  'exit_expansion_peak_mfe_mult',
  'exit_expansion_peak_giveback_mult',
  'exit_expansion_peak_retention',
  'exit_expansion_target_mult',
  'exit_expansion_timedecay_hold_ms',
  'exit_expansion_timedecay_min_fav_mult',
  'exit_expansion_structure',
  'exit_reversal_hardinv_mult',
  'exit_reversal_peak_arm',
  'exit_reversal_peak_mfe_mult',
  'exit_reversal_peak_giveback_mult',
  'exit_reversal_peak_retention',
  'exit_reversal_target_mult',
  'exit_reversal_timedecay_hold_ms',
  'exit_reversal_timedecay_min_fav_mult',
  'exit_reversal_structure',
  'exit_chop_hardinv_mult',
  'exit_chop_peak_arm',
  'exit_chop_peak_mfe_mult',
  'exit_chop_peak_giveback_mult',
  'exit_chop_peak_retention',
  'exit_chop_target_mult',
  'exit_chop_timedecay_hold_ms',
  'exit_chop_timedecay_min_fav_mult',
  'exit_chop_structure',
  'exit_range_through_mid_slack',
  'soft_exit_require_1m_change',
  'soft_exit_block_same_next_entry',
  'same_dir_lock_ms',
  'same_dir_lock_after_loss_ms',
  'exit_loss_include_hardinv',
  'exit_loss_exclude_be_lock',
  'mind_cut_soft_mult',
  'mind_cut_retention',
  'green_soft_arm_mult',
  'deep_giveback_offset',
  'softplus_pullback_story_exec_mult',
  'against_us_soft_mult_hi',
  'against_us_soft_mult_lo',
  'session_expectancy_cut',
  'mind_entry_conf_base',
  'left_on_table_peak_tiny_min',
  'soft_sized_loss_frac',
  'session_e_bank_hi',
  'session_e_bank_lo',
  'manage_min_sample',
  'manage_score_session_e_neg',
  'manage_score_session_e_pos',
  'manage_score_window_e_neg',
  'manage_score_path_soft_green',
  'manage_score_path_giveback',
  'manage_score_m1_reverse',
  'manage_score_m1_continue',
  'manage_score_next_entry_opp',
  'manage_score_thesis_fight',
  'pressure_with_us_buy',
  'pressure_with_us_sell',
  'near_target_lean_bank',
  'manage_score_clamp',
  'manage_learner_override_margin',
  'peak_mfe_floor_ease',
];

/** Test helper — pin genome cache + disk so getBrainGenome cannot reload a stale file. */
export function _resetBrainGenomeForTests(g?: Partial<BrainGenome>): void {
  cache = sanitizeGenome({ ...DEFAULT_GENOME, ...g, updated_at: new Date().toISOString() });
  const p = genomePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    cacheMtimeMs = fs.statSync(p).mtimeMs;
  } catch {
    cacheMtimeMs = Date.now();
  }
}
