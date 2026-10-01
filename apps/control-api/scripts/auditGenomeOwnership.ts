/**
 * Audit BRAIN_CONFIRM_LIST #1–194 vs defaultBrainGenome + consumer refs.
 * Run: npx tsx scripts/auditGenomeOwnership.ts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultBrainGenome } from '../src/brainSelfImprove/brainGenome.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FACTORY = defaultBrainGenome();
const factoryKeys = new Set(Object.keys(FACTORY));

const confirm = readFileSync(join(HERE, '../../../docs/BRAIN_CONFIRM_LIST.md'), 'utf8');

/** Map confirm-list item number → genome key(s). Only items 1–194 (trading). */
const MAP: Record<number, string[]> = {
  1: ['peak_keep'],
  2: ['peak_arm_soft_mult'],
  3: ['peak_trail_soft_cap_mult'],
  4: ['story_fight_peak_arm_soft_mult'],
  5: ['soft_plus_giveback'],
  6: ['soft_plus_runner_mult'],
  7: ['soft_plus_leg_mult'],
  8: ['soft_layer_unlock_mult'],
  9: ['pullback_episode_enabled'],
  10: ['pullback_episode_peak_arm_soft_mult'],
  11: ['pullback_episode_min_mfe_soft_mult'],
  12: ['require_1m_trigger'],
  13: ['wait_on_1m_fight'],
  14: ['mind_bank_on_turn'],
  15: ['soft_same_side_pause_closes'],
  16: ['soft_same_side_pause_min'],
  17: ['regime_move'],
  18: ['regime_trend_stay'],
  19: ['regime_trend_enter'],
  20: ['regime_pullback'],
  21: ['regime_reversal'],
  22: ['regime_move_range'],
  23: ['regime_compress_abs'],
  24: ['regime_expand_abs'],
  25: ['regime_compress_avg_mult'],
  26: ['regime_expand_avg_mult'],
  27: ['regime_near_zone_mid'],
  28: ['regime_clear_break_frac'],
  29: ['regime_persist_enter'],
  30: ['regime_persist_stay'],
  31: ['regime_persist_pullback'],
  32: ['regime_range_chop_persist_max'],
  33: ['regime_range_trek_share_max'],
  34: ['regime_range_trek_eff_max'],
  35: ['regime_min_dwell_bars'],
  36: ['regime_confirm_bars'],
  37: ['regime_mom_bars'],
  38: ['regime_persist_window'],
  39: ['mtf_trek_flat_frac'],
  40: ['mtf_block_higher_fight'],
  41: ['mtf_require_aligned_side'],
  42: ['mtf_htf_veto'],
  43: ['entry_story_conf_min'],
  44: ['entry_chop_conf_max'],
  45: ['soft_l1_abs'],
  46: ['soft_l2_abs'],
  47: ['soft_l3_abs'],
  48: ['hardinv_pct_bp'],
  49: ['peak_mfe_abs'],
  50: ['peak_mfe_pct_bp'],
  51: ['peak_retention', 'peak_keep'],
  52: ['peak_min_giveback_abs'],
  53: ['target_l1_abs'],
  54: ['target_l2_abs'],
  55: ['target_l3_abs'],
  56: ['target_pct_bp'],
  57: ['safety_tp_rr'],
  58: ['entry_filter_level'],
  59: ['enabled_regimes'],
  60: ['soft_off_regimes'],
  61: ['soft_l1_fallback_frac', 'soft_l2_fallback_frac'],
  62: ['target_l1_fallback_frac', 'target_l2_fallback_frac'],
  63: ['target_stretch_gate'],
  64: ['layer_suggest_p35', 'layer_suggest_p60', 'layer_suggest_p85'],
  65: ['target_l3_min_vs_soft'],
  66: ['peak_mfe_retention_fallback'],
  67: ['max_mfe_giveback'],
  68: ['hardinv_abs_floor'],
  69: ['hardinv_abs_cap'],
  70: ['peak_mfe_abs_floor'],
  71: ['peak_min_giveback_abs'],
  72: ['target_abs_floor'],
  73: ['safety_tp_min_rr'],
  74: ['hardinv_grace_ms'],
  75: ['hardinv_confirm_ms'],
  76: ['structure_grace_ms'],
  77: ['structure_confirm_ms'],
  78: ['timedecay_min_hold_ms'],
  79: ['timedecay_min_fav_abs'],
  80: ['desk_ref_mid'],
  81: ['layered_soft_post_mult_cap'],
  82: ['be_lock_frac', 'be_lock_exec_frac'],
  83: ['min_profit_bank_soft_mult'],
  84: ['safety_tp_vs_min_stop_mult'],
  85: ['safety_sl_cushion_bp'],
  86: [
    'exit_trend_hardinv_mult',
    'exit_pullback_hardinv_mult',
    'exit_fade_hardinv_mult',
    'exit_chop_hardinv_mult',
    'exit_break_hardinv_mult',
    'exit_break_fail_hardinv_mult',
    'exit_expansion_hardinv_mult',
    'exit_reversal_hardinv_mult',
  ],
  87: [
    'exit_trend_peak_arm',
    'exit_pullback_peak_arm',
    'exit_fade_peak_arm',
    'exit_chop_peak_arm',
    'exit_break_peak_arm',
    'exit_break_fail_peak_arm',
    'exit_expansion_peak_arm',
    'exit_reversal_peak_arm',
  ],
  88: [
    'exit_trend_peak_mfe_mult',
    'exit_pullback_peak_mfe_mult',
    'exit_fade_peak_mfe_mult',
    'exit_chop_peak_mfe_mult',
    'exit_break_peak_mfe_mult',
    'exit_break_fail_peak_mfe_mult',
    'exit_expansion_peak_mfe_mult',
    'exit_reversal_peak_mfe_mult',
  ],
  89: [
    'exit_trend_peak_giveback_mult',
    'exit_pullback_peak_giveback_mult',
    'exit_fade_peak_giveback_mult',
    'exit_chop_peak_giveback_mult',
    'exit_break_peak_giveback_mult',
    'exit_break_fail_peak_giveback_mult',
    'exit_expansion_peak_giveback_mult',
    'exit_reversal_peak_giveback_mult',
  ],
  90: [
    'exit_trend_peak_retention',
    'exit_pullback_peak_retention',
    'exit_fade_peak_retention',
    'exit_chop_peak_retention',
    'exit_break_peak_retention',
    'exit_break_fail_peak_retention',
    'exit_expansion_peak_retention',
    'exit_reversal_peak_retention',
  ],
  91: [
    'exit_trend_target_mult',
    'exit_pullback_target_mult',
    'exit_fade_target_mult',
    'exit_chop_target_mult',
    'exit_break_target_mult',
    'exit_break_fail_target_mult',
    'exit_expansion_target_mult',
    'exit_reversal_target_mult',
  ],
  92: [
    'exit_trend_timedecay_hold_ms',
    'exit_pullback_timedecay_hold_ms',
    'exit_fade_timedecay_hold_ms',
    'exit_chop_timedecay_hold_ms',
    'exit_break_timedecay_hold_ms',
    'exit_break_fail_timedecay_hold_ms',
    'exit_expansion_timedecay_hold_ms',
    'exit_reversal_timedecay_hold_ms',
  ],
  93: [
    'exit_trend_timedecay_min_fav_mult',
    'exit_pullback_timedecay_min_fav_mult',
    'exit_fade_timedecay_min_fav_mult',
    'exit_chop_timedecay_min_fav_mult',
    'exit_break_timedecay_min_fav_mult',
    'exit_break_fail_timedecay_min_fav_mult',
    'exit_expansion_timedecay_min_fav_mult',
    'exit_reversal_timedecay_min_fav_mult',
  ],
  94: [
    'exit_trend_structure',
    'exit_pullback_structure',
    'exit_fade_structure',
    'exit_chop_structure',
    'exit_break_structure',
    'exit_break_fail_structure',
    'exit_expansion_structure',
    'exit_reversal_structure',
  ],
  95: ['exit_range_through_mid_slack'],
  96: ['soft_exit_require_1m_change', 'soft_exit_block_same_next_entry'],
  97: ['struct_extreme_hi'],
  98: ['struct_extreme_lo'],
  99: ['struct_start_lo'],
  100: ['struct_start_hi'],
  101: ['struct_half_lo', 'struct_half_hi'],
  102: [
    'zone_band_cut_lo',
    'zone_band_cut_mid_lo',
    'zone_band_cut_mid_hi',
    'zone_band_cut_hi',
  ],
  103: ['minute_trend_bias_lookback'],
  104: ['minute_trend_bias_trek_min_path_bp'],
  105: ['m1_aggregate_min_bars'],
  106: ['breakout_pierce_pos_hi', 'breakout_pierce_pos_lo'],
  107: ['failed_break_reclaim_pos_lo', 'failed_break_reclaim_pos_hi'],
  108: ['compression_entry_pos_lo', 'compression_entry_pos_hi'],
  109: ['exhaust_tip_chase_block'],
  110: ['entry_learner_override_margin'],
  111: ['same_dir_lock_ms'],
  112: ['same_dir_lock_after_loss_ms'],
  113: ['exit_loss_include_hardinv', 'exit_loss_exclude_be_lock'],
  114: ['story_min_path_bp'],
  115: ['story_conf_min'],
  116: ['chase_edge'],
  117: ['trek_firm_mult'],
  118: ['story_sell_struct_pos', 'story_buy_struct_pos'],
  119: ['bounce_dip_color_delta'],
  120: ['exhaust_pos_lo', 'exhaust_pos_hi'],
  121: [
    'story_conf_break',
    'story_conf_bounce_dip',
    'story_conf_struct',
    'story_conf_recent',
    'story_conf_chop_thin',
    'story_conf_chop',
  ],
  122: ['scalp_wick_confirm'],
  123: ['expanding_range_mult'],
  124: ['compressed_range_mult'],
  125: ['velocity_lookback'],
  126: ['pressure_fight_green_buy', 'pressure_fight_green_sell'],
  127: ['softplus_storyfight_exec_fav_mult'],
  128: ['softplus_storyfight_min_mfe_mult'],
  129: ['mind_cut_soft_mult'],
  130: ['mind_cut_retention'],
  131: ['green_soft_arm_mult'],
  132: ['deep_giveback_offset'],
  133: ['softplus_pullback_story_exec_mult'],
  134: ['against_us_soft_mult_hi', 'against_us_soft_mult_lo'],
  135: ['session_expectancy_cut'],
  136: ['mind_entry_conf_base'],
  137: ['left_on_table_peak_tiny_min'],
  138: ['soft_sized_loss_frac'],
  139: ['session_e_bank_hi', 'session_e_bank_lo'],
  140: ['manage_min_sample'],
  141: ['manage_score_session_e_neg', 'manage_score_session_e_pos'],
  142: ['manage_score_window_e_neg'],
  143: ['manage_score_path_soft_green', 'manage_score_path_giveback'],
  144: ['manage_score_m1_reverse', 'manage_score_m1_continue'],
  145: ['manage_score_next_entry_opp'],
  146: ['manage_score_thesis_fight'],
  147: ['pressure_with_us_buy', 'pressure_with_us_sell'],
  148: ['near_target_lean_bank'],
  149: ['manage_score_clamp'],
  150: ['manage_learner_override_margin'],
  151: ['peak_mfe_floor_ease'],
  152: ['strong_htf_aligned_min'],
  153: ['strong_conf_min'],
  154: ['fade_allowed_chapters'],
  155: ['zone_bars'],
  156: ['min_bars_for_zone'],
  157: ['switch_gap_bars'],
  158: ['local_breakout_frac_floor'],
  159: ['trek_full_enter_mult', 'trek_share_min', 'trek_eff_min'],
  160: ['trek_recent_enter_mult', 'trek_recent_share_min'],
  161: [
    'regime_conf_base',
    'regime_conf_strength_scale',
    'regime_conf_min',
    'regime_conf_max',
  ],
  162: ['book_confidence_floor_after_switch'],
  163: ['soft_move_trek_pullback_shortcut'],
  164: ['chop_to_trend_confirm_bars'],
  165: ['sticky_prior_enabled'],
  166: ['transition_detect_enabled'],
  167: ['playbook_promote_vs_live_unify'],
  168: ['expansion_before_trend'],
  169: ['trend_thesis_regimes'],
  170: [
    'adverse_chapters_sell',
    'adverse_chapters_buy',
    'resume_chapters_sell',
    'resume_chapters_buy',
  ],
  171: ['episode_end_on_continue'],
  172: ['episode_softplus_bank_mult'],
  173: ['safety_sl_cushion_bp'],
  174: ['safety_sl_broker_min_mult'],
  175: ['safety_sl_spread_mult'],
  176: ['safety_abs_floor_hi', 'safety_abs_floor_mid', 'safety_abs_floor_lo'],
  177: ['scratch_soft_mfe_frac'],
  178: [
    'entry_learner_lr',
    'entry_learner_l2',
    'entry_learner_temp',
    'entry_learner_explore_eps',
    'entry_learner_max_w',
  ],
  179: ['entry_zone_lo_bin', 'entry_zone_hi_bin'],
  180: [
    'entry_learner_prior_buy',
    'entry_learner_prior_sell',
    'entry_learner_prior_wait',
  ],
  181: ['entry_learner_wait_boost'],
  182: [
    'auto_cal_max_hardinv_abs',
    'auto_cal_max_peak_mfe_abs',
    'auto_cal_max_target_abs',
    'auto_cal_max_safety_tp_rr',
    'auto_cal_min_hardinv_abs',
    'auto_cal_max_peak_retention',
    'auto_cal_min_peak_retention',
  ],
  183: ['soft_tighten_step'],
  184: ['peak_ease_retention_step', 'peak_ease_giveback_step', 'peak_ease_abs_step'],
  185: ['safety_tp_rr_step', 'safety_tp_rr_pullback_step'],
  186: ['min_enabled_regimes'],
  187: ['core_always_on_regimes'],
  188: ['soft_pct_ref_mid'],
  189: ['raise_streak_before_pullback'],
  190: ['soft_sized_loss_detect_min', 'soft_sized_loss_frac'],
  191: ['gap_move_stay', 'gap_stay_enter', 'gap_enter_pullback'],
  192: ['gap_pullback_reversal'],
  193: ['gap_compress_expand'],
  194: ['persist_enter_stay_min_gap'],
  195: ['playbook_require_full_htf_stack'],
  196: ['playbook_block_htf_promote_on_live_chop'],
  197: ['playbook_block_story_promote_on_live_chop'],
  198: ['playbook_chop_overrides_sticky_trend'],
  199: ['reversal_from_breakout_prior'],
  200: ['playbook_one_market_truth'],
  201: ['playbook_break_overrides_sticky_trend'],
  202: ['playbook_htf_require_unanimous'],
  203: ['entry_require_regime_setup'],
  204: ['regime_runner_enabled'],
  205: ['regime_runner_score'],
  206: ['regime_runner_score_max'],
  207: ['regime_runner_active_min_score'],
  208: ['regime_runner_eval_every_n'],
  209: ['regime_runner_deduct_pts', 'regime_runner_recover_pts'],
  210: ['regime_runner_min_target_layer'],
  211: ['regime_runner_success_mfe_retain'],
  212: ['regime_runner_eligible_regimes'],
  213: ['entry_block_post_impulse_tip'],
  214: ['entry_post_impulse_share_min'],
  215: ['entry_post_impulse_min_bars', 'entry_post_impulse_zone_bars'],
  216: ['entry_post_impulse_exempt_lanes'],
  217: ['entry_tip_chase_trend_pullback'],
  218: ['entry_tip_block_finished_move'],
  219: ['entry_trend_tip_require_reject'],
  220: ['peak_keep_genome_owns'],
  221: ['manage_path_deep_green_soft_mult'],
  222: ['manage_path_fade_soft_mult'],
  223: ['manage_path_fade_score'],
  224: ['manage_path_stall_mfe_soft_mult'],
  225: ['manage_path_stall_upl_soft_mult'],
  226: ['manage_path_stall_score'],
  227: ['manage_mae_deep_soft_mult'],
  228: ['manage_mae_deep_score'],
  229: ['manage_score_m1_wait'],
  230: ['manage_score_next_same'],
  231: ['manage_score_thesis_bonus'],
  232: ['manage_score_soft_gate_open'],
  233: ['manage_score_story_fight'],
  234: ['manage_score_story_with'],
  235: ['manage_score_pressure_with'],
  236: ['manage_score_expand_continue'],
  237: ['manage_score_expand_reverse'],
  238: ['manage_score_feed_divergent'],
  239: ['manage_score_feed_strong'],
  240: ['manage_score_chapter_change'],
  241: ['manage_score_near_target'],
  242: ['manage_learner_min_updates'],
  243: ['mind_manage_conf_bank'],
  244: ['mind_manage_conf_cut'],
  245: ['mind_manage_conf_hold_continue'],
  246: ['mind_manage_conf_hold_against'],
  247: ['mind_manage_conf_trail'],
  248: ['mind_deep_green_soft_mult'],
  249: ['timedecay_target_frac'],
  250: ['peak_trail_minbank_frac'],
  251: ['scalp_wick_frac'],
  252: ['scalp_wick_body_frac'],
  253: ['local_breakout_lookback_max'],
  254: ['local_breakout_lookback_min'],
  255: ['local_breakout_skip_bars'],
  256: ['local_breakout_min_struct_bars'],
  257: ['local_breakout_clear_frac_mult'],
  258: ['regime_conf_move_div'],
  259: ['entry_m1_strong_move_mult'],
  260: ['trek_min_path_abs_pts'],
  261: ['safety_spread_fallback_bp'],
  262: ['safety_abs_floor_tiny_bp'],
  263: ['safety_abs_floor_nano_bp'],
  264: ['regime_runner_bad_retain_frac'],
  265: ['auto_calibrate_every_n'],
  266: ['auto_cal_min_hardinv_pct_bp'],
  267: ['auto_cal_max_hardinv_pct_bp'],
  268: ['auto_cal_min_target_pct_bp'],
  269: ['auto_cal_max_target_pct_bp'],
  270: ['auto_cal_min_peak_mfe_pct_bp'],
  271: ['auto_cal_max_peak_mfe_pct_bp'],
  272: ['mind_entry_conf_aligned_strong'],
  273: ['mind_entry_conf_aligned'],
  274: ['mind_entry_conf_strong_m1'],
  275: ['mind_entry_conf_bias'],
  276: ['mind_entry_conf_weak'],
  277: ['mind_entry_conf_regime_boost'],
  278: ['mind_entry_conf_cap'],
  279: ['entry_learner_min_updates'],
  280: ['entry_post_impulse_late_eff_min'],
  281: ['mind_entry_conf_regime_hyp'],
  282: ['mind_entry_conf_pb_wait'],
  283: ['mind_entry_conf_pb_resume_floor'],
  284: ['mind_entry_conf_story_side_floor'],
  285: ['mind_entry_conf_flip_after_loss'],
  286: ['mind_entry_conf_chop_wait'],
  287: ['mind_entry_conf_mixed_wait'],
  288: ['mind_entry_conf_hard_veto'],
  289: ['auto_cal_micro_win_vs_loss'],
  290: ['auto_cal_high_mfe_vs_loss'],
  291: ['auto_cal_left_winner_e_max'],
  292: ['auto_cal_asym_win_vs_loss'],
  293: ['auto_cal_soft_dom_e_max'],
  294: ['auto_cal_soft_dom_win_vs_loss'],
  295: ['auto_cal_ease_filter_e_min'],
  296: ['auto_cal_legacy_raise_e_max'],
  297: ['auto_cal_legacy_raise_win_vs_loss'],
  298: ['auto_cal_soft_tight_e_max'],
  299: ['auto_cal_healthy_e_min'],
  300: ['auto_cal_healthy_win_vs_loss'],
  301: ['auto_cal_target_ease_abs'],
  302: ['auto_cal_target_pct_ease_div'],
  303: ['auto_cal_peak_raise_abs'],
  304: ['auto_cal_target_raise_abs'],
  305: ['auto_cal_target_pct_raise_mult'],
  306: ['auto_cal_peak_pct_raise_mult'],
  307: ['auto_cal_giveback_raise_abs'],
  308: ['auto_cal_healthy_keep_step'],
  309: ['mind_entry_conf_stack_fight'],
  310: ['mind_entry_conf_stack_chapter_wait'],
  311: ['auto_cal_let_winners_e_min'],
  312: ['auto_cal_choppy_ctx_min'],
  313: ['auto_cal_choppy_e_max'],
  314: ['auto_cal_neg_e_align_max'],
  315: ['auto_cal_expand_ctx_min'],
  316: ['auto_cal_expand_e_min'],
  317: ['auto_cal_choppy_dwell_e_max'],
  318: ['auto_cal_fight_ctx_min'],
  319: ['auto_cal_fight_e_max'],
  320: ['auto_cal_soft_dom_loss_count_min'],
  321: ['auto_cal_soft_dom_loss_vs_hardinv'],
  322: ['auto_cal_demote_recover_e_min'],
  323: ['auto_cal_soft_loss_abs_floor'],
  324: ['auto_cal_micro_win_abs_floor'],
  325: ['auto_cal_peak_exits_min'],
  326: ['auto_cal_high_mfe_tiny_count_min'],
  327: ['auto_cal_micro_wins_min'],
  328: ['auto_cal_avg_loss_abs_floor'],
  329: ['auto_cal_already_tall_soft_mult'],
  330: ['auto_cal_soft_tight_soft_losses_min'],
  331: ['auto_cal_soft_tight_high_mfe_min'],
  332: ['auto_cal_soft_tight_hardinv_max'],
  333: ['auto_cal_regime_promote_n_min'],
  334: ['auto_cal_regime_promote_sum_min'],
  335: ['auto_cal_regime_keep_n_max'],
  336: ['auto_cal_regime_keep_sum_min'],
  337: ['auto_cal_regime_demote_sum_max'],
  338: ['auto_cal_mut_soft_plus_giveback_step'],
  339: ['auto_cal_mut_peak_arm_step'],
  340: ['auto_cal_mut_soft_layer_unlock_step'],
  341: ['auto_cal_mut_pb_episode_arm_step'],
  342: ['auto_cal_mut_pb_episode_mfe_step'],
  343: ['auto_cal_mut_soft_plus_runner_step'],
  344: ['auto_cal_mut_soft_plus_leg_step'],
  345: ['auto_cal_mut_soft_plus_giveback_min'],
  346: ['auto_cal_mut_soft_plus_giveback_max'],
  347: ['auto_cal_mut_peak_arm_min'],
  348: ['auto_cal_mut_peak_arm_max'],
  349: ['auto_cal_mut_soft_layer_unlock_min'],
  350: ['auto_cal_mut_soft_layer_unlock_max'],
  351: ['auto_cal_mut_pb_episode_arm_min'],
  352: ['auto_cal_mut_pb_episode_arm_max'],
  353: ['auto_cal_mut_pb_episode_mfe_min'],
  354: ['auto_cal_mut_pb_episode_mfe_max'],
  355: ['auto_cal_mut_soft_plus_runner_min'],
  356: ['auto_cal_mut_soft_plus_runner_max'],
  357: ['auto_cal_mut_soft_plus_leg_min'],
  358: ['auto_cal_mut_soft_plus_leg_max'],
  359: ['auto_cal_range_soft_min'],
  360: ['auto_cal_range_wins_min'],
  361: ['auto_cal_pb_soft_min'],
  362: ['auto_cal_mut_range_chop_down'],
  363: ['auto_cal_mut_range_share_down'],
  364: ['auto_cal_mut_range_eff_down'],
  365: ['auto_cal_mut_range_chop_up'],
  366: ['auto_cal_mut_range_chop_min'],
  367: ['auto_cal_mut_range_chop_max'],
  368: ['auto_cal_mut_range_share_min'],
  369: ['auto_cal_mut_range_share_max'],
  370: ['auto_cal_mut_range_eff_min'],
  371: ['auto_cal_mut_range_eff_max'],
  372: ['auto_cal_same_side_pause_max'],
  373: ['auto_cal_same_side_pause_soft_min'],
  374: ['auto_cal_same_side_pause_step'],
  375: ['auto_cal_choppy_green_lo'],
  376: ['auto_cal_choppy_green_hi'],
  377: ['auto_cal_mut_trek_flat_mult'],
  378: ['auto_cal_mut_trek_flat_min'],
  379: ['auto_cal_mut_trek_flat_max'],
  380: ['auto_cal_mut_story_conf_step'],
  381: ['auto_cal_mut_story_conf_min'],
  382: ['auto_cal_mut_story_conf_max'],
  383: ['auto_cal_mut_confirm_bars_min'],
  384: ['auto_cal_mut_confirm_bars_max'],
  385: ['auto_cal_mut_confirm_bars_step'],
  386: ['auto_cal_mut_dwell_bars_min'],
  387: ['auto_cal_mut_dwell_bars_max'],
  388: ['auto_cal_mut_dwell_bars_step'],
  389: ['story_recent_mins'],
  390: ['story_recent_color_min'],
  391: ['story_bounce_green_lo'],
  392: ['story_bounce_green_hi'],
  393: ['story_bounce_red_min'],
  394: ['story_dip_red_lo'],
  395: ['story_dip_red_hi'],
  396: ['story_dip_green_min'],
  397: ['minute_trend_bias_window_min'],
  398: ['minute_trend_bias_color_votes'],
  399: ['mind_pressure_delta'],
  400: ['mind_session_knife_soft_min'],
  401: ['mind_session_soft_losses_min'],
  402: ['mind_session_soft_sized_min'],
  403: ['mind_session_soft_cap_abs'],
  404: ['auto_cal_peak_vs_soft_floor_add'],
  405: ['auto_cal_target_vs_soft_floor_add'],
  406: ['auto_cal_peak_soft_gap_trigger'],
  407: ['auto_cal_peak_soft_gap_raise'],
  408: ['auto_cal_target_soft_gap_trigger'],
  409: ['auto_cal_target_soft_gap_raise'],
  410: ['auto_cal_safety_rr_floor'],
  411: ['auto_cal_giveback_ease_floor'],
  412: ['auto_cal_giveback_raise_ceil'],
  413: ['auto_cal_entry_filter_min'],
  414: ['auto_cal_entry_filter_max'],
  415: ['auto_cal_entry_filter_step'],
  416: ['mind_manage_session_closes_min'],
  417: ['regime_runner_score_floor'],
  418: ['regime_runner_sample_min'],
  419: ['regime_same_family_confirm_bars'],
  420: ['safety_bucket_hi'],
  421: ['safety_bucket_mid'],
  422: ['safety_bucket_lo'],
  423: ['safety_bucket_tiny'],
  424: ['safety_loosen_mult_1'],
  425: ['safety_loosen_mult_2'],
  426: ['safety_loosen_mult_3'],
  427: ['safety_loosen_mult_4'],
  428: ['safety_loosen_mult_5'],
  429: ['safety_loosen_min_pts_mult'],
  430: ['safety_tp_fallback_frac'],
  431: ['safety_tp_fallback_abs'],
};

const MAX_ITEM = 431;

// Extract labels for items 1-MAX from confirm list (first occurrence)
const labels = new Map<number, string>();
for (const line of confirm.split('\n')) {
  const m = line.match(/^(\d+)\.\s+(.+)$/);
  if (!m) continue;
  const n = Number(m[1]);
  if (n >= 1 && n <= MAX_ITEM && !labels.has(n)) labels.set(n, m[2]!.trim());
}

const servicesDir = join(HERE, '../src/services');
const brainDir = join(HERE, '../src/brainSelfImprove');
const EXCLUDE_FROM_CONSUMER_WIRE = new Set([
  // Schema / sanitize / factory — key names here are NOT runtime consumer wire
  'brainGenome.ts',
  // Explore proposals — coverage checked separately via hypoGaps
  'hypothesize.ts',
]);
/**
 * Keys that intentionally live only in sanitize (inter-knob ladder constraints).
 * They reshape other regime_* values at sanitize time; consumers read those.
 */
const SANITIZE_OWNED_KEYS = new Set([
  'gap_move_stay',
  'gap_stay_enter',
  'gap_enter_pullback',
  'gap_pullback_reversal',
  'gap_compress_expand',
  'persist_enter_stay_min_gap',
]);
const files: string[] = [];
for (const dir of [servicesDir, brainDir]) {
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.proof.test.ts')) {
      files.push(join(dir, f));
    }
  }
}
const corpusByFile = new Map(files.map((f) => [f, readFileSync(f, 'utf8')] as const));
const hypo = corpusByFile.get(join(brainDir, 'hypothesize.ts')) || '';
const autoCal = corpusByFile.get(join(servicesDir, 'autoCalibrate.ts')) || '';
const genomeSrc = corpusByFile.get(join(brainDir, 'brainGenome.ts')) || '';
/** Live consumers only — excludes brainGenome (schema) + hypothesize (explore). */
const consumerFiles = files.filter((f) => !EXCLUDE_FROM_CONSUMER_WIRE.has(f.split('/').pop() || ''));
const consumerCorpus = consumerFiles
  .map((f) => corpusByFile.get(f) || '')
  .join('\n');

type Row = {
  n: number;
  label: string;
  keys: string[];
  inFactory: string[];
  missingFactory: string[];
  wired: string[];
  unwired: string[];
  sanitizeOwned: string[];
  inHypo: string[];
  notInHypo: string[];
};

const rows: Row[] = [];
for (let n = 1; n <= MAX_ITEM; n++) {
  const keys = MAP[n] ?? [];
  const label = labels.get(n) || `item ${n}`;
  const inFactory = keys.filter((k) => factoryKeys.has(k));
  const missingFactory = keys.filter((k) => !factoryKeys.has(k));
  const keyHit = (src: string, k: string) =>
    new RegExp(`(?:\\.|['"])${k}(?:['"]|\\b)`).test(src);
  const sanitizeOwned = inFactory.filter(
    (k) => SANITIZE_OWNED_KEYS.has(k) && keyHit(genomeSrc, k)
  );
  // Wire = live consumer reference OR intentional sanitize-owned ladder key
  const wired = inFactory.filter(
    (k) => keyHit(consumerCorpus, k) || sanitizeOwned.includes(k)
  );
  const unwired = inFactory.filter((k) => !wired.includes(k));
  const inHypo = inFactory.filter((k) => hypo.includes(k) || autoCal.includes(k));
  const notInHypo = inFactory.filter((k) => !inHypo.includes(k));
  rows.push({
    n,
    label,
    keys,
    inFactory,
    missingFactory,
    wired,
    unwired,
    sanitizeOwned,
    inHypo,
    notInHypo,
  });
}

const noKeys = rows.filter((r) => !r.keys.length);
const missingSchema = rows.filter((r) => r.missingFactory.length);
const unwiredRows = rows.filter((r) => r.unwired.length);
const hypoGaps = rows.filter((r) => r.notInHypo.length && r.inFactory.length);
const sanitizeOwnedRows = rows.filter((r) => r.sanitizeOwned.length);

console.log('=== SCHEMA ===');
console.log(
  'items with mapped keys',
  rows.filter((r) => r.keys.length).length,
  `/${MAX_ITEM}`
);
console.log('items with NO mapped keys', noKeys.length);
for (const r of noKeys) console.log(`  #${r.n} ${r.label}`);
console.log('items with keys missing from factory', missingSchema.length);
for (const r of missingSchema) {
  console.log(`  #${r.n} missing: ${r.missingFactory.join(', ')}`);
}

console.log('\n=== CONSUMER WIRE (excl. brainGenome.ts + hypothesize.ts) ===');
console.log('consumer files scanned', consumerFiles.length);
console.log(
  'sanitize-owned ladder items (ok if only in brainGenome enforceRegimeLadder)',
  sanitizeOwnedRows.length
);
for (const r of sanitizeOwnedRows) {
  console.log(`  #${r.n} sanitize-owned: ${r.sanitizeOwned.join(', ')}`);
}
console.log('items with unwired keys', unwiredRows.length);
for (const r of unwiredRows) {
  console.log(`  #${r.n} unwired: ${r.unwired.join(', ')} | ${r.label}`);
}

console.log('\n=== HYPOTHESIZE / AUTO-CAL EXPLORE ===');
console.log('items not in hypo+autoCal', hypoGaps.length);
for (const r of hypoGaps) {
  console.log(`  #${r.n} not explored: ${r.notInHypo.join(', ')}`);
}

const ok =
  !noKeys.length &&
  !missingSchema.length &&
  !unwiredRows.length &&
  !hypoGaps.length;

console.log('\n=== VERDICT ===');
console.log(
  ok
    ? `SCHEMA+CONSUMER-WIRE+HYPOTHESIZE complete for ${MAX_ITEM} mapped knobs`
    : 'GAPS remain — see above'
);
console.log(
  `Note: wire = key name in live consumer .ts (not proof of every decision path). ` +
    `Behavior proofs are representative (genomeWireCut.proof.test.ts), not 1:1 per knob.`
);
console.log(
  `hypothesize/auto-cal coverage: ${MAX_ITEM - hypoGaps.length}/${MAX_ITEM} items have ≥1 key explored`
);

const report = {
  ok,
  mapped: rows.filter((r) => r.keys.length).length,
  consumerFiles: consumerFiles.map((f) => f.split('/').pop()),
  excludedFromWire: [...EXCLUDE_FROM_CONSUMER_WIRE],
  sanitizeOwnedKeys: [...SANITIZE_OWNED_KEYS],
  noKeys: noKeys.map((r) => r.n),
  missingSchema: missingSchema.map((r) => ({ n: r.n, keys: r.missingFactory })),
  sanitizeOwned: sanitizeOwnedRows.map((r) => ({
    n: r.n,
    keys: r.sanitizeOwned,
    label: r.label,
  })),
  unwired: unwiredRows.map((r) => ({ n: r.n, keys: r.unwired, label: r.label })),
  hypoGaps: hypoGaps.map((r) => ({ n: r.n, keys: r.notInHypo })),
};
writeFileSync(
  join(HERE, '../../../docs/BRAIN_OWNERSHIP_AUDIT.json'),
  JSON.stringify(report, null, 2)
);
console.log('\nWrote docs/BRAIN_OWNERSHIP_AUDIT.json');
