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
};

const MAX_ITEM = 203;

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
const files: string[] = [];
for (const dir of [servicesDir, brainDir]) {
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.proof.test.ts')) {
      files.push(join(dir, f));
    }
  }
}
const corpusByFile = new Map(files.map((f) => [f, readFileSync(f, 'utf8')] as const));
const corpus = [...corpusByFile.values()].join('\n');
const hypo = corpusByFile.get(join(brainDir, 'hypothesize.ts')) || '';
const autoCal = corpusByFile.get(join(servicesDir, 'autoCalibrate.ts')) || '';

type Row = {
  n: number;
  label: string;
  keys: string[];
  inFactory: string[];
  missingFactory: string[];
  wired: string[];
  unwired: string[];
  inHypo: string[];
  notInHypo: string[];
};

const rows: Row[] = [];
for (let n = 1; n <= MAX_ITEM; n++) {
  const keys = MAP[n] ?? [];
  const label = labels.get(n) || `item ${n}`;
  const inFactory = keys.filter((k) => factoryKeys.has(k));
  const missingFactory = keys.filter((k) => !factoryKeys.has(k));
  const wired = inFactory.filter((k) => {
    const re = new RegExp(`(?:\\.|['"])${k}(?:['"]|\\b)`);
    return re.test(corpus);
  });
  const unwired = inFactory.filter((k) => !wired.includes(k));
  const inHypo = inFactory.filter((k) => hypo.includes(k) || autoCal.includes(k));
  const notInHypo = inFactory.filter((k) => !inHypo.includes(k));
  rows.push({ n, label, keys, inFactory, missingFactory, wired, unwired, inHypo, notInHypo });
}

const noKeys = rows.filter((r) => !r.keys.length);
const missingSchema = rows.filter((r) => r.missingFactory.length);
const unwiredRows = rows.filter((r) => r.unwired.length);
const hypoGaps = rows.filter((r) => r.notInHypo.length && r.inFactory.length);

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

console.log('\n=== CONSUMER WIRE ===');
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
  !unwiredRows.length;

console.log('\n=== VERDICT ===');
console.log(
  ok
    ? `SCHEMA+WIRE complete for ${MAX_ITEM} mapped knobs`
    : 'GAPS remain — see above'
);
console.log(
  `hypothesize/auto-cal coverage: ${MAX_ITEM - hypoGaps.length}/${MAX_ITEM} items have ≥1 key explored`
);

const report = {
  ok,
  mapped: rows.filter((r) => r.keys.length).length,
  noKeys: noKeys.map((r) => r.n),
  missingSchema: missingSchema.map((r) => ({ n: r.n, keys: r.missingFactory })),
  unwired: unwiredRows.map((r) => ({ n: r.n, keys: r.unwired, label: r.label })),
  hypoGaps: hypoGaps.map((r) => ({ n: r.n, keys: r.notInHypo })),
};
writeFileSync(
  join(HERE, '../../../docs/BRAIN_OWNERSHIP_AUDIT.json'),
  JSON.stringify(report, null, 2)
);
console.log('\nWrote docs/BRAIN_OWNERSHIP_AUDIT.json');
