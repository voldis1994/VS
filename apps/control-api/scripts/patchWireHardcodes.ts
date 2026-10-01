/**
 * One-shot patch: inject remaining calibratable genome keys after peak_keep_genome_owns.
 * Run: npx tsx scripts/patchWireHardcodes.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATH = join(HERE, '../src/brainSelfImprove/brainGenome.ts');

type Spec = {
  name: string;
  typ: string;
  def: string;
  sanitize: string;
  doc: string;
};

const SPECS: Spec[] = [
  {
    name: 'manage_path_deep_green_soft_mult',
    typ: 'number',
    def: '0.85',
    sanitize: 'round2(clamp(Number(p.manage_path_deep_green_soft_mult ?? d.manage_path_deep_green_soft_mult), 0.5, 1.2))',
    doc: 'Manage score: deep green when upl ≥ soft×this',
  },
  {
    name: 'manage_path_fade_soft_mult',
    typ: 'number',
    def: '0.15',
    sanitize: 'round2(clamp(Number(p.manage_path_fade_soft_mult ?? d.manage_path_fade_soft_mult), 0.05, 0.5))',
    doc: 'Manage score: fading green when upl ≤ soft×this',
  },
  {
    name: 'manage_path_fade_score',
    typ: 'number',
    def: '0.75',
    sanitize: 'round2(clamp(Number(p.manage_path_fade_score ?? d.manage_path_fade_score), 0.1, 2.0))',
    doc: 'Manage score add when green fading to Soft',
  },
  {
    name: 'manage_path_stall_mfe_soft_mult',
    typ: 'number',
    def: '0.4',
    sanitize: 'round2(clamp(Number(p.manage_path_stall_mfe_soft_mult ?? d.manage_path_stall_mfe_soft_mult), 0.1, 0.9))',
    doc: 'Manage sub-Soft stall: mfe > soft×this',
  },
  {
    name: 'manage_path_stall_upl_soft_mult',
    typ: 'number',
    def: '0.15',
    sanitize: 'round2(clamp(Number(p.manage_path_stall_upl_soft_mult ?? d.manage_path_stall_upl_soft_mult), 0.05, 0.5))',
    doc: 'Manage sub-Soft stall: upl < soft×this',
  },
  {
    name: 'manage_path_stall_score',
    typ: 'number',
    def: '0.2',
    sanitize: 'round2(clamp(Number(p.manage_path_stall_score ?? d.manage_path_stall_score), 0.05, 1.0))',
    doc: 'Manage score add on sub-Soft stall',
  },
  {
    name: 'manage_mae_deep_soft_mult',
    typ: 'number',
    def: '0.85',
    sanitize: 'round2(clamp(Number(p.manage_mae_deep_soft_mult ?? d.manage_mae_deep_soft_mult), 0.5, 1.2))',
    doc: 'Manage MAE deep then green: mae ≥ soft×this',
  },
  {
    name: 'manage_mae_deep_score',
    typ: 'number',
    def: '0.45',
    sanitize: 'round2(clamp(Number(p.manage_mae_deep_score ?? d.manage_mae_deep_score), 0.1, 1.5))',
    doc: 'Manage score add on deep MAE then green',
  },
  {
    name: 'manage_score_m1_wait',
    typ: 'number',
    def: '0.15',
    sanitize: 'round2(clamp(Number(p.manage_score_m1_wait ?? d.manage_score_m1_wait), 0.05, 1.0))',
    doc: 'Manage score add on 1m wait',
  },
  {
    name: 'manage_score_next_same',
    typ: 'number',
    def: '0.55',
    sanitize: 'round2(clamp(Number(p.manage_score_next_same ?? d.manage_score_next_same), 0.1, 1.5))',
    doc: 'Manage score subtract when next same-side',
  },
  {
    name: 'manage_score_thesis_bonus',
    typ: 'number',
    def: '0.25',
    sanitize: 'round2(clamp(Number(p.manage_score_thesis_bonus ?? d.manage_score_thesis_bonus), 0.05, 1.0))',
    doc: 'Manage score add on thesis fail / regime drift',
  },
  {
    name: 'manage_score_soft_gate_open',
    typ: 'number',
    def: '0.2',
    sanitize: 'round2(clamp(Number(p.manage_score_soft_gate_open ?? d.manage_score_soft_gate_open), 0.05, 1.0))',
    doc: 'Manage score add when softGate open',
  },
  {
    name: 'manage_score_story_fight',
    typ: 'number',
    def: '0.85',
    sanitize: 'round2(clamp(Number(p.manage_score_story_fight ?? d.manage_score_story_fight), 0.1, 2.0))',
    doc: 'Manage score add when story fights open',
  },
  {
    name: 'manage_score_story_with',
    typ: 'number',
    def: '0.35',
    sanitize: 'round2(clamp(Number(p.manage_score_story_with ?? d.manage_score_story_with), 0.05, 1.5))',
    doc: 'Manage score subtract when story with us',
  },
  {
    name: 'manage_score_pressure_with',
    typ: 'number',
    def: '0.4',
    sanitize: 'round2(clamp(Number(p.manage_score_pressure_with ?? d.manage_score_pressure_with), 0.05, 1.5))',
    doc: 'Manage score subtract when pressure with us',
  },
  {
    name: 'manage_score_expand_continue',
    typ: 'number',
    def: '0.35',
    sanitize: 'round2(clamp(Number(p.manage_score_expand_continue ?? d.manage_score_expand_continue), 0.05, 1.5))',
    doc: 'Manage score subtract EXPAND+continue',
  },
  {
    name: 'manage_score_expand_reverse',
    typ: 'number',
    def: '0.45',
    sanitize: 'round2(clamp(Number(p.manage_score_expand_reverse ?? d.manage_score_expand_reverse), 0.05, 1.5))',
    doc: 'Manage score add EXPAND+reverse',
  },
  {
    name: 'manage_score_feed_divergent',
    typ: 'number',
    def: '0.5',
    sanitize: 'round2(clamp(Number(p.manage_score_feed_divergent ?? d.manage_score_feed_divergent), 0.05, 1.5))',
    doc: 'Manage score add feed DIVERGENT',
  },
  {
    name: 'manage_score_feed_strong',
    typ: 'number',
    def: '0.15',
    sanitize: 'round2(clamp(Number(p.manage_score_feed_strong ?? d.manage_score_feed_strong), 0.05, 1.0))',
    doc: 'Manage score subtract feed STRONG',
  },
  {
    name: 'manage_score_chapter_change',
    typ: 'number',
    def: '0.35',
    sanitize: 'round2(clamp(Number(p.manage_score_chapter_change ?? d.manage_score_chapter_change), 0.05, 1.5))',
    doc: 'Manage score add on chapter change',
  },
  {
    name: 'manage_score_near_target',
    typ: 'number',
    def: '0.4',
    sanitize: 'round2(clamp(Number(p.manage_score_near_target ?? d.manage_score_near_target), 0.05, 1.5))',
    doc: 'Manage score add near Target lean BANK',
  },
  {
    name: 'manage_learner_min_updates',
    typ: 'number',
    def: '20',
    sanitize: 'clampInt(p.manage_learner_min_updates, d.manage_learner_min_updates, 5, 100)',
    doc: 'Learner overrides Mind after ≥N updates',
  },
  {
    name: 'mind_manage_conf_bank',
    typ: 'number',
    def: '0.88',
    sanitize: 'round2(clamp(Number(p.mind_manage_conf_bank ?? d.mind_manage_conf_bank), 0.5, 0.99))',
    doc: 'PRĀTS manage confidence BANK',
  },
  {
    name: 'mind_manage_conf_cut',
    typ: 'number',
    def: '0.78',
    sanitize: 'round2(clamp(Number(p.mind_manage_conf_cut ?? d.mind_manage_conf_cut), 0.4, 0.99))',
    doc: 'PRĀTS manage confidence CUT',
  },
  {
    name: 'mind_manage_conf_hold_continue',
    typ: 'number',
    def: '0.8',
    sanitize: 'round2(clamp(Number(p.mind_manage_conf_hold_continue ?? d.mind_manage_conf_hold_continue), 0.4, 0.99))',
    doc: 'PRĀTS manage confidence HOLD continue',
  },
  {
    name: 'mind_manage_conf_hold_against',
    typ: 'number',
    def: '0.6',
    sanitize: 'round2(clamp(Number(p.mind_manage_conf_hold_against ?? d.mind_manage_conf_hold_against), 0.3, 0.95))',
    doc: 'PRĀTS manage confidence HOLD against',
  },
  {
    name: 'mind_manage_conf_trail',
    typ: 'number',
    def: '0.65',
    sanitize: 'round2(clamp(Number(p.mind_manage_conf_trail ?? d.mind_manage_conf_trail), 0.3, 0.95))',
    doc: 'PRĀTS manage confidence TRAIL',
  },
  {
    name: 'mind_deep_green_soft_mult',
    typ: 'number',
    def: '0.85',
    sanitize: 'round2(clamp(Number(p.mind_deep_green_soft_mult ?? d.mind_deep_green_soft_mult), 0.5, 1.2))',
    doc: 'PRĀTS thesis deep green: upl ≥ soft×this',
  },
  {
    name: 'timedecay_target_frac',
    typ: 'number',
    def: '0.4',
    sanitize: 'round2(clamp(Number(p.timedecay_target_frac ?? d.timedecay_target_frac), 0.1, 0.9))',
    doc: 'TimeDecay minFav floor = target_abs × this',
  },
  {
    name: 'peak_trail_minbank_frac',
    typ: 'number',
    def: '0.5',
    sanitize: 'round2(clamp(Number(p.peak_trail_minbank_frac ?? d.peak_trail_minbank_frac), 0.2, 1.0))',
    doc: 'Peak trail floor lower bound = minBank × this',
  },
  {
    name: 'scalp_wick_frac',
    typ: 'number',
    def: '0.45',
    sanitize: 'round2(clamp(Number(p.scalp_wick_frac ?? d.scalp_wick_frac), 0.2, 0.8))',
    doc: 'Scalp 1m wick rejection fraction',
  },
  {
    name: 'scalp_wick_body_frac',
    typ: 'number',
    def: '0.15',
    sanitize: 'round2(clamp(Number(p.scalp_wick_body_frac ?? d.scalp_wick_body_frac), 0.05, 0.4))',
    doc: 'Scalp 1m wick body tolerance fraction',
  },
  {
    name: 'local_breakout_lookback_max',
    typ: 'number',
    def: '60',
    sanitize: 'clampInt(p.local_breakout_lookback_max, d.local_breakout_lookback_max, 20, 120)',
    doc: 'Local shelf lookback max bars',
  },
  {
    name: 'local_breakout_lookback_min',
    typ: 'number',
    def: '18',
    sanitize: 'clampInt(p.local_breakout_lookback_min, d.local_breakout_lookback_min, 8, 60)',
    doc: 'Local shelf lookback min bars',
  },
  {
    name: 'local_breakout_skip_bars',
    typ: 'number',
    def: '6',
    sanitize: 'clampInt(p.local_breakout_skip_bars, d.local_breakout_skip_bars, 2, 20)',
    doc: 'Local shelf skip last N bars',
  },
  {
    name: 'local_breakout_min_struct_bars',
    typ: 'number',
    def: '12',
    sanitize: 'clampInt(p.local_breakout_min_struct_bars, d.local_breakout_min_struct_bars, 6, 40)',
    doc: 'Local shelf min structure bars',
  },
  {
    name: 'local_breakout_clear_frac_mult',
    typ: 'number',
    def: '0.5',
    sanitize: 'round2(clamp(Number(p.local_breakout_clear_frac_mult ?? d.local_breakout_clear_frac_mult), 0.2, 1.0))',
    doc: 'Local break frac = max(floor, CLEAR_BREAK × this)',
  },
  {
    name: 'regime_conf_move_div',
    typ: 'number',
    def: '4',
    sanitize: 'clampInt(p.regime_conf_move_div, d.regime_conf_move_div, 2, 10)',
    doc: 'Regime confidence body/range vs MOVE×this',
  },
  {
    name: 'entry_m1_strong_move_mult',
    typ: 'number',
    def: '0.5',
    sanitize: 'round2(clamp(Number(p.entry_m1_strong_move_mult ?? d.entry_m1_strong_move_mult), 0.2, 1.0))',
    doc: 'Entry m1Strong when |body| ≥ MOVE×this',
  },
  {
    name: 'trek_min_path_abs_pts',
    typ: 'number',
    def: '3',
    sanitize: 'round1(clamp(Number(p.trek_min_path_abs_pts ?? d.trek_min_path_abs_pts), 0.5, 20))',
    doc: 'Trek/minPath absolute Gold pts floor',
  },
  {
    name: 'safety_spread_fallback_bp',
    typ: 'number',
    def: '0.5',
    sanitize: 'clamp(coerceMicroBp(p.safety_spread_fallback_bp, d.safety_spread_fallback_bp), 0.1, 20)',
    doc: 'SAFETY spread fallback when bid/ask missing (bp)',
  },
  {
    name: 'safety_abs_floor_tiny_bp',
    typ: 'number',
    def: '5',
    sanitize: 'clamp(coerceMicroBp(p.safety_abs_floor_tiny_bp, d.safety_abs_floor_tiny_bp), 0.1, 50)',
    doc: 'SAFETY abs floor for mid≈1…10 as bp of price',
  },
  {
    name: 'safety_abs_floor_nano_bp',
    typ: 'number',
    def: '0.5',
    sanitize: 'clamp(coerceMicroBp(p.safety_abs_floor_nano_bp, d.safety_abs_floor_nano_bp), 0.1, 20)',
    doc: 'SAFETY abs floor for mid<1 as bp of price',
  },
  {
    name: 'regime_runner_bad_retain_frac',
    typ: 'number',
    def: '0.5',
    sanitize: 'round2(clamp(Number(p.regime_runner_bad_retain_frac ?? d.regime_runner_bad_retain_frac), 0.2, 0.9))',
    doc: 'Runner score bad if retain < success×this',
  },
  {
    name: 'auto_calibrate_every_n',
    typ: 'number',
    def: '5',
    sanitize: 'clampInt(p.auto_calibrate_every_n, d.auto_calibrate_every_n, 2, 20)',
    doc: 'Autotune every N closes',
  },
  {
    name: 'auto_cal_min_hardinv_pct_bp',
    typ: 'number',
    def: '2',
    sanitize: 'clamp(coerceMicroBp(p.auto_cal_min_hardinv_pct_bp, d.auto_cal_min_hardinv_pct_bp), 0.1, 50)',
    doc: 'Auto-cal min hardinv pct (bp) — not 0.0002',
  },
  {
    name: 'auto_cal_max_hardinv_pct_bp',
    typ: 'number',
    def: '40',
    sanitize: 'clamp(coerceMicroBp(p.auto_cal_max_hardinv_pct_bp, d.auto_cal_max_hardinv_pct_bp), 1, 200)',
    doc: 'Auto-cal max hardinv pct (bp)',
  },
  {
    name: 'auto_cal_min_target_pct_bp',
    typ: 'number',
    def: '8',
    sanitize: 'clamp(coerceMicroBp(p.auto_cal_min_target_pct_bp, d.auto_cal_min_target_pct_bp), 0.1, 100)',
    doc: 'Auto-cal min target pct (bp)',
  },
  {
    name: 'auto_cal_max_target_pct_bp',
    typ: 'number',
    def: '100',
    sanitize: 'clamp(coerceMicroBp(p.auto_cal_max_target_pct_bp, d.auto_cal_max_target_pct_bp), 10, 500)',
    doc: 'Auto-cal max target pct (bp)',
  },
  {
    name: 'auto_cal_min_peak_mfe_pct_bp',
    typ: 'number',
    def: '2',
    sanitize: 'clamp(coerceMicroBp(p.auto_cal_min_peak_mfe_pct_bp, d.auto_cal_min_peak_mfe_pct_bp), 0.1, 50)',
    doc: 'Auto-cal min peak mfe pct (bp)',
  },
  {
    name: 'auto_cal_max_peak_mfe_pct_bp',
    typ: 'number',
    def: '60',
    sanitize: 'clamp(coerceMicroBp(p.auto_cal_max_peak_mfe_pct_bp, d.auto_cal_max_peak_mfe_pct_bp), 1, 200)',
    doc: 'Auto-cal max peak mfe pct (bp)',
  },
  {
    name: 'mind_entry_conf_aligned_strong',
    typ: 'number',
    def: '0.9',
    sanitize: 'round2(clamp(Number(p.mind_entry_conf_aligned_strong ?? d.mind_entry_conf_aligned_strong), 0.5, 0.99))',
    doc: 'Entry PRĀTS conf when stack aligned + strong 1m',
  },
  {
    name: 'mind_entry_conf_aligned',
    typ: 'number',
    def: '0.82',
    sanitize: 'round2(clamp(Number(p.mind_entry_conf_aligned ?? d.mind_entry_conf_aligned), 0.5, 0.99))',
    doc: 'Entry PRĀTS conf when stack aligned',
  },
  {
    name: 'mind_entry_conf_strong_m1',
    typ: 'number',
    def: '0.85',
    sanitize: 'round2(clamp(Number(p.mind_entry_conf_strong_m1 ?? d.mind_entry_conf_strong_m1), 0.5, 0.99))',
    doc: 'Entry PRĀTS conf strong 1m not fully aligned',
  },
  {
    name: 'mind_entry_conf_bias',
    typ: 'number',
    def: '0.75',
    sanitize: 'round2(clamp(Number(p.mind_entry_conf_bias ?? d.mind_entry_conf_bias), 0.4, 0.95))',
    doc: 'Entry PRĀTS conf bias-side',
  },
  {
    name: 'mind_entry_conf_weak',
    typ: 'number',
    def: '0.68',
    sanitize: 'round2(clamp(Number(p.mind_entry_conf_weak ?? d.mind_entry_conf_weak), 0.3, 0.9))',
    doc: 'Entry PRĀTS conf weak stack side',
  },
  {
    name: 'mind_entry_conf_regime_boost',
    typ: 'number',
    def: '0.06',
    sanitize: 'round2(clamp(Number(p.mind_entry_conf_regime_boost ?? d.mind_entry_conf_regime_boost), 0.02, 0.2))',
    doc: 'Entry PRĀTS conf boost on regime/story align',
  },
  {
    name: 'mind_entry_conf_cap',
    typ: 'number',
    def: '0.92',
    sanitize: 'round2(clamp(Number(p.mind_entry_conf_cap ?? d.mind_entry_conf_cap), 0.7, 0.99))',
    doc: 'Entry PRĀTS conf ceiling after boost',
  },
];

let src = readFileSync(PATH, 'utf8');
if (src.includes('manage_path_deep_green_soft_mult')) {
  console.log('Already patched');
  process.exit(0);
}

const typeBlock = SPECS.map(
  (s) => `  /** ${s.doc} */\n  ${s.name}: ${s.typ};`
).join('\n');
const defBlock = SPECS.map((s) => `  ${s.name}: ${s.def},`).join('\n');
const sanBlock = SPECS.map((s) => `    ${s.name}: ${s.sanitize},`).join('\n');
const keyBlock = SPECS.map((s) => `  '${s.name}',`).join('\n');

const typeAnchor = `  peak_keep_genome_owns: boolean;\n  /** EXPANSION priority before TREND when both fire */`;
if (!src.includes(typeAnchor)) throw new Error('type anchor missing');
src = src.replace(
  typeAnchor,
  `  peak_keep_genome_owns: boolean;\n${typeBlock}\n  /** EXPANSION priority before TREND when both fire */`
);

const defAnchor = `  peak_keep_genome_owns: true,\n  expansion_before_trend: false,`;
if (!src.includes(defAnchor)) throw new Error('def anchor missing');
src = src.replace(
  defAnchor,
  `  peak_keep_genome_owns: true,\n${defBlock}\n  expansion_before_trend: false,`
);

const sanAnchor = `    peak_keep_genome_owns: p.peak_keep_genome_owns !== false,\n    expansion_before_trend: p.expansion_before_trend === true,`;
if (!src.includes(sanAnchor)) throw new Error('sanitize anchor missing');
src = src.replace(
  sanAnchor,
  `    peak_keep_genome_owns: p.peak_keep_genome_owns !== false,\n${sanBlock}\n    expansion_before_trend: p.expansion_before_trend === true,`
);

const keyAnchor = `  'peak_keep_genome_owns',\n  'expansion_before_trend',`;
if (!src.includes(keyAnchor)) throw new Error('keys anchor missing');
src = src.replace(
  keyAnchor,
  `  'peak_keep_genome_owns',\n${keyBlock}\n  'expansion_before_trend',`
);

writeFileSync(PATH, src);
console.log(`Patched ${SPECS.length} keys → ${PATH}`);
console.log(SPECS.map((s) => s.name).join('\n'));
