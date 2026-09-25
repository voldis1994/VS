/**
 * Pattern → hypothesis → concrete allowlisted patches / genome delta.
 * Builds alternate variants so rejected signatures do not stall learning.
 */
import { getBrainGenome, type BrainGenome } from './brainGenome.js';
import {
  hypothesisSignature,
  type BrainExperience,
  type BrainHypothesis,
} from './experience.js';
import type { BrainPatch } from './guards.js';
import type { AnalysisResult } from './analyze.js';

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
      'Tighten genome: wait_on_1m_fight=true, require_1m_trigger=true, raise soft pause.',
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
    ],
  };
  const pauseHarder: Variant = {
    title: 'Harder Soft same-side pause (SELL)',
    rationale: `Prior pause insufficient — Soft SELL×${softSell}`,
    task: 'Raise soft_same_side_pause_closes and pause_min.',
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
  // Prefer Soft-pause memory first (defensive accept when replay flat); Peak/Keep when pause maxed
  if (g.soft_same_side_pause_closes >= 8) {
    return [measurable, pauseHarder];
  }
  return [pauseFirst, pauseHarder, measurable];
}

function softBuyVariants(g: BrainGenome, softBuy: number): Variant[] {
  const pause1 = Math.min(8, g.soft_same_side_pause_closes + 1);
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
      ],
    },
  ];
}

function bankGreenVariants(g: BrainGenome, left: number, e: number): Variant[] {
  const nextKeep = Math.min(0.85, Math.max(0.72, g.peak_keep + 0.03));
  const nextGb = Math.min(0.82, Math.max(0.7, g.soft_plus_giveback + 0.03));
  const nextKeep2 = Math.min(0.88, g.peak_keep + 0.05);
  const arm = Math.max(0.5, Number((g.peak_arm_soft_mult - 0.08).toFixed(2)));
  return [
    {
      title: 'Bank Soft+ sooner — raise Keep / giveback bank',
      rationale: `Left winners on table×${left} · E=${e.toFixed(2)}`,
      task: 'Raise peak_keep and soft_plus_giveback so MindBank takes plus before Soft eats it.',
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
      ],
    },
    {
      title: 'Aggressive Peak arm + Keep for left-on-table',
      rationale: `Still leaving MFE on table×${left}`,
      task: 'Lower peak_arm_soft_mult and push Keep higher.',
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
      ],
    },
  ];
}

function microScratchVariants(g: BrainGenome): Variant[] {
  return [
    {
      title: 'Reduce micro-scratch sensitivity',
      rationale: 'Micro scratches — structure/Limit noise.',
      task: 'Keep Soft-sized-only structure; genome reinforces require_1m_trigger.',
      genome_delta: {
        require_1m_trigger: true,
        wait_on_1m_fight: true,
        last_lesson: 'Avoid knife micro-scratch entries',
      },
      patches: [
        genomePatch('require_1m_trigger', true, 'avoid knife entries'),
        genomePatch('wait_on_1m_fight', true, 'wait 1m fight'),
      ],
    },
    {
      title: 'Slight Keep tighten after scratch noise',
      rationale: 'Entry noise; survivors should bank cleanly.',
      task: 'Nudge peak_keep up while holding 1m trigger.',
      genome_delta: {
        peak_keep: Math.min(0.82, g.peak_keep + 0.02),
        require_1m_trigger: true,
        last_lesson: 'Keep nudge after scratches',
      },
      patches: [
        genomePatch('peak_keep', Math.min(0.82, g.peak_keep + 0.02), 'Keep nudge'),
        genomePatch('require_1m_trigger', true, '1m trigger'),
      ],
    },
  ];
}

function genericVariants(g: BrainGenome, label: string): Variant[] {
  const nextKeep = Math.min(0.82, g.peak_keep + 0.02);
  const nextGb = Math.min(0.8, g.soft_plus_giveback + 0.02);
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
  ];
}

function variantsFor(analysis: AnalysisResult, g: BrainGenome): Variant[] {
  const top = analysis.top_pattern;
  if (!top) return [];
  if (top.id === 'soft_sell_spam' || (analysis.soft_sell_losses >= 2 && top.id === 'soft_loss')) {
    return softSellVariants(g, analysis.soft_sell_losses);
  }
  if (top.id === 'green_not_banked' || top.id === 'rr_inverted') {
    return bankGreenVariants(g, analysis.green_not_banked, analysis.session_e);
  }
  if (top.id === 'micro_scratch') {
    return microScratchVariants(g);
  }
  if (top.id === 'soft_buy_spam') {
    return softBuyVariants(g, analysis.soft_buy_losses);
  }
  return genericVariants(g, top.label);
}

export function buildHypothesis(
  analysis: AnalysisResult,
  exp?: BrainExperience | null
): BrainHypothesis | null {
  const top = analysis.top_pattern;
  if (!top) return null;
  const g = getBrainGenome();
  const tried = new Set([
    ...(exp?.rejected_signatures || []),
    ...(exp?.accepted_signatures || []),
  ]);

  for (const v of variantsFor(analysis, g)) {
    const patches = compactPatches(v.patches);
    const deltaKeys = Object.keys(v.genome_delta).filter((k) => k !== 'last_lesson');
    const meaningfulDelta = deltaKeys.some((k) => {
      const key = k as keyof BrainGenome;
      return g[key] !== v.genome_delta[k];
    });
    if (!patches.length && !meaningfulDelta) continue;

    const hypoCore = {
      pattern_id: top.id,
      patches,
      genome_delta: v.genome_delta,
    };
    const signature = hypothesisSignature(hypoCore);
    if (tried.has(signature)) continue;

    return {
      id: `hyp_${top.id}_${signature.slice(0, 8)}`,
      pattern_id: top.id,
      title: v.title,
      rationale: v.rationale,
      task: v.task,
      patches,
      genome_delta: v.genome_delta,
      signature,
      created_at: new Date().toISOString(),
    };
  }
  return null;
}
