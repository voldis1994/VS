/**
 * Pattern → hypothesis → concrete allowlisted patches / genome delta.
 * Tries ranked patterns + alternate variants so SKIPPED does not stall forever.
 */
import {
  getBrainGenome,
  type BrainGenome,
  type GenomePeakArmMode,
  type GenomeStructureInvalidation,
} from './brainGenome.js';
import {
  hypothesisSignature,
  type BrainExperience,
  type BrainHypothesis,
} from './experience.js';
import type { BrainPatch } from './guards.js';
import type { AnalysisResult } from './analyze.js';
import {
  codePatchesBankGreen,
  codePatchesMicroScratch,
  codePatchesSoftSpam,
} from './codePatches.js';

function genomePatch(
  findKey: keyof BrainGenome,
  nextVal: string | number | boolean,
  note: string
): BrainPatch | null {
  const g = getBrainGenome();
  const cur = g[findKey];
  if (cur === nextVal) return null;
  const curJson =
    typeof cur === 'string' ? `"${cur}"` : typeof cur === 'boolean' ? String(cur) : String(cur);
  const nextJson =
    typeof nextVal === 'string'
      ? `"${nextVal}"`
      : typeof nextVal === 'boolean'
        ? String(nextVal)
        : String(nextVal);
  if (`"${findKey}": ${curJson}` === `"${findKey}": ${nextJson}`) return null;
  return {
    path: 'data/brain-self-improve/genome.json',
    find: `"${findKey}": ${curJson}`,
    replace: `"${findKey}": ${nextJson}`,
    note,
  };
}

function compactPatches(patches: Array<BrainPatch | null>): BrainPatch[] {
  const uniq: BrainPatch[] = [];
  const seen = new Set<string>();
  for (const p of patches) {
    if (!p) continue;
    if (p.find === p.replace) continue;
    const k = `${p.path}::${p.find}::${p.replace}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
  }
  return uniq;
}

type Variant = {
  title: string;
  rationale: string;
  task: string;
  genome_delta: Record<string, unknown>;
  patches: Array<BrainPatch | null>;
};

function softSellVariants(g: BrainGenome, softSell: number): Variant[] {
  const pause1 = Math.min(8, g.soft_same_side_pause_closes + 1);
  const pause2 = Math.min(8, g.soft_same_side_pause_closes + 2);
  const pauseMin = Math.min(6, g.soft_same_side_pause_min + 1);
  const keep = Math.min(0.85, g.peak_keep + 0.02);
  const arm = Math.max(0.5, Number((g.peak_arm_soft_mult - 0.05).toFixed(2)));
  const pauseFirst: Variant = {
    title: 'Pause SELL spam after Soft chain + require 1m trigger',
    rationale: `Soft SELL×${softSell} in window — bias-only shorts hitting Soft.`,
    task:
      'Tighten genome + lengthen Soft same-dir lock in flipFilter; require 1m trigger.',
    genome_delta: {
      wait_on_1m_fight: true,
      require_1m_trigger: true,
      soft_same_side_pause_min: Math.max(2, g.soft_same_side_pause_min),
      soft_same_side_pause_closes: pause1,
      last_lesson: 'Pause SELL Soft spam',
    },
    patches: [
      genomePatch('wait_on_1m_fight', true, 'force WAIT on 1m fight'),
      genomePatch('require_1m_trigger', true, 'require 1m trigger'),
      genomePatch('soft_same_side_pause_closes', pause1, 'longer Soft same-side pause'),
      ...codePatchesSoftSpam(0),
    ],
  };
  const pauseHarder: Variant = {
    title: 'Harder Soft same-side pause (SELL) + filter lock',
    rationale: `Prior pause insufficient — Soft SELL×${softSell}`,
    task: 'Raise soft pause genome + bump flipFilter Soft lock further.',
    genome_delta: {
      soft_same_side_pause_closes: pause2,
      soft_same_side_pause_min: pauseMin,
      require_1m_trigger: true,
      last_lesson: 'Harder Soft SELL pause',
    },
    patches: [
      genomePatch('soft_same_side_pause_closes', pause2, 'pause +2 closes'),
      genomePatch('soft_same_side_pause_min', pauseMin, 'arm pause sooner'),
      genomePatch('require_1m_trigger', true, '1m trigger'),
      ...codePatchesSoftSpam(1),
    ],
  };
  const measurable: Variant = {
    title: 'Arm Peak earlier after Soft survivors + Keep nudge',
    rationale: 'Entry spam cut; survivors should bank sooner via Peak arm.',
    task: 'Lower peak_arm_soft_mult and raise peak_keep.',
    genome_delta: {
      peak_arm_soft_mult: arm,
      peak_keep: keep,
      wait_on_1m_fight: true,
      last_lesson: 'Earlier Peak arm after Soft lessons',
    },
    patches: [
      genomePatch('peak_arm_soft_mult', arm, 'arm Peak earlier'),
      genomePatch('peak_keep', keep, 'tighter Keep'),
      genomePatch('wait_on_1m_fight', true, 'WAIT on 1m fight'),
    ],
  };
  if (g.soft_same_side_pause_closes >= 8) {
    return [measurable, pauseHarder];
  }
  return [pauseFirst, pauseHarder, measurable];
}

function softBuyVariants(g: BrainGenome, softBuy: number): Variant[] {
  const pause1 = Math.min(8, g.soft_same_side_pause_closes + 1);
  const pause2 = Math.min(8, g.soft_same_side_pause_closes + 2);
  return [
    {
      title: 'Pause BUY spam after Soft chain',
      rationale: `Soft BUY×${softBuy}`,
      task: 'Same-side Soft pause + 1m trigger for longs.',
      genome_delta: {
        soft_same_side_pause_min: 2,
        soft_same_side_pause_closes: pause1,
        require_1m_trigger: true,
        last_lesson: 'Pause BUY Soft spam',
      },
      patches: [
        genomePatch('soft_same_side_pause_closes', pause1, 'BUY Soft pause longer'),
        genomePatch('require_1m_trigger', true, '1m trigger'),
        ...codePatchesSoftSpam(0),
      ],
    },
    {
      title: 'Harder BUY Soft pause',
      rationale: `Soft BUY×${softBuy} continues`,
      task: 'Raise pause closes further + flipFilter Soft lock.',
      genome_delta: {
        soft_same_side_pause_closes: pause2,
        require_1m_trigger: true,
        wait_on_1m_fight: true,
        last_lesson: 'Harder BUY Soft pause',
      },
      patches: [
        genomePatch('soft_same_side_pause_closes', pause2, 'BUY pause +2'),
        genomePatch('wait_on_1m_fight', true, 'wait 1m fight'),
        ...codePatchesSoftSpam(1),
      ],
    },
  ];
}

function bankGreenVariants(g: BrainGenome, left: number, e: number): Variant[] {
  const nextKeep = Math.min(0.95, Math.max(0.1, g.peak_keep + 0.03));
  const nextGb = Math.min(0.82, Math.max(0.7, g.soft_plus_giveback + 0.03));
  const nextKeep2 = Math.min(0.95, g.peak_keep + 0.05);
  const arm = Math.max(0.5, Number((g.peak_arm_soft_mult - 0.08).toFixed(2)));
  return [
    {
      title: 'Bank Soft+ sooner — raise Keep / giveback bank',
      rationale: `Left winners on table×${left} · E=${e.toFixed(2)}`,
      task: 'Genome Keep/giveback + Mind code CUT Soft+ earlier.',
      genome_delta: {
        peak_keep: nextKeep,
        soft_plus_giveback: nextGb,
        mind_bank_on_turn: true,
        last_lesson: 'Bank Soft+ sooner',
      },
      patches: [
        genomePatch('peak_keep', nextKeep, 'tighter Peak Keep'),
        genomePatch('soft_plus_giveback', nextGb, 'earlier Soft+ giveback bank'),
        genomePatch('mind_bank_on_turn', true, 'mind banks on turn'),
        ...codePatchesBankGreen(),
      ],
    },
    {
      title: 'Aggressive Peak arm + Keep for left-on-table',
      rationale: `Still leaving MFE on table×${left}`,
      task: 'Lower peak_arm_soft_mult and push Keep higher + Mind bank earlier.',
      genome_delta: {
        peak_arm_soft_mult: arm,
        peak_keep: nextKeep2,
        mind_bank_on_turn: true,
        last_lesson: 'Aggressive Peak arm',
      },
      patches: [
        genomePatch('peak_arm_soft_mult', arm, 'much earlier Peak arm'),
        genomePatch('peak_keep', nextKeep2, 'Keep push'),
        genomePatch('mind_bank_on_turn', true, 'mind bank on'),
        ...codePatchesBankGreen(),
      ],
    },
  ];
}

function microScratchVariants(g: BrainGenome): Variant[] {
  return [
    {
      title: 'Reduce micro-scratch sensitivity',
      rationale: 'Micro scratches — structure/Limit noise.',
      task: 'Tighten structureEntry extremes + genome 1m trigger.',
      genome_delta: {
        require_1m_trigger: true,
        wait_on_1m_fight: true,
        last_lesson: 'Avoid knife micro-scratch entries',
      },
      patches: [
        genomePatch('require_1m_trigger', true, 'avoid knife entries'),
        genomePatch('wait_on_1m_fight', true, 'wait 1m fight'),
        ...codePatchesMicroScratch(0),
      ],
    },
    {
      title: 'Slight Keep tighten after scratch noise',
      rationale: 'Entry noise; survivors should bank cleanly.',
      task: 'Nudge peak_keep + structure start bands.',
      genome_delta: {
        peak_keep: Math.min(0.82, g.peak_keep + 0.02),
        require_1m_trigger: true,
        last_lesson: 'Keep nudge after scratches',
      },
      patches: [
        genomePatch('peak_keep', Math.min(0.82, g.peak_keep + 0.02), 'Keep nudge'),
        genomePatch('require_1m_trigger', true, '1m trigger'),
        ...codePatchesMicroScratch(1),
      ],
    },
  ];
}

function softLossVariants(g: BrainGenome, softL: number): Variant[] {
  const pause1 = Math.min(8, g.soft_same_side_pause_closes + 1);
  const keep = Math.min(0.85, g.peak_keep + 0.03);
  const gb = Math.min(0.82, g.soft_plus_giveback + 0.03);
  const arm = Math.max(0.5, Number((g.peak_arm_soft_mult - 0.05).toFixed(2)));
  return [
    {
      title: 'Cut Soft HardInv chain — pause + 1m trigger',
      rationale: `Soft HardInv×${softL} — tighten entry gates.`,
      task: 'require_1m_trigger + wait_on_1m_fight + Soft same-side pause.',
      genome_delta: {
        require_1m_trigger: true,
        wait_on_1m_fight: true,
        soft_same_side_pause_closes: pause1,
        soft_same_side_pause_min: Math.max(2, g.soft_same_side_pause_min),
        last_lesson: 'Soft HardInv pause',
      },
      patches: [
        genomePatch('require_1m_trigger', true, '1m trigger'),
        genomePatch('wait_on_1m_fight', true, 'WAIT on 1m fight'),
        genomePatch('soft_same_side_pause_closes', pause1, 'Soft pause longer'),
        ...codePatchesSoftSpam(0),
      ],
    },
    {
      title: 'Bank survivors earlier after Soft losses',
      rationale: `Soft×${softL} — survivors must Keep sooner.`,
      task: 'Raise peak_keep + soft_plus_giveback; Mind code bank Soft+.',
      genome_delta: {
        peak_keep: keep,
        soft_plus_giveback: gb,
        peak_arm_soft_mult: arm,
        mind_bank_on_turn: true,
        last_lesson: 'Bank after Soft losses',
      },
      patches: [
        genomePatch('peak_keep', keep, 'tighter Keep'),
        genomePatch('soft_plus_giveback', gb, 'earlier Soft+ bank'),
        genomePatch('peak_arm_soft_mult', arm, 'earlier Peak arm'),
        ...codePatchesBankGreen(),
      ],
    },
    {
      title: 'Harder Soft pause min after Soft chain',
      rationale: `Soft×${softL}`,
      task: 'Raise soft_same_side_pause_min + flipFilter Soft lock.',
      genome_delta: {
        soft_same_side_pause_min: Math.min(6, g.soft_same_side_pause_min + 1),
        soft_same_side_pause_closes: Math.min(8, g.soft_same_side_pause_closes + 2),
        last_lesson: 'Harder Soft pause min',
      },
      patches: [
        genomePatch(
          'soft_same_side_pause_min',
          Math.min(6, g.soft_same_side_pause_min + 1),
          'pause arms sooner'
        ),
        genomePatch(
          'soft_same_side_pause_closes',
          Math.min(8, g.soft_same_side_pause_closes + 2),
          'pause lasts longer'
        ),
        ...codePatchesSoftSpam(1),
      ],
    },
  ];
}

function genericVariants(g: BrainGenome, label: string): Variant[] {
  const nextKeep = Math.min(0.82, g.peak_keep + 0.02);
  const nextGb = Math.min(0.8, g.soft_plus_giveback + 0.02);
  const nextKeep2 = Math.min(0.85, g.peak_keep + 0.04);
  const arm = Math.max(0.5, Number((g.peak_arm_soft_mult - 0.05).toFixed(2)));
  return [
    {
      title: `Generic improve: ${label}`,
      rationale: label,
      task: 'Slightly tighten Peak Keep and Soft+ giveback — safe default evolve.',
      genome_delta: { peak_keep: nextKeep, soft_plus_giveback: nextGb, last_lesson: label },
      patches: [
        genomePatch('peak_keep', nextKeep, 'default Keep nudge'),
        genomePatch('soft_plus_giveback', nextGb, 'default giveback nudge'),
      ],
    },
    {
      title: `Generic Peak arm: ${label}`,
      rationale: label,
      task: 'Lower peak_arm_soft_mult + Keep push.',
      genome_delta: {
        peak_arm_soft_mult: arm,
        peak_keep: nextKeep2,
        last_lesson: `Peak arm · ${label}`,
      },
      patches: [
        genomePatch('peak_arm_soft_mult', arm, 'arm Peak earlier'),
        genomePatch('peak_keep', nextKeep2, 'Keep push'),
      ],
    },
  ];
}

/** Bounce a numeric knob inside [lo,hi] — never stuck at a wall. */
function bounceNum(cur: number, step: number, lo: number, hi: number, dir: 1 | -1): number {
  let next = Number((cur + dir * step).toFixed(2));
  if (next > hi) next = Number((cur - step).toFixed(2));
  if (next < lo) next = Number((cur + step).toFixed(2));
  if (next === cur) {
    // Force a distinct value inside the range
    next = Number((lo + ((cur - lo + step) % Math.max(0.01, hi - lo))).toFixed(2));
    if (next === cur) next = cur >= (lo + hi) / 2 ? lo : hi;
  }
  return Math.min(hi, Math.max(lo, next));
}

/** Bounce regime body/trek bp knobs — step ≥ 0.1, one decimal (no 0.00008 dust). */
function bounceBp(cur: number, step: number, lo: number, hi: number, dir: 1 | -1): number {
  const s = Math.max(0.1, step);
  return bounceNum(cur, s, Math.max(0.1, lo), hi, dir);
}

function bounceInt(cur: number, step: number, lo: number, hi: number, dir: 1 | -1): number {
  let next = cur + dir * step;
  if (next > hi) next = cur - step;
  if (next < lo) next = cur + step;
  if (next === cur) next = cur === hi ? lo : hi;
  return Math.min(hi, Math.max(lo, next));
}

const EXIT_FAMILIES = [
  'trend',
  'pullback',
  'break',
  'break_fail',
  'fade',
  'expansion',
  'reversal',
  'chop',
] as const;

/** Literal exit-family keys for audit coverage — bounced via exitFamilyKey() in explore. */
const _EXIT_FAMILY_AUDIT_KEYS = [
  'exit_trend_hardinv_mult',
  'exit_pullback_hardinv_mult',
  'exit_break_hardinv_mult',
  'exit_break_fail_hardinv_mult',
  'exit_fade_hardinv_mult',
  'exit_expansion_hardinv_mult',
  'exit_reversal_hardinv_mult',
  'exit_chop_hardinv_mult',
  'exit_trend_peak_arm',
  'exit_pullback_peak_arm',
  'exit_break_peak_arm',
  'exit_break_fail_peak_arm',
  'exit_fade_peak_arm',
  'exit_expansion_peak_arm',
  'exit_reversal_peak_arm',
  'exit_chop_peak_arm',
  'exit_trend_peak_mfe_mult',
  'exit_pullback_peak_mfe_mult',
  'exit_break_peak_mfe_mult',
  'exit_break_fail_peak_mfe_mult',
  'exit_fade_peak_mfe_mult',
  'exit_expansion_peak_mfe_mult',
  'exit_reversal_peak_mfe_mult',
  'exit_chop_peak_mfe_mult',
  'exit_trend_peak_giveback_mult',
  'exit_pullback_peak_giveback_mult',
  'exit_break_peak_giveback_mult',
  'exit_break_fail_peak_giveback_mult',
  'exit_fade_peak_giveback_mult',
  'exit_expansion_peak_giveback_mult',
  'exit_reversal_peak_giveback_mult',
  'exit_chop_peak_giveback_mult',
  'exit_trend_peak_retention',
  'exit_pullback_peak_retention',
  'exit_break_peak_retention',
  'exit_break_fail_peak_retention',
  'exit_fade_peak_retention',
  'exit_expansion_peak_retention',
  'exit_reversal_peak_retention',
  'exit_chop_peak_retention',
  'exit_pullback_target_mult',
  'exit_fade_target_mult',
  'exit_chop_target_mult',
  'exit_break_target_mult',
  'exit_break_fail_target_mult',
  'exit_expansion_target_mult',
  'exit_reversal_target_mult',
  'exit_trend_timedecay_hold_ms',
  'exit_pullback_timedecay_hold_ms',
  'exit_fade_timedecay_hold_ms',
  'exit_chop_timedecay_hold_ms',
  'exit_break_timedecay_hold_ms',
  'exit_break_fail_timedecay_hold_ms',
  'exit_expansion_timedecay_hold_ms',
  'exit_reversal_timedecay_hold_ms',
  'exit_trend_timedecay_min_fav_mult',
  'exit_pullback_timedecay_min_fav_mult',
  'exit_fade_timedecay_min_fav_mult',
  'exit_chop_timedecay_min_fav_mult',
  'exit_break_timedecay_min_fav_mult',
  'exit_break_fail_timedecay_min_fav_mult',
  'exit_expansion_timedecay_min_fav_mult',
  'exit_reversal_timedecay_min_fav_mult',
  'exit_trend_structure',
  'exit_pullback_structure',
  'exit_fade_structure',
  'exit_chop_structure',
  'exit_break_structure',
  'exit_break_fail_structure',
  'exit_expansion_structure',
  'exit_reversal_structure',
] as const;
void _EXIT_FAMILY_AUDIT_KEYS;

type ExitFamily = (typeof EXIT_FAMILIES)[number];

const PEAK_ARM_CYCLE: GenomePeakArmMode[] = ['reverse_1m', 'reverse_or_mid', 'fast'];
const STRUCTURE_CYCLE: GenomeStructureInvalidation[] = [
  'none',
  'back_in_range',
  'through_mid',
  'failed_edge_reclaim',
];

function cycleEnum<T>(cur: T, options: readonly T[]): T {
  const idx = options.indexOf(cur);
  return options[(idx + 1) % options.length]!;
}

function toggleInArray(arr: string[], item: string): string[] {
  const s = new Set(arr);
  if (s.has(item)) s.delete(item);
  else s.add(item);
  return [...s].sort();
}

function genomeArrayPatch(
  findKey: keyof BrainGenome,
  nextVal: string[],
  note: string
): BrainPatch | null {
  const g = getBrainGenome();
  const cur = g[findKey] as string[];
  if (JSON.stringify(cur) === JSON.stringify(nextVal)) return null;
  const curJson = JSON.stringify(cur);
  const nextJson = JSON.stringify(nextVal);
  return {
    path: 'data/brain-self-improve/genome.json',
    find: `"${findKey}": ${curJson}`,
    replace: `"${findKey}": ${nextJson}`,
    note,
  };
}

function exitFamilyKey(family: ExitFamily, suffix: string): keyof BrainGenome {
  return `exit_${family}_${suffix}` as keyof BrainGenome;
}

/**
 * Explore when pattern variants exhausted.
 * Always bumps explore_step so signature is unique and tryVariant never no-ops.
 * Groups rotate so Soft layers / Peak-safety / structure / trek / mind / exit
 * are not starved by peak_keep-only explores.
 */
function exploreVariants(g: BrainGenome, rejectedN: number): Variant[] {
  const step = 0.02 + (rejectedN % 3) * 0.01;
  const dir: 1 | -1 = rejectedN % 2 === 0 ? 1 : -1;
  const nextStep = (g.explore_step || 0) + 1;
  const keep = bounceNum(g.peak_keep, step, 0.1, 0.95, dir);
  const gb = bounceNum(g.soft_plus_giveback, step, 0.55, 0.85, dir);
  const arm = bounceNum(g.peak_arm_soft_mult, step, 0.5, 2.0, dir === 1 ? -1 : 1);
  const trailCap = bounceNum(g.peak_trail_soft_cap_mult, 0.05, 1.2, 2.5, dir);
  const storyFightArm = bounceNum(g.story_fight_peak_arm_soft_mult, 0.05, 0.5, 1.35, dir);
  const runner = bounceNum(g.soft_plus_runner_mult, 0.05, 1.1, 2.5, dir);
  const leg = bounceNum(g.soft_plus_leg_mult, 0.05, 1.0, 2.0, dir);
  const unlock = bounceNum(g.soft_layer_unlock_mult, 0.05, 0.5, 1.5, dir);
  const pbArm = bounceNum(g.pullback_episode_peak_arm_soft_mult, 0.05, 0.5, 1.35, dir);
  const pbMin = bounceNum(g.pullback_episode_min_mfe_soft_mult, 0.05, 0.25, 1.0, dir);
  const pause = bounceInt(g.soft_same_side_pause_closes, 1, 1, 12, dir);
  const pauseMin = bounceInt(g.soft_same_side_pause_min, 1, 1, 6, dir);
  const flipWait = !g.wait_on_1m_fight;
  const flipTrig = !g.require_1m_trigger;
  // Soft / Target abs — 0.1 grid
  const softL3 = bounceNum(g.soft_l3_abs, 0.1, 1.0, 8.0, dir);
  const softL1 = bounceNum(Math.min(g.soft_l1_abs, softL3 - 0.4), 0.1, 0.5, softL3 - 0.3, dir);
  const softL2 = bounceNum(
    Math.min(Math.max(g.soft_l2_abs, softL1), softL3),
    0.1,
    softL1,
    softL3,
    dir
  );
  const tgtL3 = bounceNum(g.target_l3_abs, 0.1, Math.max(2.0, softL3 * 1.2), 12.0, dir);
  const tgtL1 = bounceNum(Math.min(g.target_l1_abs, tgtL3 - 0.5), 0.1, 1.0, tgtL3 - 0.4, dir);
  const tgtL2 = bounceNum(
    Math.min(Math.max(g.target_l2_abs, tgtL1), tgtL3),
    0.1,
    tgtL1,
    tgtL3,
    dir
  );
  const peakMfe = bounceNum(g.peak_mfe_abs, 0.1, 1.0, 8.0, dir);
  const safetyRr = bounceNum(g.safety_tp_rr, 0.1, 1.5, 3.0, dir);
  const safetyCushion = bounceBp(g.safety_sl_cushion_bp, 1.0, 5.0, 50.0, dir);
  const peakRet = bounceNum(g.peak_retention, step, 0.1, 0.95, dir);
  // Structure bands
  const extHi = bounceNum(g.struct_extreme_hi, 0.02, 0.7, 0.95, dir);
  const extLo = bounceNum(g.struct_extreme_lo, 0.02, 0.05, 0.3, dir === 1 ? -1 : 1);
  const startLo = bounceNum(g.struct_start_lo, 0.02, 0.5, 0.85, dir);
  const startHi = bounceNum(g.struct_start_hi, 0.02, 0.15, 0.5, dir === 1 ? -1 : 1);
  // Regime trek + body
  const trekShareMin = bounceNum(g.trek_share_min, 0.05, 0.1, 0.7, dir);
  const trekEffMin = bounceNum(g.trek_eff_min, 0.05, 0.15, 0.8, dir);
  const rev = bounceBp(g.regime_reversal, 1.0, 8.0, 40.0, dir);
  const trendEnter = bounceBp(g.regime_trend_enter, 0.4, 2.0, 8.0, dir);
  const trendStay = bounceBp(g.regime_trend_stay, 0.2, 1.0, 5.0, dir);
  const move = bounceBp(g.regime_move, 0.1, 0.4, 2.0, dir);
  const moveRange = bounceBp(g.regime_move_range, 0.1, 0.6, 4.0, dir);
  const persistEnter = bounceNum(g.regime_persist_enter, 0.05, 0.25, 0.85, dir);
  const persistStay = bounceNum(g.regime_persist_stay, 0.05, 0.1, 0.7, dir);
  const persistPull = bounceNum(g.regime_persist_pullback, 0.05, 0.1, 0.6, dir);
  const rangePersist = bounceNum(g.regime_range_chop_persist_max, 0.1, 0.1, 0.55, dir);
  const rangeShare = bounceNum(g.regime_range_trek_share_max, 0.1, 0.12, 0.55, dir);
  const rangeEff = bounceNum(g.regime_range_trek_eff_max, 0.1, 0.15, 0.7, dir);
  const pullback = bounceBp(g.regime_pullback, 0.5, 3.0, 12.0, dir);
  const expandAbs = bounceBp(g.regime_expand_abs, 0.5, 3.0, 20.0, dir);
  const compressAbs = bounceBp(g.regime_compress_abs, 0.1, 0.2, 1.2, dir);
  const compressMult = bounceNum(g.regime_compress_avg_mult, 0.05, 0.15, 0.7, dir);
  const expandMult = bounceNum(g.regime_expand_avg_mult, 0.1, 1.2, 2.5, dir);
  const nearMid = bounceNum(g.regime_near_zone_mid, 0.1, 0.12, 0.45, dir);
  const clearBreak = bounceNum(g.regime_clear_break_frac, 0.1, 0.1, 0.5, dir);
  const dwell = bounceInt(g.regime_min_dwell_bars, 1, 2, 12, dir);
  const confirm = bounceInt(g.regime_confirm_bars, 1, 1, 8, dir);
  const momBars = bounceInt(g.regime_mom_bars, 1, 4, 16, dir);
  const persistWin = bounceInt(g.regime_persist_window, 1, 3, 12, dir);
  const trekFlat = bounceBp(g.mtf_trek_flat_frac, 0.5, 1.5, 12.0, dir);
  const flipBlockHf = !g.mtf_block_higher_fight;
  const flipAligned = !g.mtf_require_aligned_side;
  const flipHtfVeto = !g.mtf_htf_veto;
  const storyMin = bounceNum(g.entry_story_conf_min, 0.05, 0.4, 0.8, dir);
  const chopMax = bounceNum(
    Math.min(g.entry_chop_conf_max, storyMin - 0.05),
    0.02,
    0.25,
    Math.max(0.26, storyMin - 0.05),
    dir
  );
  // Mind cut / flip lock / grace
  const mindCutSoft = bounceNum(g.mind_cut_soft_mult, 0.05, 0.4, 1.2, dir);
  const mindCutRet = bounceNum(g.mind_cut_retention, 0.05, 0.3, 0.85, dir);
  const strongConf = bounceNum(g.strong_conf_min, 0.05, 0.4, 0.95, dir);
  const flipLock = bounceInt(g.same_dir_lock_ms, 15_000, 30_000, 300_000, dir);
  const flipLockLoss = bounceInt(g.same_dir_lock_after_loss_ms, 15_000, 30_000, 300_000, dir);
  const hardinvGrace = bounceInt(g.hardinv_grace_ms, 2_000, 0, 60_000, dir);
  // Exit profile samples
  const exitTrendTgt = bounceNum(g.exit_trend_target_mult, 0.05, 0.5, 2.0, dir);
  const exitFadeHard = bounceNum(g.exit_fade_hardinv_mult, 0.05, 0.5, 1.5, dir);
  // Soft/Target fallback + layer percentiles
  const softL1Fb = bounceNum(g.soft_l1_fallback_frac, 0.05, 0.2, 0.95, dir);
  const softL2Fb = bounceNum(g.soft_l2_fallback_frac, 0.05, 0.3, 0.99, dir);
  const tgtL1Fb = bounceNum(g.target_l1_fallback_frac, 0.05, 0.2, 0.95, dir);
  const tgtL2Fb = bounceNum(g.target_l2_fallback_frac, 0.05, 0.3, 0.99, dir);
  const stretchGate = bounceNum(g.target_stretch_gate, 0.05, 0.5, 1.0, dir);
  const layerP35 = bounceNum(g.layer_suggest_p35, 0.05, 0.1, 0.5, dir);
  const layerP60 = bounceNum(g.layer_suggest_p60, 0.05, 0.4, 0.8, dir);
  const layerP85 = bounceNum(g.layer_suggest_p85, 0.05, 0.6, 0.99, dir);
  const tgtL3MinSoft = bounceNum(g.target_l3_min_vs_soft, 0.05, 1.0, 2.0, dir);
  const unlockFloor = bounceNum(g.soft_layer_unlock_floor, 0.05, 0.25, 1.5, dir);
  const peakMfeRetFb = bounceNum(g.peak_mfe_retention_fallback, 0.05, 0.1, 0.95, dir);
  const hardinvPctBp = bounceBp(g.hardinv_pct_bp, 0.5, 4.0, 20.0, dir);
  const peakMfePctBp = bounceBp(g.peak_mfe_pct_bp, 0.5, 5.0, 25.0, dir);
  const peakMinGb = bounceNum(g.peak_min_giveback_abs, 0.1, 0.3, 3.0, dir);
  const tgtPctBp = bounceBp(g.target_pct_bp, 0.5, 10.0, 50.0, dir);
  const entryFilter = bounceInt(g.entry_filter_level, 1, 0, 3, dir);
  // Exit floors/caps
  const maxMfeGb = bounceNum(g.max_mfe_giveback, 0.05, 0.1, 0.7, dir);
  const hardinvFloor = bounceNum(g.hardinv_abs_floor, 0.1, 0.2, 20.0, dir);
  const hardinvCap = bounceNum(g.hardinv_abs_cap, 0.1, 0.5, 20.0, dir);
  const peakMfeFloor = bounceNum(g.peak_mfe_abs_floor, 0.1, 0.5, 20.0, dir);
  const tgtAbsFloor = bounceNum(g.target_abs_floor, 0.1, 1.0, 20.0, dir);
  const safetyTpMinRr = bounceNum(g.safety_tp_min_rr, 0.1, 1.0, 3.0, dir);
  const layeredCap = bounceNum(g.layered_soft_post_mult_cap, 0.05, 1.0, 2.0, dir);
  const minProfitBank = bounceNum(g.min_profit_bank_soft_mult, 0.05, 0.5, 2.0, dir);
  const deskRefMid = bounceInt(g.desk_ref_mid, 50, 500, 5000, dir);
  const safetyTpVsStop = bounceNum(g.safety_tp_vs_min_stop_mult, 0.05, 1.0, 1.5, dir);
  // Exit timings
  const hardinvConfirm = bounceInt(g.hardinv_confirm_ms, 1000, 0, 30_000, dir);
  const structGrace = bounceInt(g.structure_grace_ms, 1000, 0, 60_000, dir);
  const structConfirm = bounceInt(g.structure_confirm_ms, 1000, 0, 30_000, dir);
  const tdMinHold = bounceInt(g.timedecay_min_hold_ms, 30_000, 60_000, 1_800_000, dir);
  const tdMinFav = bounceNum(g.timedecay_min_fav_abs, 0.1, 0.5, 10.0, dir);
  const tdFavPctBp = bounceBp(g.timedecay_fav_pct_bp, 0.1, 1.0, 10.0, dir);
  // Exit family rotate (rejectedN % 8)
  const exitFam = EXIT_FAMILIES[rejectedN % EXIT_FAMILIES.length]!;
  const famHardinv = bounceNum(
    g[exitFamilyKey(exitFam, 'hardinv_mult')] as number,
    0.05,
    0.5,
    1.5,
    dir
  );
  const famTarget = bounceNum(
    g[exitFamilyKey(exitFam, 'target_mult')] as number,
    0.05,
    0.5,
    2.0,
    dir
  );
  const famPeakArm = cycleEnum(
    g[exitFamilyKey(exitFam, 'peak_arm')] as GenomePeakArmMode,
    PEAK_ARM_CYCLE
  );
  const famPeakMfe = bounceNum(
    g[exitFamilyKey(exitFam, 'peak_mfe_mult')] as number,
    0.05,
    0.5,
    2.0,
    dir
  );
  const famPeakGb = bounceNum(
    g[exitFamilyKey(exitFam, 'peak_giveback_mult')] as number,
    0.05,
    0.5,
    2.0,
    dir
  );
  const famPeakRet = bounceNum(
    g[exitFamilyKey(exitFam, 'peak_retention')] as number,
    0.05,
    0.0,
    0.95,
    dir
  );
  const famTdHold = bounceInt(
    g[exitFamilyKey(exitFam, 'timedecay_hold_ms')] as number,
    30_000,
    60_000,
    1_800_000,
    dir
  );
  const famTdFav = bounceNum(
    g[exitFamilyKey(exitFam, 'timedecay_min_fav_mult')] as number,
    0.05,
    0.5,
    1.5,
    dir
  );
  const famStruct = cycleEnum(
    g[exitFamilyKey(exitFam, 'structure')] as GenomeStructureInvalidation,
    STRUCTURE_CYCLE
  );
  const exitMidSlack = bounceNum(g.exit_range_through_mid_slack, 0.02, 0.01, 0.2, dir);
  const beLockFrac = bounceNum(g.be_lock_frac, 0.05, 0.1, 0.95, dir);
  const beLockExec = bounceNum(g.be_lock_exec_frac, 0.05, 0.1, 0.95, dir);
  const flipSoftExit1m = !g.soft_exit_require_1m_change;
  const flipSoftExitBlock = !g.soft_exit_block_same_next_entry;
  const flipExitLossHard = !g.exit_loss_include_hardinv;
  const flipExitLossBe = !g.exit_loss_exclude_be_lock;
  // Structure extended
  const halfLo = bounceNum(g.struct_half_lo, 0.02, 0.3, 0.7, dir);
  const halfHi = bounceNum(g.struct_half_hi, 0.02, 0.3, 0.7, dir);
  const zbLo = bounceNum(g.zone_band_cut_lo, 0.02, 0.05, 0.4, dir);
  const zbMidLo = bounceNum(g.zone_band_cut_mid_lo, 0.02, 0.2, 0.55, dir);
  const zbMidHi = bounceNum(g.zone_band_cut_mid_hi, 0.02, 0.45, 0.75, dir);
  const zbHi = bounceNum(g.zone_band_cut_hi, 0.02, 0.6, 0.95, dir);
  const m1AggBars = bounceInt(g.m1_aggregate_min_bars, 1, 1, 8, dir);
  const mtbLookback = bounceInt(g.minute_trend_bias_lookback, 1, 2, 12, dir);
  const mtbPathBp = bounceBp(g.minute_trend_bias_trek_min_path_bp, 0.5, 3.0, 20.0, dir);
  const pierceHi = bounceNum(g.breakout_pierce_pos_hi, 0.02, 0.8, 0.99, dir);
  const pierceLo = bounceNum(g.breakout_pierce_pos_lo, 0.02, 0.01, 0.2, dir === 1 ? -1 : 1);
  const reclaimLo = bounceNum(g.failed_break_reclaim_pos_lo, 0.02, 0.05, 0.45, dir);
  const reclaimHi = bounceNum(g.failed_break_reclaim_pos_hi, 0.02, 0.55, 0.95, dir);
  const compressLo = bounceNum(g.compression_entry_pos_lo, 0.02, 0.2, 0.5, dir);
  const compressHi = bounceNum(g.compression_entry_pos_hi, 0.02, 0.5, 0.8, dir);
  const flipExhaustTip = !g.exhaust_tip_chase_block;
  const flipPostImpulseTip = !g.entry_block_post_impulse_tip;
  const postImpulseShare = bounceNum(g.entry_post_impulse_share_min, 0.02, 0.1, 0.45, dir);
  const postImpulseMinBars = bounceInt(g.entry_post_impulse_min_bars, 2, 6, 40, dir);
  const postImpulseZoneBars = bounceInt(g.entry_post_impulse_zone_bars, 10, 60, 360, dir);
  const postImpulseExempt = toggleInArray(g.entry_post_impulse_exempt_lanes, 'LIVE');
  const flipTipChaseTrend = !g.entry_tip_chase_trend_pullback;
  const flipTipFinished = !g.entry_tip_block_finished_move;
  const flipTrendTipReject = !g.entry_trend_tip_require_reject;
  const flipPeakKeepOwns = !g.peak_keep_genome_owns;
  const manageDeepGreen = bounceNum(g.manage_path_deep_green_soft_mult, 0.05, 0.5, 1.2, dir);
  const manageFadeScore = bounceNum(g.manage_path_fade_score, 0.05, 0.1, 2.0, dir);
  const manageStoryFight = bounceNum(g.manage_score_story_fight, 0.05, 0.1, 2.0, dir);
  const manageNearTarget = bounceNum(g.manage_score_near_target, 0.05, 0.05, 1.5, dir);
  const manageLearnerMin = bounceInt(g.manage_learner_min_updates, 2, 5, 80, dir);
  const mindConfBank = bounceNum(g.mind_manage_conf_bank, 0.02, 0.5, 0.99, dir);
  const mindConfCut = bounceNum(g.mind_manage_conf_cut, 0.02, 0.4, 0.99, dir);
  const mindConfTrail = bounceNum(g.mind_manage_conf_trail, 0.02, 0.3, 0.95, dir);
  const mindDeepGreen = bounceNum(g.mind_deep_green_soft_mult, 0.05, 0.5, 1.2, dir);
  const tdTargetFrac = bounceNum(g.timedecay_target_frac, 0.05, 0.1, 0.9, dir);
  const peakTrailMinBank = bounceNum(g.peak_trail_minbank_frac, 0.05, 0.2, 1.0, dir);
  const scalpWick = bounceNum(g.scalp_wick_frac, 0.05, 0.2, 0.8, dir);
  const scalpWickBody = bounceNum(g.scalp_wick_body_frac, 0.02, 0.05, 0.4, dir);
  const localLbMax = bounceInt(g.local_breakout_lookback_max, 5, 20, 120, dir);
  const localLbMin = bounceInt(g.local_breakout_lookback_min, 2, 8, 60, dir);
  const localSkip = bounceInt(g.local_breakout_skip_bars, 1, 2, 20, dir);
  const localMinStruct = bounceInt(g.local_breakout_min_struct_bars, 2, 6, 40, dir);
  const localClearMult = bounceNum(g.local_breakout_clear_frac_mult, 0.05, 0.2, 1.0, dir);
  const regimeConfDiv = bounceInt(g.regime_conf_move_div, 1, 2, 10, dir);
  const entryM1Strong = bounceNum(g.entry_m1_strong_move_mult, 0.05, 0.2, 1.0, dir);
  const trekAbsPts = bounceNum(g.trek_min_path_abs_pts, 0.5, 0.5, 20, dir);
  const safetySpreadBp = bounceBp(g.safety_spread_fallback_bp, 0.1, 0.1, 20, dir);
  const safetyTinyBp = bounceBp(g.safety_abs_floor_tiny_bp, 0.5, 0.1, 50, dir);
  const safetyNanoBp = bounceBp(g.safety_abs_floor_nano_bp, 0.1, 0.1, 20, dir);
  const runnerBadFrac = bounceNum(g.regime_runner_bad_retain_frac, 0.05, 0.2, 0.9, dir);
  const autoCalEvery = bounceInt(g.auto_calibrate_every_n, 1, 2, 20, dir);
  const autoCalMinHardBp = bounceBp(g.auto_cal_min_hardinv_pct_bp, 0.5, 0.1, 50, dir);
  const autoCalMaxHardBp = bounceBp(g.auto_cal_max_hardinv_pct_bp, 2, 1, 200, dir);
  const autoCalMinTgtBp = bounceBp(g.auto_cal_min_target_pct_bp, 1, 0.1, 100, dir);
  const autoCalMaxTgtBp = bounceBp(g.auto_cal_max_target_pct_bp, 5, 10, 500, dir);
  const autoCalMinPeakBp = bounceBp(g.auto_cal_min_peak_mfe_pct_bp, 0.5, 0.1, 50, dir);
  const autoCalMaxPeakBp = bounceBp(g.auto_cal_max_peak_mfe_pct_bp, 2, 1, 200, dir);
  const entryConfAligned = bounceNum(g.mind_entry_conf_aligned, 0.02, 0.5, 0.99, dir);
  const entryConfStrong = bounceNum(g.mind_entry_conf_aligned_strong, 0.02, 0.5, 0.99, dir);
  const entryConfM1 = bounceNum(g.mind_entry_conf_strong_m1, 0.02, 0.5, 0.99, dir);
  const entryConfBias = bounceNum(g.mind_entry_conf_bias, 0.02, 0.4, 0.95, dir);
  const entryConfWeak = bounceNum(g.mind_entry_conf_weak, 0.02, 0.3, 0.9, dir);
  const entryConfBoost = bounceNum(g.mind_entry_conf_regime_boost, 0.01, 0.02, 0.2, dir);
  const entryConfCap = bounceNum(g.mind_entry_conf_cap, 0.01, 0.7, 0.99, dir);
  const entryLearnerMin = bounceInt(g.entry_learner_min_updates, 2, 5, 80, dir);
  const postImpulseLateEff = bounceNum(g.entry_post_impulse_late_eff_min, 0.05, 0.1, 0.9, dir);
  const entryConfRegimeHyp = bounceNum(g.mind_entry_conf_regime_hyp, 0.02, 0.3, 0.9, dir);
  const entryConfPbWait = bounceNum(g.mind_entry_conf_pb_wait, 0.02, 0.2, 0.8, dir);
  const entryConfPbResume = bounceNum(g.mind_entry_conf_pb_resume_floor, 0.02, 0.4, 0.95, dir);
  const entryConfStorySide = bounceNum(g.mind_entry_conf_story_side_floor, 0.02, 0.4, 0.95, dir);
  const entryConfFlipLoss = bounceNum(g.mind_entry_conf_flip_after_loss, 0.02, 0.4, 0.95, dir);
  const entryConfChopWait = bounceNum(g.mind_entry_conf_chop_wait, 0.02, 0.15, 0.7, dir);
  const entryConfMixedWait = bounceNum(g.mind_entry_conf_mixed_wait, 0.02, 0.15, 0.7, dir);
  const entryConfHardVeto = bounceNum(g.mind_entry_conf_hard_veto, 0.02, 0.1, 0.6, dir);
  const entryConfStackFight = bounceNum(g.mind_entry_conf_stack_fight, 0.02, 0.3, 0.9, dir);
  const entryConfStackChapter = bounceNum(g.mind_entry_conf_stack_chapter_wait, 0.02, 0.25, 0.85, dir);
  const acMicroWin = bounceNum(g.auto_cal_micro_win_vs_loss, 0.05, 0.2, 0.9, dir);
  const acHighMfe = bounceNum(g.auto_cal_high_mfe_vs_loss, 0.05, 0.4, 1.5, dir);
  const acLeftWinnerE = bounceNum(g.auto_cal_left_winner_e_max, 0.05, -0.5, 1.0, dir);
  const acAsym = bounceNum(g.auto_cal_asym_win_vs_loss, 0.05, 0.5, 1.2, dir);
  const acSoftDomE = bounceNum(g.auto_cal_soft_dom_e_max, 0.02, -0.5, 0.5, dir);
  const acSoftDomWin = bounceNum(g.auto_cal_soft_dom_win_vs_loss, 0.05, 0.4, 1.2, dir);
  const acEaseFilterE = bounceNum(g.auto_cal_ease_filter_e_min, 0.05, 0.1, 1.5, dir);
  const acLegacyE = bounceNum(g.auto_cal_legacy_raise_e_max, 0.05, -0.2, 0.8, dir);
  const acLegacyWin = bounceNum(g.auto_cal_legacy_raise_win_vs_loss, 0.05, 0.5, 1.2, dir);
  const acSoftTightE = bounceNum(g.auto_cal_soft_tight_e_max, 0.05, -0.2, 0.8, dir);
  const acHealthyE = bounceNum(g.auto_cal_healthy_e_min, 0.05, 0.05, 1.5, dir);
  const acHealthyWin = bounceNum(g.auto_cal_healthy_win_vs_loss, 0.05, 0.5, 1.5, dir);
  const acTargetEase = bounceNum(g.auto_cal_target_ease_abs, 0.1, 0.2, 5, dir);
  const acTargetPctEase = bounceNum(g.auto_cal_target_pct_ease_div, 0.02, 1.01, 1.5, dir);
  const acPeakRaise = bounceNum(g.auto_cal_peak_raise_abs, 0.1, 0.1, 3, dir);
  const acTargetRaise = bounceNum(g.auto_cal_target_raise_abs, 0.1, 0.1, 5, dir);
  const acTargetPctRaise = bounceNum(g.auto_cal_target_pct_raise_mult, 0.01, 1.01, 1.3, dir);
  const acPeakPctRaise = bounceNum(g.auto_cal_peak_pct_raise_mult, 0.01, 1.01, 1.3, dir);
  const acGivebackRaise = bounceNum(g.auto_cal_giveback_raise_abs, 0.05, 0.05, 1, dir);
  const acHealthyKeep = bounceNum(g.auto_cal_healthy_keep_step, 0.005, 0.005, 0.1, dir);
  const acLetWinnersE = bounceNum(g.auto_cal_let_winners_e_min, 0.05, -0.5, 2.0, dir);
  const acChoppyCtx = bounceInt(g.auto_cal_choppy_ctx_min, 1, 1, 10, dir);
  const acChoppyE = bounceNum(g.auto_cal_choppy_e_max, 0.05, -0.5, 1.0, dir);
  const acNegAlign = bounceNum(g.auto_cal_neg_e_align_max, 0.05, -2.0, 0.5, dir);
  const acExpandCtx = bounceInt(g.auto_cal_expand_ctx_min, 1, 1, 10, dir);
  const acExpandE = bounceNum(g.auto_cal_expand_e_min, 0.05, -0.5, 2.0, dir);
  const acChoppyDwellE = bounceNum(g.auto_cal_choppy_dwell_e_max, 0.05, -1.0, 0.5, dir);
  const acFightCtx = bounceInt(g.auto_cal_fight_ctx_min, 1, 1, 10, dir);
  const acFightE = bounceNum(g.auto_cal_fight_e_max, 0.02, -0.5, 1.0, dir);
  const acSoftDomLossN = bounceInt(g.auto_cal_soft_dom_loss_count_min, 1, 1, 10, dir);
  const acSoftDomLossVs = bounceNum(g.auto_cal_soft_dom_loss_vs_hardinv, 0.05, 0.3, 1.5, dir);
  const acDemoteRecoverE = bounceNum(g.auto_cal_demote_recover_e_min, 0.05, -0.5, 1.5, dir);
  const acSoftLossAbsFloor = bounceNum(g.auto_cal_soft_loss_abs_floor, 0.1, 0.2, 8, dir);
  const acMicroWinAbsFloor = bounceNum(g.auto_cal_micro_win_abs_floor, 0.1, 0.2, 8, dir);
  const acPeakExitsMin = bounceInt(g.auto_cal_peak_exits_min, 1, 1, 10, dir);
  const acHighMfeTinyCountMin = bounceInt(g.auto_cal_high_mfe_tiny_count_min, 1, 1, 10, dir);
  const acMicroWinsMin = bounceInt(g.auto_cal_micro_wins_min, 1, 1, 10, dir);
  const acAvgLossAbsFloor = bounceNum(g.auto_cal_avg_loss_abs_floor, 0.1, 0.2, 8, dir);
  const acAlreadyTallSoftMult = bounceNum(g.auto_cal_already_tall_soft_mult, 0.1, 1.0, 5.0, dir);
  const acSoftTightSoftLossesMin = bounceInt(g.auto_cal_soft_tight_soft_losses_min, 1, 1, 10, dir);
  const acSoftTightHighMfeMin = bounceInt(g.auto_cal_soft_tight_high_mfe_min, 1, 1, 10, dir);
  const acSoftTightHardinvMax = bounceNum(g.auto_cal_soft_tight_hardinv_max, 0.1, 0.2, 8, dir);
  const acRegimePromoteNMin = bounceInt(g.auto_cal_regime_promote_n_min, 1, 1, 10, dir);
  const acRegimePromoteSumMin = bounceNum(g.auto_cal_regime_promote_sum_min, 0.05, 0.05, 5, dir);
  const acRegimeKeepNMax = bounceInt(g.auto_cal_regime_keep_n_max, 1, 1, 10, dir);
  const acRegimeKeepSumMin = bounceNum(g.auto_cal_regime_keep_sum_min, 0.05, -5, 1, dir);
  const acRegimeDemoteSumMax = bounceNum(g.auto_cal_regime_demote_sum_max, 0.1, -10, 0, dir);
  const acMutSoftPlusGivebackStep = bounceNum(g.auto_cal_mut_soft_plus_giveback_step, 0.01, 0.005, 0.3, dir);
  const acMutPeakArmStep = bounceNum(g.auto_cal_mut_peak_arm_step, 0.01, 0.005, 0.3, dir);
  const acMutSoftLayerUnlockStep = bounceNum(g.auto_cal_mut_soft_layer_unlock_step, 0.01, 0.005, 0.3, dir);
  const acMutPbEpisodeArmStep = bounceNum(g.auto_cal_mut_pb_episode_arm_step, 0.01, 0.005, 0.3, dir);
  const acMutPbEpisodeMfeStep = bounceNum(g.auto_cal_mut_pb_episode_mfe_step, 0.01, 0.005, 0.3, dir);
  const acMutSoftPlusRunnerStep = bounceNum(g.auto_cal_mut_soft_plus_runner_step, 0.01, 0.005, 0.3, dir);
  const acMutSoftPlusLegStep = bounceNum(g.auto_cal_mut_soft_plus_leg_step, 0.01, 0.005, 0.3, dir);
  const acMutSoftPlusGivebackMin = bounceNum(g.auto_cal_mut_soft_plus_giveback_min, 0.02, 0.3, 0.9, dir);
  const acMutSoftPlusGivebackMax = bounceNum(g.auto_cal_mut_soft_plus_giveback_max, 0.02, 0.5, 0.99, dir);
  const acMutPeakArmMin = bounceNum(g.auto_cal_mut_peak_arm_min, 0.05, 0.2, 1.5, dir);
  const acMutPeakArmMax = bounceNum(g.auto_cal_mut_peak_arm_max, 0.1, 0.8, 3, dir);
  const acMutSoftLayerUnlockMin = bounceNum(g.auto_cal_mut_soft_layer_unlock_min, 0.05, 0.2, 1.5, dir);
  const acMutSoftLayerUnlockMax = bounceNum(g.auto_cal_mut_soft_layer_unlock_max, 0.1, 0.8, 2.5, dir);
  const acMutPbEpisodeArmMin = bounceNum(g.auto_cal_mut_pb_episode_arm_min, 0.05, 0.2, 1.5, dir);
  const acMutPbEpisodeArmMax = bounceNum(g.auto_cal_mut_pb_episode_arm_max, 0.1, 0.8, 2.5, dir);
  const acMutPbEpisodeMfeMin = bounceNum(g.auto_cal_mut_pb_episode_mfe_min, 0.05, 0.1, 0.8, dir);
  const acMutPbEpisodeMfeMax = bounceNum(g.auto_cal_mut_pb_episode_mfe_max, 0.05, 0.5, 2, dir);
  const acMutSoftPlusRunnerMin = bounceNum(g.auto_cal_mut_soft_plus_runner_min, 0.1, 0.5, 1.5, dir);
  const acMutSoftPlusRunnerMax = bounceNum(g.auto_cal_mut_soft_plus_runner_max, 0.1, 1.0, 3, dir);
  const acMutSoftPlusLegMin = bounceNum(g.auto_cal_mut_soft_plus_leg_min, 0.1, 0.5, 1.5, dir);
  const acMutSoftPlusLegMax = bounceNum(g.auto_cal_mut_soft_plus_leg_max, 0.1, 1.0, 3, dir);
  const acRangeSoftMin = bounceInt(g.auto_cal_range_soft_min, 1, 1, 10, dir);
  const acRangeWinsMin = bounceInt(g.auto_cal_range_wins_min, 1, 1, 10, dir);
  const acPbSoftMin = bounceInt(g.auto_cal_pb_soft_min, 1, 1, 10, dir);
  const acMutRangeChopDown = bounceNum(g.auto_cal_mut_range_chop_down, 0.01, 0.005, 0.15, dir);
  const acMutRangeShareDown = bounceNum(g.auto_cal_mut_range_share_down, 0.01, 0.005, 0.15, dir);
  const acMutRangeEffDown = bounceNum(g.auto_cal_mut_range_eff_down, 0.01, 0.005, 0.15, dir);
  const acMutRangeChopUp = bounceNum(g.auto_cal_mut_range_chop_up, 0.01, 0.005, 0.15, dir);
  const acMutRangeChopMin = bounceNum(g.auto_cal_mut_range_chop_min, 0.02, 0.02, 0.4, dir);
  const acMutRangeChopMax = bounceNum(g.auto_cal_mut_range_chop_max, 0.02, 0.2, 0.9, dir);
  const acMutRangeShareMin = bounceNum(g.auto_cal_mut_range_share_min, 0.02, 0.02, 0.4, dir);
  const acMutRangeShareMax = bounceNum(g.auto_cal_mut_range_share_max, 0.02, 0.2, 0.9, dir);
  const acMutRangeEffMin = bounceNum(g.auto_cal_mut_range_eff_min, 0.02, 0.05, 0.5, dir);
  const acMutRangeEffMax = bounceNum(g.auto_cal_mut_range_eff_max, 0.02, 0.3, 0.95, dir);
  const acSameSidePauseMax = bounceInt(g.auto_cal_same_side_pause_max, 1, 2, 30, dir);
  const acSameSidePauseSoftMin = bounceInt(g.auto_cal_same_side_pause_soft_min, 1, 1, 10, dir);
  const acSameSidePauseStep = bounceInt(g.auto_cal_same_side_pause_step, 1, 1, 5, dir);
  const acChoppyGreenLo = bounceNum(g.auto_cal_choppy_green_lo, 0.05, 0.1, 0.5, dir);
  const acChoppyGreenHi = bounceNum(g.auto_cal_choppy_green_hi, 0.05, 0.5, 0.9, dir);
  const acMutTrekFlatMult = bounceNum(g.auto_cal_mut_trek_flat_mult, 0.02, 1.01, 1.5, dir);
  const acMutTrekFlatMin = bounceNum(g.auto_cal_mut_trek_flat_min, 0.5, 0.5, 8, dir);
  const acMutTrekFlatMax = bounceInt(g.auto_cal_mut_trek_flat_max, 1, 1, 10, dir);
  const acMutStoryConfStep = bounceNum(g.auto_cal_mut_story_conf_step, 0.01, 0.005, 0.3, dir);
  const acMutStoryConfMin = bounceNum(g.auto_cal_mut_story_conf_min, 0.02, 0.1, 0.99, dir);
  const acMutStoryConfMax = bounceNum(g.auto_cal_mut_story_conf_max, 0.02, 0.1, 0.99, dir);
  const acMutConfirmBarsMin = bounceInt(g.auto_cal_mut_confirm_bars_min, 1, 1, 20, dir);
  const acMutConfirmBarsMax = bounceInt(g.auto_cal_mut_confirm_bars_max, 1, 1, 20, dir);
  const acMutConfirmBarsStep = bounceInt(g.auto_cal_mut_confirm_bars_step, 1, 1, 20, dir);
  const acMutDwellBarsMin = bounceInt(g.auto_cal_mut_dwell_bars_min, 1, 1, 20, dir);
  const acMutDwellBarsMax = bounceInt(g.auto_cal_mut_dwell_bars_max, 1, 1, 20, dir);
  const acMutDwellBarsStep = bounceInt(g.auto_cal_mut_dwell_bars_step, 1, 1, 20, dir);
  const stRecentMins = bounceInt(g.story_recent_mins, 1, 1, 20, dir);
  const stRecentColorMin = bounceInt(g.story_recent_color_min, 1, 1, 10, dir);
  const stBounceGreenLo = bounceInt(g.story_bounce_green_lo, 1, 1, 10, dir);
  const stBounceGreenHi = bounceInt(g.story_bounce_green_hi, 1, 1, 10, dir);
  const stBounceRedMin = bounceInt(g.story_bounce_red_min, 1, 1, 10, dir);
  const stDipRedLo = bounceInt(g.story_dip_red_lo, 1, 1, 10, dir);
  const stDipRedHi = bounceInt(g.story_dip_red_hi, 1, 1, 10, dir);
  const stDipGreenMin = bounceInt(g.story_dip_green_min, 1, 1, 10, dir);
  const mtbTrendBiasWindowMin = bounceInt(g.minute_trend_bias_window_min, 1, 1, 20, dir);
  const mtbTrendBiasColorVotes = bounceInt(g.minute_trend_bias_color_votes, 1, 1, 20, dir);
  const mindPressureDelta = bounceInt(g.mind_pressure_delta, 1, 0, 5, dir);
  const mindSessionKnifeSoftMin = bounceInt(g.mind_session_knife_soft_min, 1, 1, 10, dir);
  const mindSessionSoftLossesMin = bounceInt(g.mind_session_soft_losses_min, 1, 1, 10, dir);
  const mindSessionSoftSizedMin = bounceInt(g.mind_session_soft_sized_min, 1, 1, 10, dir);
  const mindSessionSoftCapAbs = bounceNum(g.mind_session_soft_cap_abs, 0.1, 0.2, 8, dir);
  const manageFadeSoft = bounceNum(g.manage_path_fade_soft_mult, 0.02, 0.05, 0.5, dir);
  const manageStallMfe = bounceNum(g.manage_path_stall_mfe_soft_mult, 0.05, 0.1, 0.9, dir);
  const manageStallUpl = bounceNum(g.manage_path_stall_upl_soft_mult, 0.02, 0.05, 0.5, dir);
  const manageStallScore = bounceNum(g.manage_path_stall_score, 0.05, 0.05, 1.0, dir);
  const manageMaeMult = bounceNum(g.manage_mae_deep_soft_mult, 0.05, 0.5, 1.2, dir);
  const manageMaeScore = bounceNum(g.manage_mae_deep_score, 0.05, 0.1, 1.5, dir);
  const manageM1Wait = bounceNum(g.manage_score_m1_wait, 0.05, 0.05, 1.0, dir);
  const manageNextSame = bounceNum(g.manage_score_next_same, 0.05, 0.1, 1.5, dir);
  const manageThesisBonus = bounceNum(g.manage_score_thesis_bonus, 0.05, 0.05, 1.0, dir);
  const manageSoftGate = bounceNum(g.manage_score_soft_gate_open, 0.05, 0.05, 1.0, dir);
  const manageStoryWith = bounceNum(g.manage_score_story_with, 0.05, 0.05, 1.5, dir);
  const managePressureWith = bounceNum(g.manage_score_pressure_with, 0.05, 0.05, 1.5, dir);
  const manageExpandCont = bounceNum(g.manage_score_expand_continue, 0.05, 0.05, 1.5, dir);
  const manageExpandRev = bounceNum(g.manage_score_expand_reverse, 0.05, 0.05, 1.5, dir);
  const manageFeedDiv = bounceNum(g.manage_score_feed_divergent, 0.05, 0.05, 1.5, dir);
  const manageFeedStrong = bounceNum(g.manage_score_feed_strong, 0.05, 0.05, 1.0, dir);
  const manageChapter = bounceNum(g.manage_score_chapter_change, 0.05, 0.05, 1.5, dir);
  const mindConfHoldCont = bounceNum(g.mind_manage_conf_hold_continue, 0.02, 0.4, 0.99, dir);
  const mindConfHoldAgainst = bounceNum(g.mind_manage_conf_hold_against, 0.02, 0.3, 0.95, dir);
  const entryLearnerMargin = bounceNum(g.entry_learner_override_margin, 0.01, 0.02, 0.2, dir);
  // Story
  const storyPathBp = bounceBp(g.story_min_path_bp, 0.5, 3.0, 20.0, dir);
  const storyConfMin = bounceNum(g.story_conf_min, 0.05, 0.2, 0.8, dir);
  const chaseEdge = bounceNum(g.chase_edge, 0.02, 0.05, 0.3, dir);
  const trekFirm = bounceNum(g.trek_firm_mult, 0.1, 1.0, 3.0, dir);
  const storySellPos = bounceNum(g.story_sell_struct_pos, 0.02, 0.3, 0.55, dir);
  const storyBuyPos = bounceNum(g.story_buy_struct_pos, 0.02, 0.45, 0.7, dir);
  const bounceDipDelta = bounceInt(g.bounce_dip_color_delta, 1, 1, 5, dir);
  const exhaustLo = bounceNum(g.exhaust_pos_lo, 0.02, 0.05, 0.45, dir);
  const exhaustHi = bounceNum(g.exhaust_pos_hi, 0.02, 0.55, 0.95, dir);
  const scBreak = bounceNum(g.story_conf_break, 0.05, 0.5, 0.95, dir);
  const scBounce = bounceNum(g.story_conf_bounce_dip, 0.05, 0.5, 0.95, dir);
  const scStruct = bounceNum(g.story_conf_struct, 0.05, 0.5, 0.95, dir);
  const scRecent = bounceNum(g.story_conf_recent, 0.05, 0.4, 0.9, dir);
  const scChopThin = bounceNum(g.story_conf_chop_thin, 0.02, 0.2, 0.5, dir);
  const scChop = bounceNum(g.story_conf_chop, 0.02, 0.2, 0.55, dir);
  const flipScalpWick = !g.scalp_wick_confirm;
  // Market context
  const expandRange = bounceNum(g.expanding_range_mult, 0.05, 1.0, 2.0, dir);
  const compressRange = bounceNum(g.compressed_range_mult, 0.05, 0.3, 1.0, dir);
  const velLookback = bounceInt(g.velocity_lookback, 1, 4, 24, dir);
  const pressFightBuy = bounceNum(g.pressure_fight_green_buy, 0.02, 0.25, 0.5, dir);
  const pressFightSell = bounceNum(g.pressure_fight_green_sell, 0.02, 0.5, 0.75, dir);
  const spStoryExec = bounceNum(g.softplus_storyfight_exec_fav_mult, 0.05, 0.7, 1.2, dir);
  const spStoryMfe = bounceNum(g.softplus_storyfight_min_mfe_mult, 0.05, 0.5, 1.5, dir);
  const spPbStory = bounceNum(g.softplus_pullback_story_exec_mult, 0.05, 0.7, 1.2, dir);
  // Mind residuals
  const greenSoftArm = bounceNum(g.green_soft_arm_mult, 0.05, 0.5, 1.2, dir);
  const deepGbOff = bounceNum(g.deep_giveback_offset, 0.02, 0.05, 0.3, dir);
  const againstUsHi = bounceNum(g.against_us_soft_mult_hi, 0.05, 0.4, 1.0, dir);
  const againstUsLo = bounceNum(g.against_us_soft_mult_lo, 0.05, 0.3, 0.8, dir);
  const sessExpCut = bounceNum(g.session_expectancy_cut, 0.05, -1.0, 0.0, dir);
  const mindEntryBase = bounceNum(g.mind_entry_conf_base, 0.05, 0.3, 0.8, dir);
  const leftTinyMin = bounceNum(g.left_on_table_peak_tiny_min, 0.1, 0.5, 5.0, dir);
  const softSizedLoss = bounceNum(g.soft_sized_loss_frac, 0.05, 0.3, 0.9, dir);
  const sessEBankHi = bounceNum(g.session_e_bank_hi, 0.05, 0.1, 0.5, dir);
  const sessEBankLo = bounceNum(g.session_e_bank_lo, 0.05, -0.5, 0.0, dir);
  // ManageBrain
  const manageMinSample = bounceInt(g.manage_min_sample, 1, 1, 10, dir);
  const msSessNeg = bounceNum(g.manage_score_session_e_neg, 0.05, 0.3, 1.0, dir);
  const msSessPos = bounceNum(g.manage_score_session_e_pos, 0.05, 0.1, 0.7, dir);
  const msWinNeg = bounceNum(g.manage_score_window_e_neg, 0.05, 0.2, 0.9, dir);
  const msPathGreen = bounceNum(g.manage_score_path_soft_green, 0.05, 0.1, 0.5, dir);
  const msPathGb = bounceNum(g.manage_score_path_giveback, 0.05, 0.5, 1.2, dir);
  const msM1Rev = bounceNum(g.manage_score_m1_reverse, 0.05, 0.5, 1.2, dir);
  const msM1Cont = bounceNum(g.manage_score_m1_continue, 0.05, 0.5, 1.2, dir);
  const msNextOpp = bounceNum(g.manage_score_next_entry_opp, 0.05, 0.3, 1.0, dir);
  const msThesis = bounceNum(g.manage_score_thesis_fight, 0.05, 0.2, 0.9, dir);
  const pressWithBuy = bounceNum(g.pressure_with_us_buy, 0.02, 0.45, 0.7, dir);
  const pressWithSell = bounceNum(g.pressure_with_us_sell, 0.02, 0.3, 0.55, dir);
  const nearTgtBank = bounceNum(g.near_target_lean_bank, 0.05, 0.5, 1.0, dir);
  const msClamp = bounceNum(g.manage_score_clamp, 0.1, 1.0, 4.0, dir);
  const manageLearnerMargin = bounceNum(g.manage_learner_override_margin, 0.01, 0.02, 0.2, dir);
  const peakMfeEase = bounceNum(g.peak_mfe_floor_ease, 0.05, 0.5, 1.0, dir);
  // Strong/fade
  const strongHtfMin = bounceInt(g.strong_htf_aligned_min, 1, 1, 4, dir);
  const fadeChapters = toggleInArray(g.fade_allowed_chapters, 'EXHAUST_HI');
  // Regimes residual
  const zoneBars = bounceInt(g.zone_bars, 10, 60, 360, dir);
  const minZoneBars = bounceInt(g.min_bars_for_zone, 10, 30, 240, dir);
  const switchGap = bounceInt(g.switch_gap_bars, 1, 1, 8, dir);
  const localBreakFloor = bounceNum(g.local_breakout_frac_floor, 0.02, 0.05, 0.35, dir);
  const trekFullEnter = bounceBp(g.trek_full_enter_mult, 0.5, 2.0, 8.0, dir);
  const trekRecentEnter = bounceBp(g.trek_recent_enter_mult, 0.5, 1.0, 5.0, dir);
  const trekRecentShare = bounceNum(g.trek_recent_share_min, 0.05, 0.1, 0.5, dir);
  const regConfBase = bounceNum(g.regime_conf_base, 0.05, 0.1, 0.6, dir);
  const regConfScale = bounceNum(g.regime_conf_strength_scale, 0.05, 0.2, 0.8, dir);
  const regConfMin = bounceNum(g.regime_conf_min, 0.05, 0.1, 0.5, dir);
  const regConfMax = bounceNum(g.regime_conf_max, 0.05, 0.7, 0.99, dir);
  const bookConfFloor = bounceNum(g.book_confidence_floor_after_switch, 0.05, 0.3, 0.8, dir);
  const flipSoftMoveShortcut = !g.soft_move_trek_pullback_shortcut;
  const chopToTrend = bounceInt(g.chop_to_trend_confirm_bars, 1, 1, 6, dir);
  const flipStickyPrior = !g.sticky_prior_enabled;
  const flipTransition = !g.transition_detect_enabled;
  const flipPlaybookUnify = !g.playbook_promote_vs_live_unify;
  const flipRequireFullHtf = !g.playbook_require_full_htf_stack;
  const flipBlockHtfChop = !g.playbook_block_htf_promote_on_live_chop;
  const flipBlockStoryChop = !g.playbook_block_story_promote_on_live_chop;
  const flipChopOverrideTrend = !g.playbook_chop_overrides_sticky_trend;
  const flipRevFromBreak = !g.reversal_from_breakout_prior;
  const flipOneMarket = !g.playbook_one_market_truth;
  const flipBreakOverTrend = !g.playbook_break_overrides_sticky_trend;
  const flipHtfUnanimous = !g.playbook_htf_require_unanimous;
  const flipRequireSetup = !g.entry_require_regime_setup;
  const flipRegimeRunner = !g.regime_runner_enabled;
  const runnerScore = bounceInt(g.regime_runner_score, 1, 0, g.regime_runner_score_max || 10, dir);
  const runnerMinScore = bounceInt(g.regime_runner_active_min_score, 1, 0, 10, dir);
  const runnerEvalN = bounceInt(g.regime_runner_eval_every_n, 1, 2, 12, dir);
  const runnerDeduct = bounceInt(g.regime_runner_deduct_pts, 1, 1, 5, dir);
  const runnerRecover = bounceInt(g.regime_runner_recover_pts, 1, 1, 5, dir);
  const runnerMinLayer = bounceInt(g.regime_runner_min_target_layer, 1, 1, 3, dir);
  const runnerRetain = bounceNum(g.regime_runner_success_mfe_retain, 0.05, 0.2, 0.85, dir);
  const runnerEligible = toggleInArray(g.regime_runner_eligible_regimes, 'EXPANSION');
  const flipExpansionBefore = !g.expansion_before_trend;
  const enabledRegimes = toggleInArray(g.enabled_regimes, 'TRANSITION');
  const softOffRegimes = toggleInArray(g.soft_off_regimes, 'COMPRESSION');
  const coreAlwaysOn = toggleInArray(g.core_always_on_regimes, 'TRANSITION');
  // Pullback episodes
  const trendThesis = [...g.trend_thesis_regimes];
  const adverseSell = toggleInArray(g.adverse_chapters_sell, 'RALLY');
  const adverseBuy = toggleInArray(g.adverse_chapters_buy, 'SELLOFF');
  const resumeSell = toggleInArray(g.resume_chapters_sell, 'BREAK_DOWN');
  const resumeBuy = toggleInArray(g.resume_chapters_buy, 'BREAK_UP');
  const flipEpisodeEnd = !g.episode_end_on_continue;
  const episodeSpBank = bounceNum(g.episode_softplus_bank_mult, 0.05, 0.5, 2.0, dir);
  // SAFETY
  const safetyBrokerMin = bounceNum(g.safety_sl_broker_min_mult, 0.1, 1.5, 5.0, dir);
  const safetySpread = bounceNum(g.safety_sl_spread_mult, 0.5, 3.0, 15.0, dir);
  const safetyFloorHi = bounceNum(g.safety_abs_floor_hi, 0.05, 0.2, 1.0, dir);
  const safetyFloorMid = bounceNum(g.safety_abs_floor_mid, 0.05, 0.1, 0.5, dir);
  const safetyFloorLo = bounceNum(g.safety_abs_floor_lo, 0.02, 0.01, 0.2, dir);
  const scratchMfeFrac = bounceNum(g.scratch_soft_mfe_frac, 0.05, 0.2, 0.8, dir);
  // Entry learner
  const elLr = bounceNum(g.entry_learner_lr, 0.01, 0.01, 0.5, dir);
  const elL2 = bounceNum(g.entry_learner_l2, 0.001, 0.0005, 0.01, dir);
  const elTemp = bounceNum(g.entry_learner_temp, 0.05, 0.3, 1.5, dir);
  const elEps = bounceNum(g.entry_learner_explore_eps, 0.01, 0.01, 0.2, dir);
  const elMaxW = bounceNum(g.entry_learner_max_w, 0.1, 1.0, 8.0, dir);
  const elZoneLo = bounceNum(g.entry_zone_lo_bin, 0.02, 0.2, 0.5, dir);
  const elZoneHi = bounceNum(g.entry_zone_hi_bin, 0.02, 0.5, 0.8, dir);
  const elWaitBoost = bounceNum(g.entry_learner_wait_boost, 0.05, 0.1, 0.7, dir);
  const elPriorBuy = bounceNum(g.entry_learner_prior_buy, 0.05, -2.0, 2.0, dir);
  const elPriorSell = bounceNum(g.entry_learner_prior_sell, 0.05, -2.0, 2.0, dir);
  const elPriorWait = bounceNum(g.entry_learner_prior_wait, 0.05, -2.0, 2.0, dir);
  // Auto-cal bounds/steps
  const acMaxSafetyRr = bounceNum(g.auto_cal_max_safety_tp_rr, 0.1, 2.0, 5.0, dir);
  const acMaxTgt = bounceNum(g.auto_cal_max_target_abs, 0.5, 6.0, 20.0, dir);
  const acMaxPeakMfe = bounceNum(g.auto_cal_max_peak_mfe_abs, 0.5, 4.0, 15.0, dir);
  const acMaxPeakRet = bounceNum(g.auto_cal_max_peak_retention, 0.05, 0.7, 0.99, dir);
  const acMinPeakRet = bounceNum(g.auto_cal_min_peak_retention, 0.05, 0.05, 0.5, dir);
  const acMinHardinv = bounceNum(g.auto_cal_min_hardinv_abs, 0.1, 0.2, 3.0, dir);
  const acMaxHardinv = bounceNum(g.auto_cal_max_hardinv_abs, 0.5, 4.0, 15.0, dir);
  const softTighten = bounceNum(g.soft_tighten_step, 0.05, 0.1, 0.6, dir);
  const peakEaseAbs = bounceNum(g.peak_ease_abs_step, 0.1, 0.2, 2.0, dir);
  const peakEaseRet = bounceNum(g.peak_ease_retention_step, 0.01, 0.02, 0.15, dir);
  const peakEaseGb = bounceNum(g.peak_ease_giveback_step, 0.05, 0.05, 0.3, dir);
  const safetyRrStep = bounceNum(g.safety_tp_rr_step, 0.05, 0.05, 0.4, dir);
  const safetyRrPbStep = bounceNum(g.safety_tp_rr_pullback_step, 0.05, 0.1, 0.5, dir);
  const minEnabledReg = bounceInt(g.min_enabled_regimes, 1, 1, 13, dir);
  const softPctRefMid = bounceInt(g.soft_pct_ref_mid, 50, 1500, 4000, dir);
  const raiseStreakPb = bounceInt(g.raise_streak_before_pullback, 1, 1, 6, dir);
  const softSizedDetect = bounceInt(g.soft_sized_loss_detect_min, 1, 1, 6, dir);
  const gapMoveStay = bounceBp(g.gap_move_stay, 0.1, 0.5, 3.0, dir);
  const gapStayEnter = bounceBp(g.gap_stay_enter, 0.1, 0.5, 3.0, dir);
  const gapEnterPb = bounceBp(g.gap_enter_pullback, 0.1, 0.5, 3.0, dir);
  const gapPbRev = bounceBp(g.gap_pullback_reversal, 0.5, 2.0, 12.0, dir);
  const gapCompressExp = bounceBp(g.gap_compress_expand, 0.5, 2.0, 8.0, dir);
  const persistEnterStayGap = bounceNum(g.persist_enter_stay_min_gap, 0.02, 0.02, 0.2, dir);

  return [
    {
      title: `Explore Keep→${keep} (step #${nextStep})`,
      rationale: 'Pattern variants exhausted — bounce Peak Keep.',
      task: `peak_keep ${g.peak_keep}→${keep}; explore_step=${nextStep}`,
      genome_delta: {
        peak_keep: keep,
        explore_step: nextStep,
        last_lesson: `Explore keep ${keep} #${nextStep}`,
      },
      patches: [
        genomePatch('peak_keep', keep, `explore Keep ${keep}`),
        genomePatch('explore_step', nextStep, `explore_step ${nextStep}`),
        // Genome-only — no flipFilter write (avoids desk reload blink)
      ],
    },
    {
      title: `Explore giveback→${gb} (step #${nextStep + 1})`,
      rationale: 'Bounce Soft+ giveback bank.',
      task: `soft_plus_giveback→${gb}`,
      genome_delta: {
        soft_plus_giveback: gb,
        mind_bank_on_turn: true,
        explore_step: nextStep + 1,
        last_lesson: `Explore giveback ${gb}`,
      },
      patches: [
        genomePatch('soft_plus_giveback', gb, `explore giveback ${gb}`),
        genomePatch('explore_step', nextStep + 1, `explore_step ${nextStep + 1}`),
        genomePatch('mind_bank_on_turn', true, 'mind bank on'),
        // Genome-only — Mind .ts rides via soft_loss / green_not_banked patterns
      ],
    },
    {
      title: `Explore arm→${arm} (step #${nextStep + 2})`,
      rationale: 'Bounce Peak arm mult.',
      task: `peak_arm_soft_mult→${arm}`,
      genome_delta: {
        peak_arm_soft_mult: arm,
        explore_step: nextStep + 2,
        last_lesson: `Explore arm ${arm}`,
      },
      patches: [
        genomePatch('peak_arm_soft_mult', arm, `explore arm ${arm}`),
        genomePatch('explore_step', nextStep + 2, `explore_step ${nextStep + 2}`),
      ],
    },
    {
      title: `Explore Soft pause→${pause}/${pauseMin} (step #${nextStep + 3})`,
      rationale: 'Bounce Soft same-side pause knobs + flipFilter lock.',
      task: `pause_closes=${pause} pause_min=${pauseMin}`,
      genome_delta: {
        soft_same_side_pause_closes: pause,
        soft_same_side_pause_min: pauseMin,
        explore_step: nextStep + 3,
        last_lesson: `Explore pause ${pause}/${pauseMin}`,
      },
      patches: [
        genomePatch('soft_same_side_pause_closes', pause, `explore pause ${pause}`),
        genomePatch('soft_same_side_pause_min', pauseMin, `explore pause_min ${pauseMin}`),
        genomePatch('explore_step', nextStep + 3, `explore_step ${nextStep + 3}`),
        ...codePatchesSoftSpam(rejectedN % 2),
      ],
    },
    {
      title: `Explore flip 1m gates (step #${nextStep + 4})`,
      rationale: 'Toggle wait_on_1m_fight / require_1m_trigger to escape local maximum.',
      task: `wait=${flipWait} trigger=${flipTrig}`,
      genome_delta: {
        wait_on_1m_fight: flipWait,
        require_1m_trigger: flipTrig,
        explore_step: nextStep + 4,
        last_lesson: `Explore flip wait=${flipWait} trig=${flipTrig}`,
      },
      patches: [
        genomePatch('wait_on_1m_fight', flipWait, `flip wait→${flipWait}`),
        genomePatch('require_1m_trigger', flipTrig, `flip trigger→${flipTrig}`),
        genomePatch('explore_step', nextStep + 4, `explore_step ${nextStep + 4}`),
        // Genome-only gates — no flipFilter lock tick
      ],
    },
    {
      title: `Explore Soft layers→${softL1}/${softL2}/${softL3} (step #${nextStep + 5})`,
      rationale: 'Bounce Soft L1/L2/L3 abs — genome Soft CAP ladder.',
      task: `soft_l1/l2/l3→${softL1}/${softL2}/${softL3}`,
      genome_delta: {
        soft_l1_abs: softL1,
        soft_l2_abs: softL2,
        soft_l3_abs: softL3,
        explore_step: nextStep + 5,
        last_lesson: `Explore Soft layers ${softL1}/${softL2}/${softL3}`,
      },
      patches: [
        genomePatch('soft_l1_abs', softL1, `explore soft_l1 ${softL1}`),
        genomePatch('soft_l2_abs', softL2, `explore soft_l2 ${softL2}`),
        genomePatch('soft_l3_abs', softL3, `explore soft_l3 ${softL3}`),
        genomePatch('explore_step', nextStep + 5, `explore_step ${nextStep + 5}`),
      ],
    },
    {
      title: `Explore Target layers→${tgtL1}/${tgtL2}/${tgtL3} (step #${nextStep + 6})`,
      rationale: 'Bounce Target L1/L2/L3 abs.',
      task: `target_l1/l2/l3→${tgtL1}/${tgtL2}/${tgtL3}`,
      genome_delta: {
        target_l1_abs: tgtL1,
        target_l2_abs: tgtL2,
        target_l3_abs: tgtL3,
        explore_step: nextStep + 6,
        last_lesson: `Explore Target layers ${tgtL1}/${tgtL2}/${tgtL3}`,
      },
      patches: [
        genomePatch('target_l1_abs', tgtL1, `explore target_l1 ${tgtL1}`),
        genomePatch('target_l2_abs', tgtL2, `explore target_l2 ${tgtL2}`),
        genomePatch('target_l3_abs', tgtL3, `explore target_l3 ${tgtL3}`),
        genomePatch('explore_step', nextStep + 6, `explore_step ${nextStep + 6}`),
      ],
    },
    {
      title: `Explore Peak/safety→mfe${peakMfe} rr${safetyRr} trail${trailCap} (step #${nextStep + 7})`,
      rationale: 'Bounce Peak MFE / Keep / trail cap / story-fight arm / SAFETY.',
      task: `peak_mfe=${peakMfe} retention=${peakRet} trail=${trailCap} storyFight=${storyFightArm} rr=${safetyRr} cushion=${safetyCushion}`,
      genome_delta: {
        peak_mfe_abs: peakMfe,
        peak_retention: peakRet,
        peak_trail_soft_cap_mult: trailCap,
        story_fight_peak_arm_soft_mult: storyFightArm,
        safety_tp_rr: safetyRr,
        safety_sl_cushion_bp: safetyCushion,
        explore_step: nextStep + 7,
        last_lesson: `Explore Peak/safety mfe=${peakMfe} rr=${safetyRr}`,
      },
      patches: [
        genomePatch('peak_mfe_abs', peakMfe, `explore peak_mfe ${peakMfe}`),
        genomePatch('peak_retention', peakRet, `explore peak_retention ${peakRet}`),
        genomePatch('peak_trail_soft_cap_mult', trailCap, `explore trail_cap ${trailCap}`),
        genomePatch(
          'story_fight_peak_arm_soft_mult',
          storyFightArm,
          `explore story_fight_arm ${storyFightArm}`
        ),
        genomePatch('safety_tp_rr', safetyRr, `explore safety_rr ${safetyRr}`),
        genomePatch('safety_sl_cushion_bp', safetyCushion, `explore sl_cushion ${safetyCushion}`),
        genomePatch('explore_step', nextStep + 7, `explore_step ${nextStep + 7}`),
      ],
    },
    {
      title: `Explore Soft+ runner/leg/unlock/pullback (step #${nextStep + 8})`,
      rationale: 'Unstick Soft+ runner/leg/unlock + pullback-episode Soft×.',
      task: `runner=${runner} leg=${leg} unlock=${unlock} pbArm=${pbArm} pbMin=${pbMin}`,
      genome_delta: {
        soft_plus_runner_mult: runner,
        soft_plus_leg_mult: leg,
        soft_layer_unlock_mult: unlock,
        pullback_episode_enabled: true,
        pullback_episode_peak_arm_soft_mult: pbArm,
        pullback_episode_min_mfe_soft_mult: pbMin,
        explore_step: nextStep + 8,
        last_lesson: `Explore Soft+ runner/leg/unlock/pb`,
      },
      patches: [
        genomePatch('soft_plus_runner_mult', runner, `explore runner ${runner}`),
        genomePatch('soft_plus_leg_mult', leg, `explore leg ${leg}`),
        genomePatch('soft_layer_unlock_mult', unlock, `explore unlock ${unlock}`),
        genomePatch('pullback_episode_enabled', true, 'enable pullback episode'),
        genomePatch(
          'pullback_episode_peak_arm_soft_mult',
          pbArm,
          `explore pb_arm ${pbArm}`
        ),
        genomePatch(
          'pullback_episode_min_mfe_soft_mult',
          pbMin,
          `explore pb_min ${pbMin}`
        ),
        genomePatch('explore_step', nextStep + 8, `explore_step ${nextStep + 8}`),
      ],
    },
    {
      title: `Explore structure→ext ${extLo}/${extHi} start ${startHi}/${startLo} (step #${nextStep + 9})`,
      rationale: 'Bounce structure extreme + start bands.',
      task: `extreme ${extLo}–${extHi} start ${startHi}–${startLo}`,
      genome_delta: {
        struct_extreme_hi: extHi,
        struct_extreme_lo: extLo,
        struct_start_lo: startLo,
        struct_start_hi: startHi,
        explore_step: nextStep + 9,
        last_lesson: `Explore structure extremes/start`,
      },
      patches: [
        genomePatch('struct_extreme_hi', extHi, `explore extreme_hi ${extHi}`),
        genomePatch('struct_extreme_lo', extLo, `explore extreme_lo ${extLo}`),
        genomePatch('struct_start_lo', startLo, `explore start_lo ${startLo}`),
        genomePatch('struct_start_hi', startHi, `explore start_hi ${startHi}`),
        genomePatch('explore_step', nextStep + 9, `explore_step ${nextStep + 9}`),
        ...codePatchesMicroScratch(rejectedN % 2),
      ],
    },
    {
      title: `Explore regime trek→share${trekShareMin} eff${trekEffMin} (step #${nextStep + 10})`,
      rationale: 'Bounce trek_share_min / trek_eff_min + RANGE chop gates.',
      task: `trek_share_min=${trekShareMin} trek_eff_min=${trekEffMin} range=${rangePersist}/${rangeShare}/${rangeEff}`,
      genome_delta: {
        trek_share_min: trekShareMin,
        trek_eff_min: trekEffMin,
        regime_range_chop_persist_max: rangePersist,
        regime_range_trek_share_max: rangeShare,
        regime_range_trek_eff_max: rangeEff,
        explore_step: nextStep + 10,
        last_lesson: `Explore regime trek ${trekShareMin}/${trekEffMin}`,
      },
      patches: [
        genomePatch('trek_share_min', trekShareMin, `explore trek_share_min ${trekShareMin}`),
        genomePatch('trek_eff_min', trekEffMin, `explore trek_eff_min ${trekEffMin}`),
        genomePatch(
          'regime_range_chop_persist_max',
          rangePersist,
          `explore range_persist ${rangePersist}`
        ),
        genomePatch(
          'regime_range_trek_share_max',
          rangeShare,
          `explore range_trek_share ${rangeShare}`
        ),
        genomePatch('regime_range_trek_eff_max', rangeEff, `explore range_trek_eff ${rangeEff}`),
        genomePatch('explore_step', nextStep + 10, `explore_step ${nextStep + 10}`),
      ],
    },
    {
      title: `Explore mind cut / flip lock / grace (step #${nextStep + 11})`,
      rationale: 'Bounce mind_cut, strong_conf, flip lock ms, hardinv grace.',
      task: `mindCut=${mindCutSoft}/${mindCutRet} strong=${strongConf} lock=${flipLock}/${flipLockLoss} grace=${hardinvGrace}`,
      genome_delta: {
        mind_cut_soft_mult: mindCutSoft,
        mind_cut_retention: mindCutRet,
        strong_conf_min: strongConf,
        same_dir_lock_ms: flipLock,
        same_dir_lock_after_loss_ms: flipLockLoss,
        hardinv_grace_ms: hardinvGrace,
        explore_step: nextStep + 11,
        last_lesson: `Explore mind cut / flip lock`,
      },
      patches: [
        genomePatch('mind_cut_soft_mult', mindCutSoft, `explore mind_cut_soft ${mindCutSoft}`),
        genomePatch('mind_cut_retention', mindCutRet, `explore mind_cut_ret ${mindCutRet}`),
        genomePatch('strong_conf_min', strongConf, `explore strong_conf ${strongConf}`),
        genomePatch('same_dir_lock_ms', flipLock, `explore flip_lock ${flipLock}`),
        genomePatch(
          'same_dir_lock_after_loss_ms',
          flipLockLoss,
          `explore flip_lock_loss ${flipLockLoss}`
        ),
        genomePatch('hardinv_grace_ms', hardinvGrace, `explore hardinv_grace ${hardinvGrace}`),
        genomePatch('explore_step', nextStep + 11, `explore_step ${nextStep + 11}`),
      ],
    },
    {
      title: `Explore exit profile trend/fade (step #${nextStep + 12})`,
      rationale: 'Sample exit_trend_target_mult + exit_fade_hardinv_mult.',
      task: `exit_trend_target=${exitTrendTgt} exit_fade_hardinv=${exitFadeHard}`,
      genome_delta: {
        exit_trend_target_mult: exitTrendTgt,
        exit_fade_hardinv_mult: exitFadeHard,
        explore_step: nextStep + 12,
        last_lesson: `Explore exit profile ${exitTrendTgt}/${exitFadeHard}`,
      },
      patches: [
        genomePatch(
          'exit_trend_target_mult',
          exitTrendTgt,
          `explore exit_trend_tgt ${exitTrendTgt}`
        ),
        genomePatch(
          'exit_fade_hardinv_mult',
          exitFadeHard,
          `explore exit_fade_hardinv ${exitFadeHard}`
        ),
        genomePatch('explore_step', nextStep + 12, `explore_step ${nextStep + 12}`),
      ],
    },
    {
      title: `Explore REVERSAL band→${rev} (step #${nextStep + 13})`,
      rationale: 'Evolve how sensitive classify is to violent reverse bodies.',
      task: `regime_reversal ${g.regime_reversal}→${rev}`,
      genome_delta: {
        regime_reversal: rev,
        explore_step: nextStep + 13,
        last_lesson: `Explore regime_reversal ${rev}`,
      },
      patches: [
        genomePatch('regime_reversal', rev, `explore reversal ${rev}`),
        genomePatch('explore_step', nextStep + 13, `explore_step ${nextStep + 13}`),
      ],
    },
    {
      title: `Explore TREND enter→${trendEnter} (step #${nextStep + 14})`,
      rationale: 'Evolve how easily TREND enters from persistence + body.',
      task: `regime_trend_enter→${trendEnter} persist_enter→${persistEnter}`,
      genome_delta: {
        regime_trend_enter: trendEnter,
        regime_persist_enter: persistEnter,
        explore_step: nextStep + 14,
        last_lesson: `Explore trend_enter ${trendEnter}`,
      },
      patches: [
        genomePatch('regime_trend_enter', trendEnter, `explore trend_enter ${trendEnter}`),
        genomePatch('regime_persist_enter', persistEnter, `explore persist_enter ${persistEnter}`),
        genomePatch('explore_step', nextStep + 14, `explore_step ${nextStep + 14}`),
      ],
    },
    {
      title: `Explore MOVE/stay/range→${move}/${trendStay}/${moveRange} (step #${nextStep + 15})`,
      rationale: 'Evolve MOVE floor, TREND_STAY, and move_range ladder.',
      task: `regime_move→${move} stay→${trendStay} move_range→${moveRange}`,
      genome_delta: {
        regime_move: move,
        regime_trend_stay: trendStay,
        regime_move_range: moveRange,
        explore_step: nextStep + 15,
        last_lesson: `Explore move/stay/range ${move}`,
      },
      patches: [
        genomePatch('regime_move', move, `explore move ${move}`),
        genomePatch('regime_trend_stay', trendStay, `explore stay ${trendStay}`),
        genomePatch('regime_move_range', moveRange, `explore move_range ${moveRange}`),
        genomePatch('explore_step', nextStep + 15, `explore_step ${nextStep + 15}`),
      ],
    },
    {
      title: `Explore pullback/expand→${pullback}/${expandAbs} (step #${nextStep + 16})`,
      rationale: 'Evolve PULLBACK body + EXPANSION abs range sensitivity.',
      task: `regime_pullback→${pullback} regime_expand_abs→${expandAbs}`,
      genome_delta: {
        regime_pullback: pullback,
        regime_expand_abs: expandAbs,
        explore_step: nextStep + 16,
        last_lesson: `Explore pullback/expand ${pullback}/${expandAbs}`,
      },
      patches: [
        genomePatch('regime_pullback', pullback, `explore pullback ${pullback}`),
        genomePatch('regime_expand_abs', expandAbs, `explore expand ${expandAbs}`),
        genomePatch('explore_step', nextStep + 16, `explore_step ${nextStep + 16}`),
      ],
    },
    {
      title: `Explore compress→${compressAbs}/${compressMult} expandMult→${expandMult} (step #${nextStep + 17})`,
      rationale: 'Evolve compression abs/mult and expansion mult.',
      task: `compress_abs→${compressAbs} compress_mult→${compressMult} expand_mult→${expandMult}`,
      genome_delta: {
        regime_compress_abs: compressAbs,
        regime_compress_avg_mult: compressMult,
        regime_expand_avg_mult: expandMult,
        explore_step: nextStep + 17,
        last_lesson: `Explore compress/expand mult`,
      },
      patches: [
        genomePatch('regime_compress_abs', compressAbs, `explore compress_abs ${compressAbs}`),
        genomePatch('regime_compress_avg_mult', compressMult, `explore compress_mult ${compressMult}`),
        genomePatch('regime_expand_avg_mult', expandMult, `explore expand_mult ${expandMult}`),
        genomePatch('explore_step', nextStep + 17, `explore_step ${nextStep + 17}`),
      ],
    },
    {
      title: `Explore zone mid/break→${nearMid}/${clearBreak} (step #${nextStep + 18})`,
      rationale: 'Evolve near-zone-mid and clear-break fraction.',
      task: `near_zone_mid→${nearMid} clear_break→${clearBreak}`,
      genome_delta: {
        regime_near_zone_mid: nearMid,
        regime_clear_break_frac: clearBreak,
        explore_step: nextStep + 18,
        last_lesson: `Explore zone mid/break`,
      },
      patches: [
        genomePatch('regime_near_zone_mid', nearMid, `explore near_mid ${nearMid}`),
        genomePatch('regime_clear_break_frac', clearBreak, `explore clear_break ${clearBreak}`),
        genomePatch('explore_step', nextStep + 18, `explore_step ${nextStep + 18}`),
      ],
    },
    {
      title: `Explore persist stay/pull→${persistStay}/${persistPull} (step #${nextStep + 19})`,
      rationale: 'Evolve persistence stay + pullback thresholds.',
      task: `persist_stay→${persistStay} persist_pullback→${persistPull}`,
      genome_delta: {
        regime_persist_stay: persistStay,
        regime_persist_pullback: persistPull,
        explore_step: nextStep + 19,
        last_lesson: `Explore persist stay/pull`,
      },
      patches: [
        genomePatch('regime_persist_stay', persistStay, `explore persist_stay ${persistStay}`),
        genomePatch('regime_persist_pullback', persistPull, `explore persist_pull ${persistPull}`),
        genomePatch('explore_step', nextStep + 19, `explore_step ${nextStep + 19}`),
      ],
    },
    {
      title: `Explore dwell/confirm→${dwell}/${confirm} (step #${nextStep + 20})`,
      rationale: 'Evolve regime stabilizer anti-flicker stringency.',
      task: `regime_min_dwell_bars=${dwell} regime_confirm_bars=${confirm}`,
      genome_delta: {
        regime_min_dwell_bars: dwell,
        regime_confirm_bars: confirm,
        explore_step: nextStep + 20,
        last_lesson: `Explore dwell/confirm ${dwell}/${confirm}`,
      },
      patches: [
        genomePatch('regime_min_dwell_bars', dwell, `explore dwell ${dwell}`),
        genomePatch('regime_confirm_bars', confirm, `explore confirm ${confirm}`),
        genomePatch('explore_step', nextStep + 20, `explore_step ${nextStep + 20}`),
      ],
    },
    {
      title: `Explore mom/persist window→${momBars}/${persistWin} (step #${nextStep + 21})`,
      rationale: 'Evolve momentum + persistence window lengths.',
      task: `regime_mom_bars=${momBars} regime_persist_window=${persistWin}`,
      genome_delta: {
        regime_mom_bars: momBars,
        regime_persist_window: persistWin,
        explore_step: nextStep + 21,
        last_lesson: `Explore mom/persist window`,
      },
      patches: [
        genomePatch('regime_mom_bars', momBars, `explore mom ${momBars}`),
        genomePatch('regime_persist_window', persistWin, `explore persist_win ${persistWin}`),
        genomePatch('explore_step', nextStep + 21, `explore_step ${nextStep + 21}`),
      ],
    },
    {
      title: `Explore multi-TF + HTF veto / chop (step #${nextStep + 22})`,
      rationale: 'Evolve trek flat, HTF veto, aligned-side, story/chop conf.',
      task: `trek=${trekFlat} htfVeto=${flipHtfVeto} blockHF=${flipBlockHf} aligned=${flipAligned} story=${storyMin} chop=${chopMax}`,
      genome_delta: {
        mtf_trek_flat_frac: trekFlat,
        mtf_htf_veto: flipHtfVeto,
        mtf_block_higher_fight: flipBlockHf,
        mtf_require_aligned_side: flipAligned,
        entry_story_conf_min: storyMin,
        entry_chop_conf_max: chopMax,
        explore_step: nextStep + 22,
        last_lesson: `Explore mtf htfVeto=${flipHtfVeto} chop=${chopMax}`,
      },
      patches: [
        genomePatch('mtf_trek_flat_frac', trekFlat, `explore trek ${trekFlat}`),
        genomePatch('mtf_htf_veto', flipHtfVeto, `flip htf_veto→${flipHtfVeto}`),
        genomePatch('mtf_block_higher_fight', flipBlockHf, `flip blockHF→${flipBlockHf}`),
        genomePatch('mtf_require_aligned_side', flipAligned, `flip aligned→${flipAligned}`),
        genomePatch('entry_story_conf_min', storyMin, `explore story_min ${storyMin}`),
        genomePatch('entry_chop_conf_max', chopMax, `explore chop_max ${chopMax}`),
        genomePatch('explore_step', nextStep + 22, `explore_step ${nextStep + 22}`),
      ],
    },
    {
      title: `Explore fallback/stretch/layers→${softL1Fb}/${tgtL3MinSoft} (step #${nextStep + 23})`,
      rationale: 'Bounce Soft/Target fallback fracs, stretch gate, layer percentiles.',
      task: `fallback ${softL1Fb}/${softL2Fb} stretch=${stretchGate} layers=${layerP35}/${layerP60}/${layerP85}`,
      genome_delta: {
        soft_l1_fallback_frac: softL1Fb,
        soft_l2_fallback_frac: softL2Fb,
        target_l1_fallback_frac: tgtL1Fb,
        target_l2_fallback_frac: tgtL2Fb,
        target_stretch_gate: stretchGate,
        layer_suggest_p35: layerP35,
        layer_suggest_p60: layerP60,
        layer_suggest_p85: layerP85,
        target_l3_min_vs_soft: tgtL3MinSoft,
        soft_layer_unlock_floor: unlockFloor,
        peak_mfe_retention_fallback: peakMfeRetFb,
        hardinv_pct_bp: hardinvPctBp,
        peak_mfe_pct_bp: peakMfePctBp,
        peak_min_giveback_abs: peakMinGb,
        target_pct_bp: tgtPctBp,
        entry_filter_level: entryFilter,
        explore_step: nextStep + 23,
        last_lesson: `Explore fallback/layers ${softL1Fb}`,
      },
      patches: [
        genomePatch('soft_l1_fallback_frac', softL1Fb, `explore soft_l1_fb ${softL1Fb}`),
        genomePatch('soft_l2_fallback_frac', softL2Fb, `explore soft_l2_fb ${softL2Fb}`),
        genomePatch('target_l1_fallback_frac', tgtL1Fb, `explore tgt_l1_fb ${tgtL1Fb}`),
        genomePatch('target_l2_fallback_frac', tgtL2Fb, `explore tgt_l2_fb ${tgtL2Fb}`),
        genomePatch('target_stretch_gate', stretchGate, `explore stretch ${stretchGate}`),
        genomePatch('layer_suggest_p35', layerP35, `explore layer_p35 ${layerP35}`),
        genomePatch('layer_suggest_p60', layerP60, `explore layer_p60 ${layerP60}`),
        genomePatch('layer_suggest_p85', layerP85, `explore layer_p85 ${layerP85}`),
        genomePatch('target_l3_min_vs_soft', tgtL3MinSoft, `explore tgt_l3_min ${tgtL3MinSoft}`),
        genomePatch('soft_layer_unlock_floor', unlockFloor, `explore unlock_floor ${unlockFloor}`),
        genomePatch(
          'peak_mfe_retention_fallback',
          peakMfeRetFb,
          `explore peak_mfe_ret_fb ${peakMfeRetFb}`
        ),
        genomePatch('hardinv_pct_bp', hardinvPctBp, `explore hardinv_pct ${hardinvPctBp}`),
        genomePatch('peak_mfe_pct_bp', peakMfePctBp, `explore peak_mfe_pct ${peakMfePctBp}`),
        genomePatch('peak_min_giveback_abs', peakMinGb, `explore peak_min_gb ${peakMinGb}`),
        genomePatch('target_pct_bp', tgtPctBp, `explore target_pct ${tgtPctBp}`),
        genomePatch('entry_filter_level', entryFilter, `explore entry_filter ${entryFilter}`),
        genomePatch('explore_step', nextStep + 23, `explore_step ${nextStep + 23}`),
      ],
    },
    {
      title: `Explore exit floors/caps→${hardinvFloor}/${tgtAbsFloor} (step #${nextStep + 24})`,
      rationale: 'Bounce HardInv/Peak/Target abs floors and caps.',
      task: `hardinv=${hardinvFloor}/${hardinvCap} peak_mfe_floor=${peakMfeFloor} target_floor=${tgtAbsFloor}`,
      genome_delta: {
        max_mfe_giveback: maxMfeGb,
        hardinv_abs_floor: hardinvFloor,
        hardinv_abs_cap: hardinvCap,
        peak_mfe_abs_floor: peakMfeFloor,
        target_abs_floor: tgtAbsFloor,
        safety_tp_min_rr: safetyTpMinRr,
        layered_soft_post_mult_cap: layeredCap,
        min_profit_bank_soft_mult: minProfitBank,
        desk_ref_mid: deskRefMid,
        safety_tp_vs_min_stop_mult: safetyTpVsStop,
        explore_step: nextStep + 24,
        last_lesson: `Explore exit floors ${hardinvFloor}`,
      },
      patches: [
        genomePatch('max_mfe_giveback', maxMfeGb, `explore max_mfe_gb ${maxMfeGb}`),
        genomePatch('hardinv_abs_floor', hardinvFloor, `explore hardinv_floor ${hardinvFloor}`),
        genomePatch('hardinv_abs_cap', hardinvCap, `explore hardinv_cap ${hardinvCap}`),
        genomePatch('peak_mfe_abs_floor', peakMfeFloor, `explore peak_mfe_floor ${peakMfeFloor}`),
        genomePatch('target_abs_floor', tgtAbsFloor, `explore target_floor ${tgtAbsFloor}`),
        genomePatch('safety_tp_min_rr', safetyTpMinRr, `explore safety_tp_min_rr ${safetyTpMinRr}`),
        genomePatch('layered_soft_post_mult_cap', layeredCap, `explore layered_cap ${layeredCap}`),
        genomePatch('min_profit_bank_soft_mult', minProfitBank, `explore min_profit_bank ${minProfitBank}`),
        genomePatch('desk_ref_mid', deskRefMid, `explore desk_ref_mid ${deskRefMid}`),
        genomePatch('safety_tp_vs_min_stop_mult', safetyTpVsStop, `explore safety_tp_vs_stop ${safetyTpVsStop}`),
        genomePatch('explore_step', nextStep + 24, `explore_step ${nextStep + 24}`),
      ],
    },
    {
      title: `Explore exit timings→${hardinvConfirm}/${tdMinHold} (step #${nextStep + 25})`,
      rationale: 'Bounce HardInv/structure/timedecay confirm and hold ms.',
      task: `hardinv_confirm=${hardinvConfirm} struct=${structGrace}/${structConfirm} td=${tdMinHold}/${tdMinFav}`,
      genome_delta: {
        hardinv_confirm_ms: hardinvConfirm,
        structure_grace_ms: structGrace,
        structure_confirm_ms: structConfirm,
        timedecay_min_hold_ms: tdMinHold,
        timedecay_min_fav_abs: tdMinFav,
        timedecay_fav_pct_bp: tdFavPctBp,
        explore_step: nextStep + 25,
        last_lesson: `Explore exit timings ${hardinvConfirm}`,
      },
      patches: [
        genomePatch('hardinv_confirm_ms', hardinvConfirm, `explore hardinv_confirm ${hardinvConfirm}`),
        genomePatch('structure_grace_ms', structGrace, `explore struct_grace ${structGrace}`),
        genomePatch('structure_confirm_ms', structConfirm, `explore struct_confirm ${structConfirm}`),
        genomePatch('timedecay_min_hold_ms', tdMinHold, `explore td_hold ${tdMinHold}`),
        genomePatch('timedecay_min_fav_abs', tdMinFav, `explore td_min_fav ${tdMinFav}`),
        genomePatch('timedecay_fav_pct_bp', tdFavPctBp, `explore td_fav_pct ${tdFavPctBp}`),
        genomePatch('explore_step', nextStep + 25, `explore_step ${nextStep + 25}`),
      ],
    },
    {
      title: `Explore exit ${exitFam} hardinv/target (step #${nextStep + 26})`,
      rationale: `Rotate exit family ${exitFam} — bounce hardinv + target mult.`,
      task: `exit_${exitFam}_hardinv=${famHardinv} target=${famTarget}`,
      genome_delta: {
        [exitFamilyKey(exitFam, 'hardinv_mult')]: famHardinv,
        [exitFamilyKey(exitFam, 'target_mult')]: famTarget,
        explore_step: nextStep + 26,
        last_lesson: `Explore exit ${exitFam} hardinv/target`,
      },
      patches: [
        genomePatch(
          exitFamilyKey(exitFam, 'hardinv_mult'),
          famHardinv,
          `explore ${exitFam} hardinv ${famHardinv}`
        ),
        genomePatch(
          exitFamilyKey(exitFam, 'target_mult'),
          famTarget,
          `explore ${exitFam} target ${famTarget}`
        ),
        genomePatch('explore_step', nextStep + 26, `explore_step ${nextStep + 26}`),
      ],
    },
    {
      title: `Explore exit ${exitFam} peak (step #${nextStep + 27})`,
      rationale: `Rotate exit family ${exitFam} — peak arm/mfe/giveback/retention.`,
      task: `peak_arm=${famPeakArm} mfe=${famPeakMfe} gb=${famPeakGb} ret=${famPeakRet}`,
      genome_delta: {
        [exitFamilyKey(exitFam, 'peak_arm')]: famPeakArm,
        [exitFamilyKey(exitFam, 'peak_mfe_mult')]: famPeakMfe,
        [exitFamilyKey(exitFam, 'peak_giveback_mult')]: famPeakGb,
        [exitFamilyKey(exitFam, 'peak_retention')]: famPeakRet,
        explore_step: nextStep + 27,
        last_lesson: `Explore exit ${exitFam} peak`,
      },
      patches: [
        genomePatch(
          exitFamilyKey(exitFam, 'peak_arm'),
          famPeakArm,
          `explore ${exitFam} peak_arm ${famPeakArm}`
        ),
        genomePatch(
          exitFamilyKey(exitFam, 'peak_mfe_mult'),
          famPeakMfe,
          `explore ${exitFam} peak_mfe ${famPeakMfe}`
        ),
        genomePatch(
          exitFamilyKey(exitFam, 'peak_giveback_mult'),
          famPeakGb,
          `explore ${exitFam} peak_gb ${famPeakGb}`
        ),
        genomePatch(
          exitFamilyKey(exitFam, 'peak_retention'),
          famPeakRet,
          `explore ${exitFam} peak_ret ${famPeakRet}`
        ),
        genomePatch('explore_step', nextStep + 27, `explore_step ${nextStep + 27}`),
      ],
    },
    {
      title: `Explore exit ${exitFam} timedecay/structure (step #${nextStep + 28})`,
      rationale: `Rotate exit family ${exitFam} — timedecay + structure invalidation.`,
      task: `td_hold=${famTdHold} td_fav=${famTdFav} struct=${famStruct}`,
      genome_delta: {
        [exitFamilyKey(exitFam, 'timedecay_hold_ms')]: famTdHold,
        [exitFamilyKey(exitFam, 'timedecay_min_fav_mult')]: famTdFav,
        [exitFamilyKey(exitFam, 'structure')]: famStruct,
        explore_step: nextStep + 28,
        last_lesson: `Explore exit ${exitFam} td/struct`,
      },
      patches: [
        genomePatch(
          exitFamilyKey(exitFam, 'timedecay_hold_ms'),
          famTdHold,
          `explore ${exitFam} td_hold ${famTdHold}`
        ),
        genomePatch(
          exitFamilyKey(exitFam, 'timedecay_min_fav_mult'),
          famTdFav,
          `explore ${exitFam} td_fav ${famTdFav}`
        ),
        genomePatch(
          exitFamilyKey(exitFam, 'structure'),
          famStruct,
          `explore ${exitFam} struct ${famStruct}`
        ),
        genomePatch('explore_step', nextStep + 28, `explore_step ${nextStep + 28}`),
      ],
    },
    {
      title: `Explore soft-exit gates + mid slack (step #${nextStep + 29})`,
      rationale: 'Toggle soft-exit gates, exit-loss flags, deprecated BE-lock fracs, mid slack.',
      task: `soft_exit=${flipSoftExit1m}/${flipSoftExitBlock} exit_loss=${flipExitLossHard}/${flipExitLossBe} beLock=${beLockFrac}/${beLockExec} slack=${exitMidSlack}`,
      genome_delta: {
        soft_exit_require_1m_change: flipSoftExit1m,
        soft_exit_block_same_next_entry: flipSoftExitBlock,
        exit_loss_include_hardinv: flipExitLossHard,
        exit_loss_exclude_be_lock: flipExitLossBe,
        be_lock_frac: beLockFrac,
        be_lock_exec_frac: beLockExec,
        exit_range_through_mid_slack: exitMidSlack,
        explore_step: nextStep + 29,
        last_lesson: `Explore soft-exit gates slack=${exitMidSlack}`,
      },
      patches: [
        genomePatch('soft_exit_require_1m_change', flipSoftExit1m, `flip soft_exit_1m ${flipSoftExit1m}`),
        genomePatch(
          'soft_exit_block_same_next_entry',
          flipSoftExitBlock,
          `flip soft_exit_block ${flipSoftExitBlock}`
        ),
        genomePatch(
          'exit_loss_include_hardinv',
          flipExitLossHard,
          `flip exit_loss_hard ${flipExitLossHard}`
        ),
        genomePatch('exit_loss_exclude_be_lock', flipExitLossBe, `flip exit_loss_be ${flipExitLossBe}`),
        genomePatch('be_lock_frac', beLockFrac, `explore be_lock_frac ${beLockFrac}`),
        genomePatch('be_lock_exec_frac', beLockExec, `explore be_lock_exec ${beLockExec}`),
        genomePatch('exit_range_through_mid_slack', exitMidSlack, `explore mid_slack ${exitMidSlack}`),
        genomePatch('explore_step', nextStep + 29, `explore_step ${nextStep + 29}`),
      ],
    },
    {
      title: `Explore structure half/zone/pierce (step #${nextStep + 30})`,
      rationale: 'Bounce half bands, zone cuts, pierce/reclaim/compress, m1 aggregate.',
      task: `half=${halfLo}/${halfHi} zone=${zbLo}–${zbHi} m1=${m1AggBars}`,
      genome_delta: {
        struct_half_lo: halfLo,
        struct_half_hi: halfHi,
        zone_band_cut_lo: zbLo,
        zone_band_cut_mid_lo: zbMidLo,
        zone_band_cut_mid_hi: zbMidHi,
        zone_band_cut_hi: zbHi,
        m1_aggregate_min_bars: m1AggBars,
        minute_trend_bias_lookback: mtbLookback,
        minute_trend_bias_trek_min_path_bp: mtbPathBp,
        breakout_pierce_pos_hi: pierceHi,
        breakout_pierce_pos_lo: pierceLo,
        failed_break_reclaim_pos_lo: reclaimLo,
        failed_break_reclaim_pos_hi: reclaimHi,
        compression_entry_pos_lo: compressLo,
        compression_entry_pos_hi: compressHi,
        exhaust_tip_chase_block: flipExhaustTip,
        entry_block_post_impulse_tip: flipPostImpulseTip,
        entry_post_impulse_share_min: postImpulseShare,
        entry_post_impulse_min_bars: postImpulseMinBars,
        entry_post_impulse_zone_bars: postImpulseZoneBars,
        entry_post_impulse_exempt_lanes: postImpulseExempt,
        entry_tip_chase_trend_pullback: flipTipChaseTrend,
        entry_tip_block_finished_move: flipTipFinished,
        entry_trend_tip_require_reject: flipTrendTipReject,
        peak_keep_genome_owns: flipPeakKeepOwns,
        manage_path_deep_green_soft_mult: manageDeepGreen,
        manage_path_fade_soft_mult: manageFadeSoft,
        manage_path_fade_score: manageFadeScore,
        manage_path_stall_mfe_soft_mult: manageStallMfe,
        manage_path_stall_upl_soft_mult: manageStallUpl,
        manage_path_stall_score: manageStallScore,
        manage_mae_deep_soft_mult: manageMaeMult,
        manage_mae_deep_score: manageMaeScore,
        manage_score_m1_wait: manageM1Wait,
        manage_score_next_same: manageNextSame,
        manage_score_thesis_bonus: manageThesisBonus,
        manage_score_soft_gate_open: manageSoftGate,
        manage_score_story_fight: manageStoryFight,
        manage_score_story_with: manageStoryWith,
        manage_score_pressure_with: managePressureWith,
        manage_score_expand_continue: manageExpandCont,
        manage_score_expand_reverse: manageExpandRev,
        manage_score_feed_divergent: manageFeedDiv,
        manage_score_feed_strong: manageFeedStrong,
        manage_score_chapter_change: manageChapter,
        manage_score_near_target: manageNearTarget,
        manage_learner_min_updates: manageLearnerMin,
        mind_manage_conf_bank: mindConfBank,
        mind_manage_conf_cut: mindConfCut,
        mind_manage_conf_hold_continue: mindConfHoldCont,
        mind_manage_conf_hold_against: mindConfHoldAgainst,
        mind_manage_conf_trail: mindConfTrail,
        mind_deep_green_soft_mult: mindDeepGreen,
        timedecay_target_frac: tdTargetFrac,
        peak_trail_minbank_frac: peakTrailMinBank,
        scalp_wick_frac: scalpWick,
        scalp_wick_body_frac: scalpWickBody,
        local_breakout_lookback_max: localLbMax,
        local_breakout_lookback_min: localLbMin,
        local_breakout_skip_bars: localSkip,
        local_breakout_min_struct_bars: localMinStruct,
        local_breakout_clear_frac_mult: localClearMult,
        regime_conf_move_div: regimeConfDiv,
        entry_m1_strong_move_mult: entryM1Strong,
        trek_min_path_abs_pts: trekAbsPts,
        safety_spread_fallback_bp: safetySpreadBp,
        safety_abs_floor_tiny_bp: safetyTinyBp,
        safety_abs_floor_nano_bp: safetyNanoBp,
        regime_runner_bad_retain_frac: runnerBadFrac,
        auto_calibrate_every_n: autoCalEvery,
        auto_cal_min_hardinv_pct_bp: autoCalMinHardBp,
        auto_cal_max_hardinv_pct_bp: autoCalMaxHardBp,
        auto_cal_min_target_pct_bp: autoCalMinTgtBp,
        auto_cal_max_target_pct_bp: autoCalMaxTgtBp,
        auto_cal_min_peak_mfe_pct_bp: autoCalMinPeakBp,
        auto_cal_max_peak_mfe_pct_bp: autoCalMaxPeakBp,
        mind_entry_conf_aligned_strong: entryConfStrong,
        mind_entry_conf_aligned: entryConfAligned,
        mind_entry_conf_strong_m1: entryConfM1,
        mind_entry_conf_bias: entryConfBias,
        mind_entry_conf_weak: entryConfWeak,
        mind_entry_conf_regime_boost: entryConfBoost,
        mind_entry_conf_cap: entryConfCap,
        entry_learner_min_updates: entryLearnerMin,
        entry_post_impulse_late_eff_min: postImpulseLateEff,
        mind_entry_conf_regime_hyp: entryConfRegimeHyp,
        mind_entry_conf_pb_wait: entryConfPbWait,
        mind_entry_conf_pb_resume_floor: entryConfPbResume,
        mind_entry_conf_story_side_floor: entryConfStorySide,
        mind_entry_conf_flip_after_loss: entryConfFlipLoss,
        mind_entry_conf_chop_wait: entryConfChopWait,
        mind_entry_conf_mixed_wait: entryConfMixedWait,
        mind_entry_conf_hard_veto: entryConfHardVeto,
        mind_entry_conf_stack_fight: entryConfStackFight,
        mind_entry_conf_stack_chapter_wait: entryConfStackChapter,
        auto_cal_micro_win_vs_loss: acMicroWin,
        auto_cal_high_mfe_vs_loss: acHighMfe,
        auto_cal_left_winner_e_max: acLeftWinnerE,
        auto_cal_asym_win_vs_loss: acAsym,
        auto_cal_soft_dom_e_max: acSoftDomE,
        auto_cal_soft_dom_win_vs_loss: acSoftDomWin,
        auto_cal_ease_filter_e_min: acEaseFilterE,
        auto_cal_legacy_raise_e_max: acLegacyE,
        auto_cal_legacy_raise_win_vs_loss: acLegacyWin,
        auto_cal_soft_tight_e_max: acSoftTightE,
        auto_cal_healthy_e_min: acHealthyE,
        auto_cal_healthy_win_vs_loss: acHealthyWin,
        auto_cal_target_ease_abs: acTargetEase,
        auto_cal_target_pct_ease_div: acTargetPctEase,
        auto_cal_peak_raise_abs: acPeakRaise,
        auto_cal_target_raise_abs: acTargetRaise,
        auto_cal_target_pct_raise_mult: acTargetPctRaise,
        auto_cal_peak_pct_raise_mult: acPeakPctRaise,
        auto_cal_giveback_raise_abs: acGivebackRaise,
        auto_cal_healthy_keep_step: acHealthyKeep,
        auto_cal_let_winners_e_min: acLetWinnersE,
        auto_cal_choppy_ctx_min: acChoppyCtx,
        auto_cal_choppy_e_max: acChoppyE,
        auto_cal_neg_e_align_max: acNegAlign,
        auto_cal_expand_ctx_min: acExpandCtx,
        auto_cal_expand_e_min: acExpandE,
        auto_cal_choppy_dwell_e_max: acChoppyDwellE,
        auto_cal_fight_ctx_min: acFightCtx,
        auto_cal_fight_e_max: acFightE,
        auto_cal_soft_dom_loss_count_min: acSoftDomLossN,
        auto_cal_soft_dom_loss_vs_hardinv: acSoftDomLossVs,
        auto_cal_demote_recover_e_min: acDemoteRecoverE,
        auto_cal_soft_loss_abs_floor: acSoftLossAbsFloor,
        auto_cal_micro_win_abs_floor: acMicroWinAbsFloor,
        auto_cal_peak_exits_min: acPeakExitsMin,
        auto_cal_high_mfe_tiny_count_min: acHighMfeTinyCountMin,
        auto_cal_micro_wins_min: acMicroWinsMin,
        auto_cal_avg_loss_abs_floor: acAvgLossAbsFloor,
        auto_cal_already_tall_soft_mult: acAlreadyTallSoftMult,
        auto_cal_soft_tight_soft_losses_min: acSoftTightSoftLossesMin,
        auto_cal_soft_tight_high_mfe_min: acSoftTightHighMfeMin,
        auto_cal_soft_tight_hardinv_max: acSoftTightHardinvMax,
        auto_cal_regime_promote_n_min: acRegimePromoteNMin,
        auto_cal_regime_promote_sum_min: acRegimePromoteSumMin,
        auto_cal_regime_keep_n_max: acRegimeKeepNMax,
        auto_cal_regime_keep_sum_min: acRegimeKeepSumMin,
        auto_cal_regime_demote_sum_max: acRegimeDemoteSumMax,
        auto_cal_mut_soft_plus_giveback_step: acMutSoftPlusGivebackStep,
        auto_cal_mut_peak_arm_step: acMutPeakArmStep,
        auto_cal_mut_soft_layer_unlock_step: acMutSoftLayerUnlockStep,
        auto_cal_mut_pb_episode_arm_step: acMutPbEpisodeArmStep,
        auto_cal_mut_pb_episode_mfe_step: acMutPbEpisodeMfeStep,
        auto_cal_mut_soft_plus_runner_step: acMutSoftPlusRunnerStep,
        auto_cal_mut_soft_plus_leg_step: acMutSoftPlusLegStep,
        auto_cal_mut_soft_plus_giveback_min: acMutSoftPlusGivebackMin,
        auto_cal_mut_soft_plus_giveback_max: acMutSoftPlusGivebackMax,
        auto_cal_mut_peak_arm_min: acMutPeakArmMin,
        auto_cal_mut_peak_arm_max: acMutPeakArmMax,
        auto_cal_mut_soft_layer_unlock_min: acMutSoftLayerUnlockMin,
        auto_cal_mut_soft_layer_unlock_max: acMutSoftLayerUnlockMax,
        auto_cal_mut_pb_episode_arm_min: acMutPbEpisodeArmMin,
        auto_cal_mut_pb_episode_arm_max: acMutPbEpisodeArmMax,
        auto_cal_mut_pb_episode_mfe_min: acMutPbEpisodeMfeMin,
        auto_cal_mut_pb_episode_mfe_max: acMutPbEpisodeMfeMax,
        auto_cal_mut_soft_plus_runner_min: acMutSoftPlusRunnerMin,
        auto_cal_mut_soft_plus_runner_max: acMutSoftPlusRunnerMax,
        auto_cal_mut_soft_plus_leg_min: acMutSoftPlusLegMin,
        auto_cal_mut_soft_plus_leg_max: acMutSoftPlusLegMax,
        auto_cal_range_soft_min: acRangeSoftMin,
        auto_cal_range_wins_min: acRangeWinsMin,
        auto_cal_pb_soft_min: acPbSoftMin,
        auto_cal_mut_range_chop_down: acMutRangeChopDown,
        auto_cal_mut_range_share_down: acMutRangeShareDown,
        auto_cal_mut_range_eff_down: acMutRangeEffDown,
        auto_cal_mut_range_chop_up: acMutRangeChopUp,
        auto_cal_mut_range_chop_min: acMutRangeChopMin,
        auto_cal_mut_range_chop_max: acMutRangeChopMax,
        auto_cal_mut_range_share_min: acMutRangeShareMin,
        auto_cal_mut_range_share_max: acMutRangeShareMax,
        auto_cal_mut_range_eff_min: acMutRangeEffMin,
        auto_cal_mut_range_eff_max: acMutRangeEffMax,
        auto_cal_same_side_pause_max: acSameSidePauseMax,
        auto_cal_same_side_pause_soft_min: acSameSidePauseSoftMin,
        auto_cal_same_side_pause_step: acSameSidePauseStep,
        auto_cal_choppy_green_lo: acChoppyGreenLo,
        auto_cal_choppy_green_hi: acChoppyGreenHi,
        auto_cal_mut_trek_flat_mult: acMutTrekFlatMult,
        auto_cal_mut_trek_flat_min: acMutTrekFlatMin,
        auto_cal_mut_trek_flat_max: acMutTrekFlatMax,
        auto_cal_mut_story_conf_step: acMutStoryConfStep,
        auto_cal_mut_story_conf_min: acMutStoryConfMin,
        auto_cal_mut_story_conf_max: acMutStoryConfMax,
        auto_cal_mut_confirm_bars_min: acMutConfirmBarsMin,
        auto_cal_mut_confirm_bars_max: acMutConfirmBarsMax,
        auto_cal_mut_confirm_bars_step: acMutConfirmBarsStep,
        auto_cal_mut_dwell_bars_min: acMutDwellBarsMin,
        auto_cal_mut_dwell_bars_max: acMutDwellBarsMax,
        auto_cal_mut_dwell_bars_step: acMutDwellBarsStep,
        story_recent_mins: stRecentMins,
        story_recent_color_min: stRecentColorMin,
        story_bounce_green_lo: stBounceGreenLo,
        story_bounce_green_hi: stBounceGreenHi,
        story_bounce_red_min: stBounceRedMin,
        story_dip_red_lo: stDipRedLo,
        story_dip_red_hi: stDipRedHi,
        story_dip_green_min: stDipGreenMin,
        minute_trend_bias_window_min: mtbTrendBiasWindowMin,
        minute_trend_bias_color_votes: mtbTrendBiasColorVotes,
        mind_pressure_delta: mindPressureDelta,
        mind_session_knife_soft_min: mindSessionKnifeSoftMin,
        mind_session_soft_losses_min: mindSessionSoftLossesMin,
        mind_session_soft_sized_min: mindSessionSoftSizedMin,
        mind_session_soft_cap_abs: mindSessionSoftCapAbs,
        entry_learner_override_margin: entryLearnerMargin,
        explore_step: nextStep + 30,
        last_lesson: `Explore tip+manage wires post_impulse=${flipPostImpulseTip} keep_owns=${flipPeakKeepOwns}`,
      },
      patches: [
        genomePatch('struct_half_lo', halfLo, `explore half_lo ${halfLo}`),
        genomePatch('struct_half_hi', halfHi, `explore half_hi ${halfHi}`),
        genomePatch('zone_band_cut_lo', zbLo, `explore zb_lo ${zbLo}`),
        genomePatch('zone_band_cut_mid_lo', zbMidLo, `explore zb_mid_lo ${zbMidLo}`),
        genomePatch('zone_band_cut_mid_hi', zbMidHi, `explore zb_mid_hi ${zbMidHi}`),
        genomePatch('zone_band_cut_hi', zbHi, `explore zb_hi ${zbHi}`),
        genomePatch('m1_aggregate_min_bars', m1AggBars, `explore m1_agg ${m1AggBars}`),
        genomePatch('minute_trend_bias_lookback', mtbLookback, `explore mtb_lookback ${mtbLookback}`),
        genomePatch(
          'minute_trend_bias_trek_min_path_bp',
          mtbPathBp,
          `explore mtb_path ${mtbPathBp}`
        ),
        genomePatch('breakout_pierce_pos_hi', pierceHi, `explore pierce_hi ${pierceHi}`),
        genomePatch('breakout_pierce_pos_lo', pierceLo, `explore pierce_lo ${pierceLo}`),
        genomePatch('failed_break_reclaim_pos_lo', reclaimLo, `explore reclaim_lo ${reclaimLo}`),
        genomePatch('failed_break_reclaim_pos_hi', reclaimHi, `explore reclaim_hi ${reclaimHi}`),
        genomePatch('compression_entry_pos_lo', compressLo, `explore compress_lo ${compressLo}`),
        genomePatch('compression_entry_pos_hi', compressHi, `explore compress_hi ${compressHi}`),
        genomePatch('exhaust_tip_chase_block', flipExhaustTip, `flip exhaust_tip ${flipExhaustTip}`),
        genomePatch(
          'entry_block_post_impulse_tip',
          flipPostImpulseTip,
          `flip post_impulse_tip ${flipPostImpulseTip}`
        ),
        genomePatch(
          'entry_post_impulse_share_min',
          postImpulseShare,
          `explore post_impulse_share ${postImpulseShare}`
        ),
        genomePatch(
          'entry_post_impulse_min_bars',
          postImpulseMinBars,
          `explore post_impulse_min_bars ${postImpulseMinBars}`
        ),
        genomePatch(
          'entry_post_impulse_zone_bars',
          postImpulseZoneBars,
          `explore post_impulse_zone_bars ${postImpulseZoneBars}`
        ),
        genomeArrayPatch(
          'entry_post_impulse_exempt_lanes',
          postImpulseExempt,
          `explore post_impulse_exempt toggle LIVE`
        ),
        genomePatch(
          'entry_tip_chase_trend_pullback',
          flipTipChaseTrend,
          `flip tip_chase_trend ${flipTipChaseTrend}`
        ),
        genomePatch(
          'entry_tip_block_finished_move',
          flipTipFinished,
          `flip tip_finished ${flipTipFinished}`
        ),
        genomePatch(
          'entry_trend_tip_require_reject',
          flipTrendTipReject,
          `flip trend_tip_reject ${flipTrendTipReject}`
        ),
        genomePatch(
          'peak_keep_genome_owns',
          flipPeakKeepOwns,
          `flip peak_keep_owns ${flipPeakKeepOwns}`
        ),
        genomePatch(
          'entry_learner_min_updates',
          entryLearnerMin,
          `explore entry_learner_min ${entryLearnerMin}`
        ),
        genomePatch(
          'entry_post_impulse_late_eff_min',
          postImpulseLateEff,
          `explore post_impulse_late_eff ${postImpulseLateEff}`
        ),
        genomePatch('mind_entry_conf_regime_hyp', entryConfRegimeHyp, `explore mind_regime_hyp ${entryConfRegimeHyp}`),
        genomePatch('mind_entry_conf_pb_wait', entryConfPbWait, `explore mind_pb_wait ${entryConfPbWait}`),
        genomePatch('mind_entry_conf_pb_resume_floor', entryConfPbResume, `explore mind_pb_resume ${entryConfPbResume}`),
        genomePatch('mind_entry_conf_story_side_floor', entryConfStorySide, `explore mind_story_side ${entryConfStorySide}`),
        genomePatch('mind_entry_conf_flip_after_loss', entryConfFlipLoss, `explore mind_flip_loss ${entryConfFlipLoss}`),
        genomePatch('mind_entry_conf_chop_wait', entryConfChopWait, `explore mind_chop_wait ${entryConfChopWait}`),
        genomePatch('mind_entry_conf_mixed_wait', entryConfMixedWait, `explore mind_mixed_wait ${entryConfMixedWait}`),
        genomePatch('mind_entry_conf_hard_veto', entryConfHardVeto, `explore mind_hard_veto ${entryConfHardVeto}`),
        genomePatch('mind_entry_conf_stack_fight', entryConfStackFight, `explore mind_stack_fight ${entryConfStackFight}`),
        genomePatch('mind_entry_conf_stack_chapter_wait', entryConfStackChapter, `explore mind_stack_chapter ${entryConfStackChapter}`),
        genomePatch('auto_cal_micro_win_vs_loss', acMicroWin, `explore ac_micro_win ${acMicroWin}`),
        genomePatch('auto_cal_high_mfe_vs_loss', acHighMfe, `explore ac_high_mfe ${acHighMfe}`),
        genomePatch('auto_cal_left_winner_e_max', acLeftWinnerE, `explore ac_left_winner_e ${acLeftWinnerE}`),
        genomePatch('auto_cal_asym_win_vs_loss', acAsym, `explore ac_asym ${acAsym}`),
        genomePatch('auto_cal_soft_dom_e_max', acSoftDomE, `explore ac_soft_dom_e ${acSoftDomE}`),
        genomePatch('auto_cal_soft_dom_win_vs_loss', acSoftDomWin, `explore ac_soft_dom_win ${acSoftDomWin}`),
        genomePatch('auto_cal_ease_filter_e_min', acEaseFilterE, `explore ac_ease_filter_e ${acEaseFilterE}`),
        genomePatch('auto_cal_legacy_raise_e_max', acLegacyE, `explore ac_legacy_e ${acLegacyE}`),
        genomePatch('auto_cal_legacy_raise_win_vs_loss', acLegacyWin, `explore ac_legacy_win ${acLegacyWin}`),
        genomePatch('auto_cal_soft_tight_e_max', acSoftTightE, `explore ac_soft_tight_e ${acSoftTightE}`),
        genomePatch('auto_cal_healthy_e_min', acHealthyE, `explore ac_healthy_e ${acHealthyE}`),
        genomePatch('auto_cal_healthy_win_vs_loss', acHealthyWin, `explore ac_healthy_win ${acHealthyWin}`),
        genomePatch('auto_cal_target_ease_abs', acTargetEase, `explore ac_tgt_ease ${acTargetEase}`),
        genomePatch('auto_cal_target_pct_ease_div', acTargetPctEase, `explore ac_tgt_pct_ease ${acTargetPctEase}`),
        genomePatch('auto_cal_peak_raise_abs', acPeakRaise, `explore ac_peak_raise ${acPeakRaise}`),
        genomePatch('auto_cal_target_raise_abs', acTargetRaise, `explore ac_tgt_raise ${acTargetRaise}`),
        genomePatch('auto_cal_target_pct_raise_mult', acTargetPctRaise, `explore ac_tgt_pct_raise ${acTargetPctRaise}`),
        genomePatch('auto_cal_peak_pct_raise_mult', acPeakPctRaise, `explore ac_peak_pct_raise ${acPeakPctRaise}`),
        genomePatch('auto_cal_giveback_raise_abs', acGivebackRaise, `explore ac_gb_raise ${acGivebackRaise}`),
        genomePatch('auto_cal_healthy_keep_step', acHealthyKeep, `explore ac_healthy_keep ${acHealthyKeep}`),
        genomePatch('auto_cal_let_winners_e_min', acLetWinnersE, `explore ac_let_winners_e ${acLetWinnersE}`),
        genomePatch('auto_cal_choppy_ctx_min', acChoppyCtx, `explore ac_choppy_ctx ${acChoppyCtx}`),
        genomePatch('auto_cal_choppy_e_max', acChoppyE, `explore ac_choppy_e ${acChoppyE}`),
        genomePatch('auto_cal_neg_e_align_max', acNegAlign, `explore ac_neg_align ${acNegAlign}`),
        genomePatch('auto_cal_expand_ctx_min', acExpandCtx, `explore ac_expand_ctx ${acExpandCtx}`),
        genomePatch('auto_cal_expand_e_min', acExpandE, `explore ac_expand_e ${acExpandE}`),
        genomePatch('auto_cal_choppy_dwell_e_max', acChoppyDwellE, `explore ac_choppy_dwell_e ${acChoppyDwellE}`),
        genomePatch('auto_cal_fight_ctx_min', acFightCtx, `explore ac_fight_ctx ${acFightCtx}`),
        genomePatch('auto_cal_fight_e_max', acFightE, `explore ac_fight_e ${acFightE}`),
        genomePatch('auto_cal_soft_dom_loss_count_min', acSoftDomLossN, `explore ac_soft_dom_loss_n ${acSoftDomLossN}`),
        genomePatch('auto_cal_soft_dom_loss_vs_hardinv', acSoftDomLossVs, `explore ac_soft_dom_loss_vs ${acSoftDomLossVs}`),
        genomePatch('auto_cal_demote_recover_e_min', acDemoteRecoverE, `explore ac_demote_recover_e ${acDemoteRecoverE}`),
        genomePatch('auto_cal_soft_loss_abs_floor', acSoftLossAbsFloor, `explore ac_soft_loss_abs_floor ${acSoftLossAbsFloor}`),
        genomePatch('auto_cal_micro_win_abs_floor', acMicroWinAbsFloor, `explore ac_micro_win_abs_floor ${acMicroWinAbsFloor}`),
        genomePatch('auto_cal_peak_exits_min', acPeakExitsMin, `explore ac_peak_exits_min ${acPeakExitsMin}`),
        genomePatch('auto_cal_high_mfe_tiny_count_min', acHighMfeTinyCountMin, `explore ac_high_mfe_tiny_count_min ${acHighMfeTinyCountMin}`),
        genomePatch('auto_cal_micro_wins_min', acMicroWinsMin, `explore ac_micro_wins_min ${acMicroWinsMin}`),
        genomePatch('auto_cal_avg_loss_abs_floor', acAvgLossAbsFloor, `explore ac_avg_loss_abs_floor ${acAvgLossAbsFloor}`),
        genomePatch('auto_cal_already_tall_soft_mult', acAlreadyTallSoftMult, `explore ac_already_tall_soft_mult ${acAlreadyTallSoftMult}`),
        genomePatch('auto_cal_soft_tight_soft_losses_min', acSoftTightSoftLossesMin, `explore ac_soft_tight_soft_losses_min ${acSoftTightSoftLossesMin}`),
        genomePatch('auto_cal_soft_tight_high_mfe_min', acSoftTightHighMfeMin, `explore ac_soft_tight_high_mfe_min ${acSoftTightHighMfeMin}`),
        genomePatch('auto_cal_soft_tight_hardinv_max', acSoftTightHardinvMax, `explore ac_soft_tight_hardinv_max ${acSoftTightHardinvMax}`),
        genomePatch('auto_cal_regime_promote_n_min', acRegimePromoteNMin, `explore ac_regime_promote_n_min ${acRegimePromoteNMin}`),
        genomePatch('auto_cal_regime_promote_sum_min', acRegimePromoteSumMin, `explore ac_regime_promote_sum_min ${acRegimePromoteSumMin}`),
        genomePatch('auto_cal_regime_keep_n_max', acRegimeKeepNMax, `explore ac_regime_keep_n_max ${acRegimeKeepNMax}`),
        genomePatch('auto_cal_regime_keep_sum_min', acRegimeKeepSumMin, `explore ac_regime_keep_sum_min ${acRegimeKeepSumMin}`),
        genomePatch('auto_cal_regime_demote_sum_max', acRegimeDemoteSumMax, `explore ac_regime_demote_sum_max ${acRegimeDemoteSumMax}`),
        genomePatch('auto_cal_mut_soft_plus_giveback_step', acMutSoftPlusGivebackStep, `explore ac_mut_soft_plus_giveback_step ${acMutSoftPlusGivebackStep}`),
        genomePatch('auto_cal_mut_peak_arm_step', acMutPeakArmStep, `explore ac_mut_peak_arm_step ${acMutPeakArmStep}`),
        genomePatch('auto_cal_mut_soft_layer_unlock_step', acMutSoftLayerUnlockStep, `explore ac_mut_soft_layer_unlock_step ${acMutSoftLayerUnlockStep}`),
        genomePatch('auto_cal_mut_pb_episode_arm_step', acMutPbEpisodeArmStep, `explore ac_mut_pb_episode_arm_step ${acMutPbEpisodeArmStep}`),
        genomePatch('auto_cal_mut_pb_episode_mfe_step', acMutPbEpisodeMfeStep, `explore ac_mut_pb_episode_mfe_step ${acMutPbEpisodeMfeStep}`),
        genomePatch('auto_cal_mut_soft_plus_runner_step', acMutSoftPlusRunnerStep, `explore ac_mut_soft_plus_runner_step ${acMutSoftPlusRunnerStep}`),
        genomePatch('auto_cal_mut_soft_plus_leg_step', acMutSoftPlusLegStep, `explore ac_mut_soft_plus_leg_step ${acMutSoftPlusLegStep}`),
        genomePatch('auto_cal_mut_soft_plus_giveback_min', acMutSoftPlusGivebackMin, `explore ac_mut_soft_plus_giveback_min ${acMutSoftPlusGivebackMin}`),
        genomePatch('auto_cal_mut_soft_plus_giveback_max', acMutSoftPlusGivebackMax, `explore ac_mut_soft_plus_giveback_max ${acMutSoftPlusGivebackMax}`),
        genomePatch('auto_cal_mut_peak_arm_min', acMutPeakArmMin, `explore ac_mut_peak_arm_min ${acMutPeakArmMin}`),
        genomePatch('auto_cal_mut_peak_arm_max', acMutPeakArmMax, `explore ac_mut_peak_arm_max ${acMutPeakArmMax}`),
        genomePatch('auto_cal_mut_soft_layer_unlock_min', acMutSoftLayerUnlockMin, `explore ac_mut_soft_layer_unlock_min ${acMutSoftLayerUnlockMin}`),
        genomePatch('auto_cal_mut_soft_layer_unlock_max', acMutSoftLayerUnlockMax, `explore ac_mut_soft_layer_unlock_max ${acMutSoftLayerUnlockMax}`),
        genomePatch('auto_cal_mut_pb_episode_arm_min', acMutPbEpisodeArmMin, `explore ac_mut_pb_episode_arm_min ${acMutPbEpisodeArmMin}`),
        genomePatch('auto_cal_mut_pb_episode_arm_max', acMutPbEpisodeArmMax, `explore ac_mut_pb_episode_arm_max ${acMutPbEpisodeArmMax}`),
        genomePatch('auto_cal_mut_pb_episode_mfe_min', acMutPbEpisodeMfeMin, `explore ac_mut_pb_episode_mfe_min ${acMutPbEpisodeMfeMin}`),
        genomePatch('auto_cal_mut_pb_episode_mfe_max', acMutPbEpisodeMfeMax, `explore ac_mut_pb_episode_mfe_max ${acMutPbEpisodeMfeMax}`),
        genomePatch('auto_cal_mut_soft_plus_runner_min', acMutSoftPlusRunnerMin, `explore ac_mut_soft_plus_runner_min ${acMutSoftPlusRunnerMin}`),
        genomePatch('auto_cal_mut_soft_plus_runner_max', acMutSoftPlusRunnerMax, `explore ac_mut_soft_plus_runner_max ${acMutSoftPlusRunnerMax}`),
        genomePatch('auto_cal_mut_soft_plus_leg_min', acMutSoftPlusLegMin, `explore ac_mut_soft_plus_leg_min ${acMutSoftPlusLegMin}`),
        genomePatch('auto_cal_mut_soft_plus_leg_max', acMutSoftPlusLegMax, `explore ac_mut_soft_plus_leg_max ${acMutSoftPlusLegMax}`),
        genomePatch('auto_cal_range_soft_min', acRangeSoftMin, `explore ac_range_soft_min ${acRangeSoftMin}`),
        genomePatch('auto_cal_range_wins_min', acRangeWinsMin, `explore ac_range_wins_min ${acRangeWinsMin}`),
        genomePatch('auto_cal_pb_soft_min', acPbSoftMin, `explore ac_pb_soft_min ${acPbSoftMin}`),
        genomePatch('auto_cal_mut_range_chop_down', acMutRangeChopDown, `explore ac_mut_range_chop_down ${acMutRangeChopDown}`),
        genomePatch('auto_cal_mut_range_share_down', acMutRangeShareDown, `explore ac_mut_range_share_down ${acMutRangeShareDown}`),
        genomePatch('auto_cal_mut_range_eff_down', acMutRangeEffDown, `explore ac_mut_range_eff_down ${acMutRangeEffDown}`),
        genomePatch('auto_cal_mut_range_chop_up', acMutRangeChopUp, `explore ac_mut_range_chop_up ${acMutRangeChopUp}`),
        genomePatch('auto_cal_mut_range_chop_min', acMutRangeChopMin, `explore ac_mut_range_chop_min ${acMutRangeChopMin}`),
        genomePatch('auto_cal_mut_range_chop_max', acMutRangeChopMax, `explore ac_mut_range_chop_max ${acMutRangeChopMax}`),
        genomePatch('auto_cal_mut_range_share_min', acMutRangeShareMin, `explore ac_mut_range_share_min ${acMutRangeShareMin}`),
        genomePatch('auto_cal_mut_range_share_max', acMutRangeShareMax, `explore ac_mut_range_share_max ${acMutRangeShareMax}`),
        genomePatch('auto_cal_mut_range_eff_min', acMutRangeEffMin, `explore ac_mut_range_eff_min ${acMutRangeEffMin}`),
        genomePatch('auto_cal_mut_range_eff_max', acMutRangeEffMax, `explore ac_mut_range_eff_max ${acMutRangeEffMax}`),
        genomePatch('auto_cal_same_side_pause_max', acSameSidePauseMax, `explore ac_same_side_pause_max ${acSameSidePauseMax}`),
        genomePatch('auto_cal_same_side_pause_soft_min', acSameSidePauseSoftMin, `explore ac_same_side_pause_soft_min ${acSameSidePauseSoftMin}`),
        genomePatch('auto_cal_same_side_pause_step', acSameSidePauseStep, `explore ac_same_side_pause_step ${acSameSidePauseStep}`),
        genomePatch('auto_cal_choppy_green_lo', acChoppyGreenLo, `explore ac_choppy_green_lo ${acChoppyGreenLo}`),
        genomePatch('auto_cal_choppy_green_hi', acChoppyGreenHi, `explore ac_choppy_green_hi ${acChoppyGreenHi}`),
        genomePatch('auto_cal_mut_trek_flat_mult', acMutTrekFlatMult, `explore ac_mut_trek_flat_mult ${acMutTrekFlatMult}`),
        genomePatch('auto_cal_mut_trek_flat_min', acMutTrekFlatMin, `explore ac_mut_trek_flat_min ${acMutTrekFlatMin}`),
        genomePatch('auto_cal_mut_trek_flat_max', acMutTrekFlatMax, `explore ac_mut_trek_flat_max ${acMutTrekFlatMax}`),
        genomePatch('auto_cal_mut_story_conf_step', acMutStoryConfStep, `explore ac_mut_story_conf_step ${acMutStoryConfStep}`),
        genomePatch('auto_cal_mut_story_conf_min', acMutStoryConfMin, `explore ac_mut_story_conf_min ${acMutStoryConfMin}`),
        genomePatch('auto_cal_mut_story_conf_max', acMutStoryConfMax, `explore ac_mut_story_conf_max ${acMutStoryConfMax}`),
        genomePatch('auto_cal_mut_confirm_bars_min', acMutConfirmBarsMin, `explore ac_mut_confirm_bars_min ${acMutConfirmBarsMin}`),
        genomePatch('auto_cal_mut_confirm_bars_max', acMutConfirmBarsMax, `explore ac_mut_confirm_bars_max ${acMutConfirmBarsMax}`),
        genomePatch('auto_cal_mut_confirm_bars_step', acMutConfirmBarsStep, `explore ac_mut_confirm_bars_step ${acMutConfirmBarsStep}`),
        genomePatch('auto_cal_mut_dwell_bars_min', acMutDwellBarsMin, `explore ac_mut_dwell_bars_min ${acMutDwellBarsMin}`),
        genomePatch('auto_cal_mut_dwell_bars_max', acMutDwellBarsMax, `explore ac_mut_dwell_bars_max ${acMutDwellBarsMax}`),
        genomePatch('auto_cal_mut_dwell_bars_step', acMutDwellBarsStep, `explore ac_mut_dwell_bars_step ${acMutDwellBarsStep}`),
        genomePatch('story_recent_mins', stRecentMins, `explore story_recent_mins ${stRecentMins}`),
        genomePatch('story_recent_color_min', stRecentColorMin, `explore story_recent_color_min ${stRecentColorMin}`),
        genomePatch('story_bounce_green_lo', stBounceGreenLo, `explore story_bounce_green_lo ${stBounceGreenLo}`),
        genomePatch('story_bounce_green_hi', stBounceGreenHi, `explore story_bounce_green_hi ${stBounceGreenHi}`),
        genomePatch('story_bounce_red_min', stBounceRedMin, `explore story_bounce_red_min ${stBounceRedMin}`),
        genomePatch('story_dip_red_lo', stDipRedLo, `explore story_dip_red_lo ${stDipRedLo}`),
        genomePatch('story_dip_red_hi', stDipRedHi, `explore story_dip_red_hi ${stDipRedHi}`),
        genomePatch('story_dip_green_min', stDipGreenMin, `explore story_dip_green_min ${stDipGreenMin}`),
        genomePatch('minute_trend_bias_window_min', mtbTrendBiasWindowMin, `explore mtb_window_min ${mtbTrendBiasWindowMin}`),
        genomePatch('minute_trend_bias_color_votes', mtbTrendBiasColorVotes, `explore mtb_color_votes ${mtbTrendBiasColorVotes}`),
        genomePatch('mind_pressure_delta', mindPressureDelta, `explore mind_pressure_delta ${mindPressureDelta}`),
        genomePatch('mind_session_knife_soft_min', mindSessionKnifeSoftMin, `explore mind_knife_soft_min ${mindSessionKnifeSoftMin}`),
        genomePatch('mind_session_soft_losses_min', mindSessionSoftLossesMin, `explore mind_soft_losses_min ${mindSessionSoftLossesMin}`),
        genomePatch('mind_session_soft_sized_min', mindSessionSoftSizedMin, `explore mind_soft_sized_min ${mindSessionSoftSizedMin}`),
        genomePatch('mind_session_soft_cap_abs', mindSessionSoftCapAbs, `explore mind_soft_cap_abs ${mindSessionSoftCapAbs}`),
        genomePatch(
          'entry_learner_override_margin',
          entryLearnerMargin,
          `explore entry_learner_margin ${entryLearnerMargin}`
        ),
        genomePatch('explore_step', nextStep + 30, `explore_step ${nextStep + 30}`),
      ],
    },
    {
      title: `Explore story→path${storyPathBp} chase${chaseEdge} (step #${nextStep + 31})`,
      rationale: 'Bounce story path, chase edge, trek firm, struct pos, chapter conf.',
      task: `story_path=${storyPathBp} conf_min=${storyConfMin} trek=${trekFirm}`,
      genome_delta: {
        story_min_path_bp: storyPathBp,
        story_conf_min: storyConfMin,
        chase_edge: chaseEdge,
        trek_firm_mult: trekFirm,
        story_sell_struct_pos: storySellPos,
        story_buy_struct_pos: storyBuyPos,
        bounce_dip_color_delta: bounceDipDelta,
        exhaust_pos_lo: exhaustLo,
        exhaust_pos_hi: exhaustHi,
        story_conf_break: scBreak,
        story_conf_bounce_dip: scBounce,
        story_conf_struct: scStruct,
        story_conf_recent: scRecent,
        story_conf_chop_thin: scChopThin,
        story_conf_chop: scChop,
        scalp_wick_confirm: flipScalpWick,
        explore_step: nextStep + 31,
        last_lesson: `Explore story path ${storyPathBp}`,
      },
      patches: [
        genomePatch('story_min_path_bp', storyPathBp, `explore story_path ${storyPathBp}`),
        genomePatch('story_conf_min', storyConfMin, `explore story_conf_min ${storyConfMin}`),
        genomePatch('chase_edge', chaseEdge, `explore chase_edge ${chaseEdge}`),
        genomePatch('trek_firm_mult', trekFirm, `explore trek_firm ${trekFirm}`),
        genomePatch('story_sell_struct_pos', storySellPos, `explore sell_pos ${storySellPos}`),
        genomePatch('story_buy_struct_pos', storyBuyPos, `explore buy_pos ${storyBuyPos}`),
        genomePatch('bounce_dip_color_delta', bounceDipDelta, `explore bounce_dip ${bounceDipDelta}`),
        genomePatch('exhaust_pos_lo', exhaustLo, `explore exhaust_lo ${exhaustLo}`),
        genomePatch('exhaust_pos_hi', exhaustHi, `explore exhaust_hi ${exhaustHi}`),
        genomePatch('story_conf_break', scBreak, `explore sc_break ${scBreak}`),
        genomePatch('story_conf_bounce_dip', scBounce, `explore sc_bounce ${scBounce}`),
        genomePatch('story_conf_struct', scStruct, `explore sc_struct ${scStruct}`),
        genomePatch('story_conf_recent', scRecent, `explore sc_recent ${scRecent}`),
        genomePatch('story_conf_chop_thin', scChopThin, `explore sc_chop_thin ${scChopThin}`),
        genomePatch('story_conf_chop', scChop, `explore sc_chop ${scChop}`),
        genomePatch('scalp_wick_confirm', flipScalpWick, `flip scalp_wick ${flipScalpWick}`),
        genomePatch('explore_step', nextStep + 31, `explore_step ${nextStep + 31}`),
      ],
    },
    {
      title: `Explore market context→vel${velLookback} (step #${nextStep + 32})`,
      rationale: 'Bounce expanding/compressed range, velocity, pressure fight, storyfight Soft+.',
      task: `expand=${expandRange} compress=${compressRange} vel=${velLookback}`,
      genome_delta: {
        expanding_range_mult: expandRange,
        compressed_range_mult: compressRange,
        velocity_lookback: velLookback,
        pressure_fight_green_buy: pressFightBuy,
        pressure_fight_green_sell: pressFightSell,
        softplus_storyfight_exec_fav_mult: spStoryExec,
        softplus_storyfight_min_mfe_mult: spStoryMfe,
        softplus_pullback_story_exec_mult: spPbStory,
        explore_step: nextStep + 32,
        last_lesson: `Explore market context vel=${velLookback}`,
      },
      patches: [
        genomePatch('expanding_range_mult', expandRange, `explore expand_range ${expandRange}`),
        genomePatch('compressed_range_mult', compressRange, `explore compress_range ${compressRange}`),
        genomePatch('velocity_lookback', velLookback, `explore velocity ${velLookback}`),
        genomePatch('pressure_fight_green_buy', pressFightBuy, `explore press_buy ${pressFightBuy}`),
        genomePatch('pressure_fight_green_sell', pressFightSell, `explore press_sell ${pressFightSell}`),
        genomePatch('softplus_storyfight_exec_fav_mult', spStoryExec, `explore sp_story_exec ${spStoryExec}`),
        genomePatch('softplus_storyfight_min_mfe_mult', spStoryMfe, `explore sp_story_mfe ${spStoryMfe}`),
        genomePatch('softplus_pullback_story_exec_mult', spPbStory, `explore sp_pb_story ${spPbStory}`),
        genomePatch('explore_step', nextStep + 32, `explore_step ${nextStep + 32}`),
      ],
    },
    {
      title: `Explore mind residuals→green${greenSoftArm} (step #${nextStep + 33})`,
      rationale: 'Bounce mind green arm, deep giveback, against-us, session E bank.',
      task: `green=${greenSoftArm} deep=${deepGbOff} sess_cut=${sessExpCut}`,
      genome_delta: {
        green_soft_arm_mult: greenSoftArm,
        deep_giveback_offset: deepGbOff,
        against_us_soft_mult_hi: againstUsHi,
        against_us_soft_mult_lo: againstUsLo,
        session_expectancy_cut: sessExpCut,
        mind_entry_conf_base: mindEntryBase,
        left_on_table_peak_tiny_min: leftTinyMin,
        soft_sized_loss_frac: softSizedLoss,
        session_e_bank_hi: sessEBankHi,
        session_e_bank_lo: sessEBankLo,
        explore_step: nextStep + 33,
        last_lesson: `Explore mind residuals green=${greenSoftArm}`,
      },
      patches: [
        genomePatch('green_soft_arm_mult', greenSoftArm, `explore green_soft ${greenSoftArm}`),
        genomePatch('deep_giveback_offset', deepGbOff, `explore deep_gb ${deepGbOff}`),
        genomePatch('against_us_soft_mult_hi', againstUsHi, `explore against_hi ${againstUsHi}`),
        genomePatch('against_us_soft_mult_lo', againstUsLo, `explore against_lo ${againstUsLo}`),
        genomePatch('session_expectancy_cut', sessExpCut, `explore sess_cut ${sessExpCut}`),
        genomePatch('mind_entry_conf_base', mindEntryBase, `explore mind_entry ${mindEntryBase}`),
        genomePatch('left_on_table_peak_tiny_min', leftTinyMin, `explore left_tiny ${leftTinyMin}`),
        genomePatch('soft_sized_loss_frac', softSizedLoss, `explore soft_sized ${softSizedLoss}`),
        genomePatch('session_e_bank_hi', sessEBankHi, `explore sess_e_hi ${sessEBankHi}`),
        genomePatch('session_e_bank_lo', sessEBankLo, `explore sess_e_lo ${sessEBankLo}`),
        genomePatch('explore_step', nextStep + 33, `explore_step ${nextStep + 33}`),
      ],
    },
    {
      title: `Explore ManageBrain scores (step #${nextStep + 34})`,
      rationale: 'Bounce manage_min_sample, manage_score_* family, pressure_with_us.',
      task: `manage_min=${manageMinSample} clamp=${msClamp} near_tgt=${nearTgtBank}`,
      genome_delta: {
        manage_min_sample: manageMinSample,
        manage_score_session_e_neg: msSessNeg,
        manage_score_session_e_pos: msSessPos,
        manage_score_window_e_neg: msWinNeg,
        manage_score_path_soft_green: msPathGreen,
        manage_score_path_giveback: msPathGb,
        manage_score_m1_reverse: msM1Rev,
        manage_score_m1_continue: msM1Cont,
        manage_score_next_entry_opp: msNextOpp,
        manage_score_thesis_fight: msThesis,
        pressure_with_us_buy: pressWithBuy,
        pressure_with_us_sell: pressWithSell,
        near_target_lean_bank: nearTgtBank,
        manage_score_clamp: msClamp,
        manage_learner_override_margin: manageLearnerMargin,
        peak_mfe_floor_ease: peakMfeEase,
        explore_step: nextStep + 34,
        last_lesson: `Explore ManageBrain clamp=${msClamp}`,
      },
      patches: [
        genomePatch('manage_min_sample', manageMinSample, `explore manage_min ${manageMinSample}`),
        genomePatch('manage_score_session_e_neg', msSessNeg, `explore ms_sess_neg ${msSessNeg}`),
        genomePatch('manage_score_session_e_pos', msSessPos, `explore ms_sess_pos ${msSessPos}`),
        genomePatch('manage_score_window_e_neg', msWinNeg, `explore ms_win_neg ${msWinNeg}`),
        genomePatch('manage_score_path_soft_green', msPathGreen, `explore ms_path_green ${msPathGreen}`),
        genomePatch('manage_score_path_giveback', msPathGb, `explore ms_path_gb ${msPathGb}`),
        genomePatch('manage_score_m1_reverse', msM1Rev, `explore ms_m1_rev ${msM1Rev}`),
        genomePatch('manage_score_m1_continue', msM1Cont, `explore ms_m1_cont ${msM1Cont}`),
        genomePatch('manage_score_next_entry_opp', msNextOpp, `explore ms_next_opp ${msNextOpp}`),
        genomePatch('manage_score_thesis_fight', msThesis, `explore ms_thesis ${msThesis}`),
        genomePatch('pressure_with_us_buy', pressWithBuy, `explore press_with_buy ${pressWithBuy}`),
        genomePatch('pressure_with_us_sell', pressWithSell, `explore press_with_sell ${pressWithSell}`),
        genomePatch('near_target_lean_bank', nearTgtBank, `explore near_tgt ${nearTgtBank}`),
        genomePatch('manage_score_clamp', msClamp, `explore ms_clamp ${msClamp}`),
        genomePatch(
          'manage_learner_override_margin',
          manageLearnerMargin,
          `explore manage_margin ${manageLearnerMargin}`
        ),
        genomePatch('peak_mfe_floor_ease', peakMfeEase, `explore peak_mfe_ease ${peakMfeEase}`),
        genomePatch('explore_step', nextStep + 34, `explore_step ${nextStep + 34}`),
      ],
    },
    {
      title: `Explore strong/fade→htf${strongHtfMin} (step #${nextStep + 35})`,
      rationale: 'Bounce strong_htf_aligned_min; toggle fade_allowed_chapters.',
      task: `strong_htf=${strongHtfMin} fade_chapters toggle`,
      genome_delta: {
        strong_htf_aligned_min: strongHtfMin,
        fade_allowed_chapters: fadeChapters,
        explore_step: nextStep + 35,
        last_lesson: `Explore strong/fade htf=${strongHtfMin}`,
      },
      patches: [
        genomePatch('strong_htf_aligned_min', strongHtfMin, `explore strong_htf ${strongHtfMin}`),
        genomeArrayPatch('fade_allowed_chapters', fadeChapters, `explore fade_chapters toggle`),
        genomePatch('explore_step', nextStep + 35, `explore_step ${nextStep + 35}`),
      ],
    },
    {
      title: `Explore regimes zone/trek (step #${nextStep + 36})`,
      rationale: 'Bounce zone_bars, trek full/recent, regime_conf ladder.',
      task: `zone=${zoneBars}/${minZoneBars} trek_full=${trekFullEnter} recent=${trekRecentEnter}`,
      genome_delta: {
        zone_bars: zoneBars,
        min_bars_for_zone: minZoneBars,
        switch_gap_bars: switchGap,
        local_breakout_frac_floor: localBreakFloor,
        trek_full_enter_mult: trekFullEnter,
        trek_recent_enter_mult: trekRecentEnter,
        trek_recent_share_min: trekRecentShare,
        regime_conf_base: regConfBase,
        regime_conf_strength_scale: regConfScale,
        regime_conf_min: regConfMin,
        regime_conf_max: regConfMax,
        book_confidence_floor_after_switch: bookConfFloor,
        enabled_regimes: enabledRegimes,
        soft_off_regimes: softOffRegimes,
        explore_step: nextStep + 36,
        last_lesson: `Explore regimes zone=${zoneBars}`,
      },
      patches: [
        genomePatch('zone_bars', zoneBars, `explore zone_bars ${zoneBars}`),
        genomePatch('min_bars_for_zone', minZoneBars, `explore min_zone ${minZoneBars}`),
        genomePatch('switch_gap_bars', switchGap, `explore switch_gap ${switchGap}`),
        genomePatch('local_breakout_frac_floor', localBreakFloor, `explore local_break ${localBreakFloor}`),
        genomePatch('trek_full_enter_mult', trekFullEnter, `explore trek_full ${trekFullEnter}`),
        genomePatch('trek_recent_enter_mult', trekRecentEnter, `explore trek_recent ${trekRecentEnter}`),
        genomePatch('trek_recent_share_min', trekRecentShare, `explore trek_recent_share ${trekRecentShare}`),
        genomePatch('regime_conf_base', regConfBase, `explore reg_conf_base ${regConfBase}`),
        genomePatch('regime_conf_strength_scale', regConfScale, `explore reg_conf_scale ${regConfScale}`),
        genomePatch('regime_conf_min', regConfMin, `explore reg_conf_min ${regConfMin}`),
        genomePatch('regime_conf_max', regConfMax, `explore reg_conf_max ${regConfMax}`),
        genomePatch(
          'book_confidence_floor_after_switch',
          bookConfFloor,
          `explore book_conf_floor ${bookConfFloor}`
        ),
        genomeArrayPatch('enabled_regimes', enabledRegimes, `explore enabled_regimes toggle`),
        genomeArrayPatch('soft_off_regimes', softOffRegimes, `explore soft_off toggle`),
        genomePatch('explore_step', nextStep + 36, `explore_step ${nextStep + 36}`),
      ],
    },
    {
      title: `Explore regimes flags/chop (step #${nextStep + 37})`,
      rationale:
        'Toggle sticky_prior, transition, one-market/SIDE/HTF gates, reversal-from-breakout.',
      task: `soft_move=${flipSoftMoveShortcut} one_market=${flipOneMarket} chop_trend=${chopToTrend}`,
      genome_delta: {
        soft_move_trek_pullback_shortcut: flipSoftMoveShortcut,
        chop_to_trend_confirm_bars: chopToTrend,
        sticky_prior_enabled: flipStickyPrior,
        transition_detect_enabled: flipTransition,
        playbook_promote_vs_live_unify: flipPlaybookUnify,
        playbook_require_full_htf_stack: flipRequireFullHtf,
        playbook_block_htf_promote_on_live_chop: flipBlockHtfChop,
        playbook_block_story_promote_on_live_chop: flipBlockStoryChop,
        playbook_chop_overrides_sticky_trend: flipChopOverrideTrend,
        reversal_from_breakout_prior: flipRevFromBreak,
        playbook_one_market_truth: flipOneMarket,
        playbook_break_overrides_sticky_trend: flipBreakOverTrend,
        playbook_htf_require_unanimous: flipHtfUnanimous,
        entry_require_regime_setup: flipRequireSetup,
        regime_runner_enabled: flipRegimeRunner,
        regime_runner_score: runnerScore,
        regime_runner_active_min_score: runnerMinScore,
        regime_runner_eval_every_n: runnerEvalN,
        regime_runner_deduct_pts: runnerDeduct,
        regime_runner_recover_pts: runnerRecover,
        regime_runner_min_target_layer: runnerMinLayer,
        regime_runner_success_mfe_retain: runnerRetain,
        regime_runner_eligible_regimes: runnerEligible,
        expansion_before_trend: flipExpansionBefore,
        core_always_on_regimes: coreAlwaysOn,
        explore_step: nextStep + 37,
        last_lesson: `Explore regimes flags one_market=${flipOneMarket} runner=${flipRegimeRunner}`,
      },
      patches: [
        genomePatch(
          'soft_move_trek_pullback_shortcut',
          flipSoftMoveShortcut,
          `flip soft_move_shortcut ${flipSoftMoveShortcut}`
        ),
        genomePatch('chop_to_trend_confirm_bars', chopToTrend, `explore chop_trend ${chopToTrend}`),
        genomePatch('sticky_prior_enabled', flipStickyPrior, `flip sticky_prior ${flipStickyPrior}`),
        genomePatch(
          'transition_detect_enabled',
          flipTransition,
          `flip transition_detect ${flipTransition}`
        ),
        genomePatch(
          'playbook_promote_vs_live_unify',
          flipPlaybookUnify,
          `flip playbook_unify ${flipPlaybookUnify}`
        ),
        genomePatch(
          'playbook_require_full_htf_stack',
          flipRequireFullHtf,
          `flip require_full_htf ${flipRequireFullHtf}`
        ),
        genomePatch(
          'playbook_block_htf_promote_on_live_chop',
          flipBlockHtfChop,
          `flip block_htf_chop ${flipBlockHtfChop}`
        ),
        genomePatch(
          'playbook_block_story_promote_on_live_chop',
          flipBlockStoryChop,
          `flip block_story_chop ${flipBlockStoryChop}`
        ),
        genomePatch(
          'playbook_chop_overrides_sticky_trend',
          flipChopOverrideTrend,
          `flip chop_override_trend ${flipChopOverrideTrend}`
        ),
        genomePatch(
          'reversal_from_breakout_prior',
          flipRevFromBreak,
          `flip rev_from_break ${flipRevFromBreak}`
        ),
        genomePatch(
          'playbook_one_market_truth',
          flipOneMarket,
          `flip one_market ${flipOneMarket}`
        ),
        genomePatch(
          'playbook_break_overrides_sticky_trend',
          flipBreakOverTrend,
          `flip break_over_trend ${flipBreakOverTrend}`
        ),
        genomePatch(
          'playbook_htf_require_unanimous',
          flipHtfUnanimous,
          `flip htf_unanimous ${flipHtfUnanimous}`
        ),
        genomePatch(
          'entry_require_regime_setup',
          flipRequireSetup,
          `flip require_setup ${flipRequireSetup}`
        ),
        genomePatch(
          'regime_runner_enabled',
          flipRegimeRunner,
          `flip regime_runner ${flipRegimeRunner}`
        ),
        genomePatch('regime_runner_score', runnerScore, `explore runner_score ${runnerScore}`),
        genomePatch(
          'regime_runner_active_min_score',
          runnerMinScore,
          `explore runner_min_score ${runnerMinScore}`
        ),
        genomePatch(
          'regime_runner_eval_every_n',
          runnerEvalN,
          `explore runner_eval_n ${runnerEvalN}`
        ),
        genomePatch(
          'regime_runner_deduct_pts',
          runnerDeduct,
          `explore runner_deduct ${runnerDeduct}`
        ),
        genomePatch(
          'regime_runner_recover_pts',
          runnerRecover,
          `explore runner_recover ${runnerRecover}`
        ),
        genomePatch(
          'regime_runner_min_target_layer',
          runnerMinLayer,
          `explore runner_min_layer ${runnerMinLayer}`
        ),
        genomePatch(
          'regime_runner_success_mfe_retain',
          runnerRetain,
          `explore runner_retain ${runnerRetain}`
        ),
        genomeArrayPatch(
          'regime_runner_eligible_regimes',
          runnerEligible,
          `explore runner_eligible toggle EXPANSION`
        ),
        genomePatch(
          'expansion_before_trend',
          flipExpansionBefore,
          `flip expansion_before ${flipExpansionBefore}`
        ),
        genomeArrayPatch('core_always_on_regimes', coreAlwaysOn, `explore core_always_on toggle`),
        genomePatch('explore_step', nextStep + 37, `explore_step ${nextStep + 37}`),
      ],
    },
    {
      title: `Explore pullback episodes (step #${nextStep + 38})`,
      rationale: 'Toggle adverse/resume chapters; keep trend_thesis_regimes; episode bank mult.',
      task: `trend_thesis keep; adverse/resume toggle; episode_end=${flipEpisodeEnd}`,
      genome_delta: {
        trend_thesis_regimes: trendThesis,
        adverse_chapters_sell: adverseSell,
        adverse_chapters_buy: adverseBuy,
        resume_chapters_sell: resumeSell,
        resume_chapters_buy: resumeBuy,
        episode_end_on_continue: flipEpisodeEnd,
        episode_softplus_bank_mult: episodeSpBank,
        explore_step: nextStep + 38,
        last_lesson: `Explore pullback episodes bank=${episodeSpBank}`,
      },
      patches: [
        genomeArrayPatch('trend_thesis_regimes', trendThesis, `explore trend_thesis keep`),
        genomeArrayPatch('adverse_chapters_sell', adverseSell, `explore adverse_sell toggle`),
        genomeArrayPatch('adverse_chapters_buy', adverseBuy, `explore adverse_buy toggle`),
        genomeArrayPatch('resume_chapters_sell', resumeSell, `explore resume_sell toggle`),
        genomeArrayPatch('resume_chapters_buy', resumeBuy, `explore resume_buy toggle`),
        genomePatch('episode_end_on_continue', flipEpisodeEnd, `flip episode_end ${flipEpisodeEnd}`),
        genomePatch('episode_softplus_bank_mult', episodeSpBank, `explore episode_sp_bank ${episodeSpBank}`),
        genomePatch('explore_step', nextStep + 38, `explore_step ${nextStep + 38}`),
      ],
    },
    {
      title: `Explore SAFETY SL/abs floors (step #${nextStep + 39})`,
      rationale: 'Bounce safety_sl broker/spread mult, abs floor ladder, scratch_soft_mfe_frac.',
      task: `broker=${safetyBrokerMin} spread=${safetySpread} scratch=${scratchMfeFrac}`,
      genome_delta: {
        safety_sl_broker_min_mult: safetyBrokerMin,
        safety_sl_spread_mult: safetySpread,
        safety_abs_floor_hi: safetyFloorHi,
        safety_abs_floor_mid: safetyFloorMid,
        safety_abs_floor_lo: safetyFloorLo,
        scratch_soft_mfe_frac: scratchMfeFrac,
        explore_step: nextStep + 39,
        last_lesson: `Explore SAFETY broker=${safetyBrokerMin}`,
      },
      patches: [
        genomePatch('safety_sl_broker_min_mult', safetyBrokerMin, `explore sl_broker ${safetyBrokerMin}`),
        genomePatch('safety_sl_spread_mult', safetySpread, `explore sl_spread ${safetySpread}`),
        genomePatch('safety_abs_floor_hi', safetyFloorHi, `explore abs_floor_hi ${safetyFloorHi}`),
        genomePatch('safety_abs_floor_mid', safetyFloorMid, `explore abs_floor_mid ${safetyFloorMid}`),
        genomePatch('safety_abs_floor_lo', safetyFloorLo, `explore abs_floor_lo ${safetyFloorLo}`),
        genomePatch('scratch_soft_mfe_frac', scratchMfeFrac, `explore scratch_mfe ${scratchMfeFrac}`),
        genomePatch('explore_step', nextStep + 39, `explore_step ${nextStep + 39}`),
      ],
    },
    {
      title: `Explore entry learner (step #${nextStep + 40})`,
      rationale: 'Bounce entry_learner lr/l2/temp/eps/max_w, zone bins, wait_boost.',
      task: `lr=${elLr} l2=${elL2} temp=${elTemp} eps=${elEps}`,
      genome_delta: {
        entry_learner_lr: elLr,
        entry_learner_l2: elL2,
        entry_learner_temp: elTemp,
        entry_learner_explore_eps: elEps,
        entry_learner_max_w: elMaxW,
        entry_zone_lo_bin: elZoneLo,
        entry_zone_hi_bin: elZoneHi,
        entry_learner_wait_boost: elWaitBoost,
        entry_learner_prior_buy: elPriorBuy,
        entry_learner_prior_sell: elPriorSell,
        entry_learner_prior_wait: elPriorWait,
        explore_step: nextStep + 40,
        last_lesson: `Explore entry learner lr=${elLr}`,
      },
      patches: [
        genomePatch('entry_learner_lr', elLr, `explore el_lr ${elLr}`),
        genomePatch('entry_learner_l2', elL2, `explore el_l2 ${elL2}`),
        genomePatch('entry_learner_temp', elTemp, `explore el_temp ${elTemp}`),
        genomePatch('entry_learner_explore_eps', elEps, `explore el_eps ${elEps}`),
        genomePatch('entry_learner_max_w', elMaxW, `explore el_max_w ${elMaxW}`),
        genomePatch('entry_zone_lo_bin', elZoneLo, `explore el_zone_lo ${elZoneLo}`),
        genomePatch('entry_zone_hi_bin', elZoneHi, `explore el_zone_hi ${elZoneHi}`),
        genomePatch('entry_learner_wait_boost', elWaitBoost, `explore el_wait ${elWaitBoost}`),
        genomePatch('entry_learner_prior_buy', elPriorBuy, `explore el_prior_buy ${elPriorBuy}`),
        genomePatch('entry_learner_prior_sell', elPriorSell, `explore el_prior_sell ${elPriorSell}`),
        genomePatch('entry_learner_prior_wait', elPriorWait, `explore el_prior_wait ${elPriorWait}`),
        genomePatch('explore_step', nextStep + 40, `explore_step ${nextStep + 40}`),
      ],
    },
    {
      title: `Explore auto-cal bounds (step #${nextStep + 41})`,
      rationale: 'Bounce auto_cal_max/min bounds for safety, target, peak, hardinv.',
      task: `ac_max_safety=${acMaxSafetyRr} ac_max_tgt=${acMaxTgt} ac_max_peak=${acMaxPeakMfe}`,
      genome_delta: {
        auto_cal_max_safety_tp_rr: acMaxSafetyRr,
        auto_cal_max_target_abs: acMaxTgt,
        auto_cal_max_peak_mfe_abs: acMaxPeakMfe,
        auto_cal_max_peak_retention: acMaxPeakRet,
        auto_cal_min_peak_retention: acMinPeakRet,
        auto_cal_min_hardinv_abs: acMinHardinv,
        auto_cal_max_hardinv_abs: acMaxHardinv,
        min_enabled_regimes: minEnabledReg,
        soft_pct_ref_mid: softPctRefMid,
        explore_step: nextStep + 41,
        last_lesson: `Explore auto-cal bounds safety=${acMaxSafetyRr}`,
      },
      patches: [
        genomePatch('auto_cal_max_safety_tp_rr', acMaxSafetyRr, `explore ac_max_safety ${acMaxSafetyRr}`),
        genomePatch('auto_cal_max_target_abs', acMaxTgt, `explore ac_max_tgt ${acMaxTgt}`),
        genomePatch('auto_cal_max_peak_mfe_abs', acMaxPeakMfe, `explore ac_max_peak_mfe ${acMaxPeakMfe}`),
        genomePatch('auto_cal_max_peak_retention', acMaxPeakRet, `explore ac_max_peak_ret ${acMaxPeakRet}`),
        genomePatch('auto_cal_min_peak_retention', acMinPeakRet, `explore ac_min_peak_ret ${acMinPeakRet}`),
        genomePatch('auto_cal_min_hardinv_abs', acMinHardinv, `explore ac_min_hardinv ${acMinHardinv}`),
        genomePatch('auto_cal_max_hardinv_abs', acMaxHardinv, `explore ac_max_hardinv ${acMaxHardinv}`),
        genomePatch('min_enabled_regimes', minEnabledReg, `explore min_enabled_reg ${minEnabledReg}`),
        genomePatch('soft_pct_ref_mid', softPctRefMid, `explore soft_pct_ref ${softPctRefMid}`),
        genomePatch('explore_step', nextStep + 41, `explore_step ${nextStep + 41}`),
      ],
    },
    {
      title: `Explore auto-cal steps/gaps (step #${nextStep + 42})`,
      rationale: 'Bounce soft_tighten, peak_ease, safety_tp steps, gap ladder, persist gap.',
      task: `soft_tighten=${softTighten} gap_move=${gapMoveStay} persist_gap=${persistEnterStayGap}`,
      genome_delta: {
        soft_tighten_step: softTighten,
        peak_ease_abs_step: peakEaseAbs,
        peak_ease_retention_step: peakEaseRet,
        peak_ease_giveback_step: peakEaseGb,
        safety_tp_rr_step: safetyRrStep,
        safety_tp_rr_pullback_step: safetyRrPbStep,
        raise_streak_before_pullback: raiseStreakPb,
        soft_sized_loss_detect_min: softSizedDetect,
        gap_move_stay: gapMoveStay,
        gap_stay_enter: gapStayEnter,
        gap_enter_pullback: gapEnterPb,
        gap_pullback_reversal: gapPbRev,
        gap_compress_expand: gapCompressExp,
        persist_enter_stay_min_gap: persistEnterStayGap,
        explore_step: nextStep + 42,
        last_lesson: `Explore auto-cal steps gap=${gapMoveStay}`,
      },
      patches: [
        genomePatch('soft_tighten_step', softTighten, `explore soft_tighten ${softTighten}`),
        genomePatch('peak_ease_abs_step', peakEaseAbs, `explore peak_ease_abs ${peakEaseAbs}`),
        genomePatch('peak_ease_retention_step', peakEaseRet, `explore peak_ease_ret ${peakEaseRet}`),
        genomePatch('peak_ease_giveback_step', peakEaseGb, `explore peak_ease_gb ${peakEaseGb}`),
        genomePatch('safety_tp_rr_step', safetyRrStep, `explore safety_rr_step ${safetyRrStep}`),
        genomePatch('safety_tp_rr_pullback_step', safetyRrPbStep, `explore safety_rr_pb ${safetyRrPbStep}`),
        genomePatch('raise_streak_before_pullback', raiseStreakPb, `explore raise_streak ${raiseStreakPb}`),
        genomePatch('soft_sized_loss_detect_min', softSizedDetect, `explore soft_sized_det ${softSizedDetect}`),
        genomePatch('gap_move_stay', gapMoveStay, `explore gap_move_stay ${gapMoveStay}`),
        genomePatch('gap_stay_enter', gapStayEnter, `explore gap_stay_enter ${gapStayEnter}`),
        genomePatch('gap_enter_pullback', gapEnterPb, `explore gap_enter_pb ${gapEnterPb}`),
        genomePatch('gap_pullback_reversal', gapPbRev, `explore gap_pb_rev ${gapPbRev}`),
        genomePatch('gap_compress_expand', gapCompressExp, `explore gap_compress ${gapCompressExp}`),
        genomePatch(
          'persist_enter_stay_min_gap',
          persistEnterStayGap,
          `explore persist_gap ${persistEnterStayGap}`
        ),
        genomePatch('explore_step', nextStep + 42, `explore_step ${nextStep + 42}`),
      ],
    },
  ];
}

/** Absolute last resort — always returns a unique untried hypothesis. */
function forceExploreHypothesis(
  analysis: AnalysisResult,
  g: BrainGenome,
  tried: Set<string>
): BrainHypothesis {
  const baseStep = (g.explore_step || 0) + 1;
  for (let i = 0; i < 96; i++) {
    const nextStep = baseStep + tried.size + i;
    const dir: 1 | -1 = nextStep % 2 === 0 ? 1 : -1;
    const keep = bounceNum(g.peak_keep, 0.01, 0.1, 0.95, dir);
    const gb = bounceNum(g.soft_plus_giveback, 0.01, 0.55, 0.85, dir === 1 ? -1 : 1);
    const rev = bounceBp(g.regime_reversal, 1.0, 8.0, 40.0, dir);
    const mom = bounceInt(g.regime_mom_bars, 1, 4, 16, dir);
    const compressAbs = bounceBp(g.regime_compress_abs, 0.1, 0.2, 1.2, dir);
    const expandMult = bounceNum(g.regime_expand_avg_mult, 0.1, 1.2, 2.5, dir);
    const persistStay = bounceNum(g.regime_persist_stay, 0.05, 0.1, 0.7, dir);
    const trek = bounceBp(g.mtf_trek_flat_frac, 0.5, 1.5, 12.0, dir);
    const softL3 = bounceNum(g.soft_l3_abs, 0.1, 1.0, 8.0, dir);
    const softL1 = bounceNum(Math.min(g.soft_l1_abs, softL3 - 0.4), 0.1, 0.5, softL3 - 0.3, dir);
    const softL2 = bounceNum(Math.min(Math.max(g.soft_l2_abs, softL1), softL3), 0.1, softL1, softL3, dir);
    const trailCap = bounceNum(g.peak_trail_soft_cap_mult, 0.05, 1.2, 2.5, dir);
    const runner = bounceNum(g.soft_plus_runner_mult, 0.05, 1.1, 2.5, dir);
    const unlock = bounceNum(g.soft_layer_unlock_mult, 0.05, 0.5, 1.5, dir);
    const pbArm = bounceNum(g.pullback_episode_peak_arm_soft_mult, 0.05, 0.5, 1.35, dir);
    const peakMfe = bounceNum(g.peak_mfe_abs, 0.1, 1.0, 8.0, dir);
    const safetyRr = bounceNum(g.safety_tp_rr, 0.1, 1.5, 3.0, dir);
    const mindCut = bounceNum(g.mind_cut_soft_mult, 0.05, 0.4, 1.2, dir);
    const exitTrend = bounceNum(g.exit_trend_target_mult, 0.05, 0.5, 2.0, dir);
    const chopMax = bounceNum(g.entry_chop_conf_max, 0.02, 0.25, 0.55, dir);
    const softL1Fb = bounceNum(g.soft_l1_fallback_frac, 0.05, 0.2, 0.95, dir);
    const hardinvFloor = bounceNum(g.hardinv_abs_floor, 0.1, 0.2, 20.0, dir);
    const hardinvConfirm = bounceInt(g.hardinv_confirm_ms, 1000, 0, 30_000, dir);
    const exitFam = EXIT_FAMILIES[nextStep % EXIT_FAMILIES.length]!;
    const famHardinv = bounceNum(
      g[exitFamilyKey(exitFam, 'hardinv_mult')] as number,
      0.05,
      0.5,
      1.5,
      dir
    );
    const storyPathBp = bounceBp(g.story_min_path_bp, 0.5, 3.0, 20.0, dir);
    const greenSoftArm = bounceNum(g.green_soft_arm_mult, 0.05, 0.5, 1.2, dir);
    const msClamp = bounceNum(g.manage_score_clamp, 0.1, 1.0, 4.0, dir);
    const safetyBrokerMin = bounceNum(g.safety_sl_broker_min_mult, 0.1, 1.5, 5.0, dir);
    const elLr = bounceNum(g.entry_learner_lr, 0.01, 0.01, 0.5, dir);
    const acMaxTgt = bounceNum(g.auto_cal_max_target_abs, 0.5, 6.0, 20.0, dir);
    const gapMoveStay = bounceBp(g.gap_move_stay, 0.1, 0.5, 3.0, dir);
    const zoneBars = bounceInt(g.zone_bars, 10, 60, 360, dir);
    const halfLo = bounceNum(g.struct_half_lo, 0.02, 0.3, 0.7, dir);
    const flipSoftExit1m = !g.soft_exit_require_1m_change;
    const nonce = `${Date.now().toString(36)}_${i}`;
    const mode = nextStep % 16;
    let genome_delta: Record<string, unknown>;
    let patches: ReturnType<typeof compactPatches>;
    if (mode === 0) {
      genome_delta = {
        explore_step: nextStep,
        peak_keep: keep,
        soft_plus_giveback: gb,
        version: (g.version || 1) + 1,
        last_lesson: `Force explore peak #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch('peak_keep', keep, `force Keep ${keep}`),
        genomePatch('soft_plus_giveback', gb, `force giveback ${gb}`),
      ]);
    } else if (mode === 1) {
      genome_delta = {
        explore_step: nextStep,
        regime_reversal: rev,
        regime_mom_bars: mom,
        version: (g.version || 1) + 1,
        last_lesson: `Force explore regime #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch('regime_reversal', rev, `force reversal ${rev}`),
        genomePatch('regime_mom_bars', mom, `force mom ${mom}`),
      ]);
    } else if (mode === 2) {
      genome_delta = {
        explore_step: nextStep,
        regime_compress_abs: compressAbs,
        regime_expand_avg_mult: expandMult,
        regime_persist_stay: persistStay,
        version: (g.version || 1) + 1,
        last_lesson: `Force explore compress/persist #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch('regime_compress_abs', compressAbs, `force compress ${compressAbs}`),
        genomePatch('regime_expand_avg_mult', expandMult, `force expand_mult ${expandMult}`),
        genomePatch('regime_persist_stay', persistStay, `force persist_stay ${persistStay}`),
      ]);
    } else if (mode === 3) {
      genome_delta = {
        explore_step: nextStep,
        mtf_trek_flat_frac: trek,
        mtf_htf_veto: !g.mtf_htf_veto,
        entry_chop_conf_max: chopMax,
        version: (g.version || 1) + 1,
        last_lesson: `Force explore mtf #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch('mtf_trek_flat_frac', trek, `force trek ${trek}`),
        genomePatch('mtf_htf_veto', !g.mtf_htf_veto, `force htf_veto→${!g.mtf_htf_veto}`),
        genomePatch('entry_chop_conf_max', chopMax, `force chop_max ${chopMax}`),
      ]);
    } else if (mode === 4) {
      genome_delta = {
        explore_step: nextStep,
        soft_l1_abs: softL1,
        soft_l2_abs: softL2,
        soft_l3_abs: softL3,
        version: (g.version || 1) + 1,
        last_lesson: `Force explore Soft layers #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch('soft_l1_abs', softL1, `force soft_l1 ${softL1}`),
        genomePatch('soft_l2_abs', softL2, `force soft_l2 ${softL2}`),
        genomePatch('soft_l3_abs', softL3, `force soft_l3 ${softL3}`),
      ]);
    } else if (mode === 5) {
      genome_delta = {
        explore_step: nextStep,
        peak_mfe_abs: peakMfe,
        peak_trail_soft_cap_mult: trailCap,
        safety_tp_rr: safetyRr,
        version: (g.version || 1) + 1,
        last_lesson: `Force explore Peak/safety #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch('peak_mfe_abs', peakMfe, `force peak_mfe ${peakMfe}`),
        genomePatch('peak_trail_soft_cap_mult', trailCap, `force trail_cap ${trailCap}`),
        genomePatch('safety_tp_rr', safetyRr, `force safety_rr ${safetyRr}`),
      ]);
    } else if (mode === 6) {
      genome_delta = {
        explore_step: nextStep,
        soft_plus_runner_mult: runner,
        soft_layer_unlock_mult: unlock,
        pullback_episode_peak_arm_soft_mult: pbArm,
        pullback_episode_enabled: true,
        version: (g.version || 1) + 1,
        last_lesson: `Force explore Soft+/pb #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch('soft_plus_runner_mult', runner, `force runner ${runner}`),
        genomePatch('soft_layer_unlock_mult', unlock, `force unlock ${unlock}`),
        genomePatch('pullback_episode_peak_arm_soft_mult', pbArm, `force pb_arm ${pbArm}`),
        genomePatch('pullback_episode_enabled', true, 'force pb on'),
      ]);
    } else if (mode === 7) {
      genome_delta = {
        explore_step: nextStep,
        mind_cut_soft_mult: mindCut,
        exit_trend_target_mult: exitTrend,
        version: (g.version || 1) + 1,
        last_lesson: `Force explore mind/exit #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch('mind_cut_soft_mult', mindCut, `force mind_cut ${mindCut}`),
        genomePatch('exit_trend_target_mult', exitTrend, `force exit_trend_tgt ${exitTrend}`),
      ]);
    } else if (mode === 8) {
      genome_delta = {
        explore_step: nextStep,
        soft_l1_fallback_frac: softL1Fb,
        target_stretch_gate: bounceNum(g.target_stretch_gate, 0.05, 0.5, 1.0, dir),
        version: (g.version || 1) + 1,
        last_lesson: `Force explore fallback #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch('soft_l1_fallback_frac', softL1Fb, `force soft_l1_fb ${softL1Fb}`),
        genomePatch(
          'target_stretch_gate',
          bounceNum(g.target_stretch_gate, 0.05, 0.5, 1.0, dir),
          'force stretch gate'
        ),
      ]);
    } else if (mode === 9) {
      genome_delta = {
        explore_step: nextStep,
        hardinv_abs_floor: hardinvFloor,
        target_abs_floor: bounceNum(g.target_abs_floor, 0.1, 1.0, 20.0, dir),
        version: (g.version || 1) + 1,
        last_lesson: `Force explore exit floors #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch('hardinv_abs_floor', hardinvFloor, `force hardinv_floor ${hardinvFloor}`),
        genomePatch(
          'target_abs_floor',
          bounceNum(g.target_abs_floor, 0.1, 1.0, 20.0, dir),
          'force target_floor'
        ),
      ]);
    } else if (mode === 10) {
      genome_delta = {
        explore_step: nextStep,
        hardinv_confirm_ms: hardinvConfirm,
        timedecay_min_hold_ms: bounceInt(g.timedecay_min_hold_ms, 30_000, 60_000, 1_800_000, dir),
        version: (g.version || 1) + 1,
        last_lesson: `Force explore exit timings #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch('hardinv_confirm_ms', hardinvConfirm, `force hardinv_confirm ${hardinvConfirm}`),
        genomePatch(
          'timedecay_min_hold_ms',
          bounceInt(g.timedecay_min_hold_ms, 30_000, 60_000, 1_800_000, dir),
          'force td_hold'
        ),
      ]);
    } else if (mode === 11) {
      genome_delta = {
        explore_step: nextStep,
        [exitFamilyKey(exitFam, 'hardinv_mult')]: famHardinv,
        [exitFamilyKey(exitFam, 'target_mult')]: bounceNum(
          g[exitFamilyKey(exitFam, 'target_mult')] as number,
          0.05,
          0.5,
          2.0,
          dir
        ),
        version: (g.version || 1) + 1,
        last_lesson: `Force explore exit ${exitFam} #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch(
          exitFamilyKey(exitFam, 'hardinv_mult'),
          famHardinv,
          `force ${exitFam} hardinv ${famHardinv}`
        ),
        genomePatch(
          exitFamilyKey(exitFam, 'target_mult'),
          bounceNum(g[exitFamilyKey(exitFam, 'target_mult')] as number, 0.05, 0.5, 2.0, dir),
          `force ${exitFam} target`
        ),
      ]);
    } else if (mode === 12) {
      genome_delta = {
        explore_step: nextStep,
        story_min_path_bp: storyPathBp,
        chase_edge: bounceNum(g.chase_edge, 0.02, 0.05, 0.3, dir),
        version: (g.version || 1) + 1,
        last_lesson: `Force explore story #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch('story_min_path_bp', storyPathBp, `force story_path ${storyPathBp}`),
        genomePatch('chase_edge', bounceNum(g.chase_edge, 0.02, 0.05, 0.3, dir), 'force chase_edge'),
      ]);
    } else if (mode === 13) {
      genome_delta = {
        explore_step: nextStep,
        green_soft_arm_mult: greenSoftArm,
        manage_score_clamp: msClamp,
        version: (g.version || 1) + 1,
        last_lesson: `Force explore mind/manage #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch('green_soft_arm_mult', greenSoftArm, `force green_soft ${greenSoftArm}`),
        genomePatch('manage_score_clamp', msClamp, `force ms_clamp ${msClamp}`),
      ]);
    } else if (mode === 14) {
      genome_delta = {
        explore_step: nextStep,
        safety_sl_broker_min_mult: safetyBrokerMin,
        entry_learner_lr: elLr,
        version: (g.version || 1) + 1,
        last_lesson: `Force explore safety/learner #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch('safety_sl_broker_min_mult', safetyBrokerMin, `force sl_broker ${safetyBrokerMin}`),
        genomePatch('entry_learner_lr', elLr, `force el_lr ${elLr}`),
      ]);
    } else {
      genome_delta = {
        explore_step: nextStep,
        auto_cal_max_target_abs: acMaxTgt,
        gap_move_stay: gapMoveStay,
        zone_bars: zoneBars,
        struct_half_lo: halfLo,
        soft_exit_require_1m_change: flipSoftExit1m,
        version: (g.version || 1) + 1,
        last_lesson: `Force explore auto-cal/struct #${nextStep} · ${nonce}`,
      };
      patches = compactPatches([
        genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
        genomePatch('auto_cal_max_target_abs', acMaxTgt, `force ac_max_tgt ${acMaxTgt}`),
        genomePatch('gap_move_stay', gapMoveStay, `force gap_move ${gapMoveStay}`),
        genomePatch('zone_bars', zoneBars, `force zone_bars ${zoneBars}`),
        genomePatch('struct_half_lo', halfLo, `force half_lo ${halfLo}`),
        genomePatch('soft_exit_require_1m_change', flipSoftExit1m, `force soft_exit_1m ${flipSoftExit1m}`),
      ]);
    }
    const signature = hypothesisSignature({
      pattern_id: 'explore',
      patches,
      genome_delta,
    });
    if (tried.has(signature)) continue;
    return {
      id: `hyp_explore_${signature.slice(0, 8)}`,
      pattern_id: 'explore',
      title: `Force explore #${nextStep}`,
      rationale: `Unstick after exhausted variants · top=${analysis.top_pattern?.id || 'none'}`,
      task: `Mandatory explore_step=${nextStep} mode=${mode}`,
      patches,
      genome_delta,
      signature,
      created_at: new Date().toISOString(),
    };
  }
  // Absolute fallback — nonce alone guarantees uniqueness
  const nextStep = baseStep + tried.size + 99;
  const genome_delta = {
    explore_step: nextStep,
    last_lesson: `Force explore emergency ${Date.now()}`,
    version: (g.version || 1) + Math.max(1, tried.size),
  };
  const signature = hypothesisSignature({
    pattern_id: 'explore',
    patches: [],
    genome_delta,
  });
  return {
    id: `hyp_explore_${signature.slice(0, 8)}`,
    pattern_id: 'explore',
    title: `Force explore #${nextStep}`,
    rationale: `Emergency unique explore · top=${analysis.top_pattern?.id || 'none'}`,
    task: `explore_step=${nextStep}`,
    patches: [],
    genome_delta,
    signature,
    created_at: new Date().toISOString(),
  };
}

function variantsForPatternId(
  patternId: string,
  analysis: AnalysisResult,
  g: BrainGenome
): Variant[] {
  if (patternId === 'soft_sell_spam') {
    return softSellVariants(g, analysis.soft_sell_losses || analysis.soft_losses);
  }
  if (patternId === 'soft_buy_spam') {
    return softBuyVariants(g, analysis.soft_buy_losses || analysis.soft_losses);
  }
  if (patternId === 'soft_loss') {
    // Prefer side-specific if window shows it
    if (analysis.soft_sell_losses >= 2) return softSellVariants(g, analysis.soft_sell_losses);
    if (analysis.soft_buy_losses >= 2) return softBuyVariants(g, analysis.soft_buy_losses);
    return softLossVariants(g, analysis.soft_losses);
  }
  if (patternId === 'green_not_banked' || patternId === 'rr_inverted') {
    return bankGreenVariants(g, analysis.green_not_banked, analysis.session_e);
  }
  if (patternId === 'micro_scratch') {
    return microScratchVariants(g);
  }
  return genericVariants(g, patternId);
}

function rankedPatternIds(analysis: AnalysisResult): string[] {
  const ids: string[] = [];
  const push = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  if (analysis.top_pattern) push(analysis.top_pattern.id);
  if (analysis.soft_sell_losses >= 2) push('soft_sell_spam');
  if (analysis.soft_buy_losses >= 2) push('soft_buy_spam');
  if (analysis.soft_losses >= 2) push('soft_loss');
  if (analysis.green_not_banked >= 1) push('green_not_banked');
  if (analysis.micro_scratches >= 2) push('micro_scratch');
  for (const p of analysis.patterns) push(p.id);
  return ids;
}

function tryVariant(
  patternId: string,
  v: Variant,
  g: BrainGenome,
  tried: Set<string>
): BrainHypothesis | null {
  const patches = compactPatches(v.patches);
  const deltaKeys = Object.keys(v.genome_delta).filter((k) => k !== 'last_lesson');
  const meaningfulDelta = deltaKeys.some((k) => {
    const key = k as keyof BrainGenome;
    return g[key] !== v.genome_delta[k];
  });
  if (!patches.length && !meaningfulDelta) return null;

  const hypoCore = {
    pattern_id: patternId,
    patches,
    genome_delta: v.genome_delta,
  };
  const signature = hypothesisSignature(hypoCore);
  if (tried.has(signature)) return null;

  return {
    id: `hyp_${patternId}_${signature.slice(0, 8)}`,
    pattern_id: patternId,
    title: v.title,
    rationale: v.rationale,
    task: v.task,
    patches,
    genome_delta: v.genome_delta,
    signature,
    created_at: new Date().toISOString(),
  };
}

export function buildHypothesis(
  analysis: AnalysisResult,
  exp?: BrainExperience | null
): BrainHypothesis | null {
  // Only true empty session may skip — Soft/pattern present → always a hypothesis
  if (
    !analysis.top_pattern &&
    !analysis.soft_losses &&
    !analysis.patterns.length &&
    !analysis.micro_scratches &&
    !analysis.green_not_banked
  ) {
    return null;
  }
  const g = getBrainGenome();
  const tried = new Set([
    ...(exp?.rejected_signatures || []),
    ...(exp?.accepted_signatures || []),
  ]);

  for (const patternId of rankedPatternIds(analysis)) {
    for (const v of variantsForPatternId(patternId, analysis, g)) {
      const hypo = tryVariant(patternId, v, g, tried);
      if (hypo) return hypo;
    }
  }

  const rejectedN = exp?.rejected_signatures?.length || 0;
  // Rotate start index so peak/soft explore variants do not starve trading-intel knobs.
  const explore = exploreVariants(g, rejectedN);
  const start = explore.length ? rejectedN % explore.length : 0;
  for (let i = 0; i < explore.length; i++) {
    const v = explore[(start + i) % explore.length]!;
    const hypo = tryVariant('explore', v, g, tried);
    if (hypo) return hypo;
  }

  // NEVER permanent SKIPPED while Soft/patterns exist
  return forceExploreHypothesis(analysis, g, tried);
}
