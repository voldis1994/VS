/**
 * Pattern → hypothesis → concrete allowlisted patches / genome delta.
 * Tries ranked patterns + alternate variants so SKIPPED does not stall forever.
 */
import { getBrainGenome, type BrainGenome } from './brainGenome.js';
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
    const nonce = `${Date.now().toString(36)}_${i}`;
    const mode = nextStep % 8;
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
    } else {
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
