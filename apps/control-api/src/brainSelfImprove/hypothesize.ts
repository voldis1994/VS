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
      ],
    },
    {
      title: 'Harder BUY Soft pause',
      rationale: `Soft BUY×${softBuy} continues`,
      task: 'Raise pause closes further.',
      genome_delta: {
        soft_same_side_pause_closes: pause2,
        require_1m_trigger: true,
        wait_on_1m_fight: true,
        last_lesson: 'Harder BUY Soft pause',
      },
      patches: [
        genomePatch('soft_same_side_pause_closes', pause2, 'BUY pause +2'),
        genomePatch('wait_on_1m_fight', true, 'wait 1m fight'),
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
      ],
    },
    {
      title: 'Bank survivors earlier after Soft losses',
      rationale: `Soft×${softL} — survivors must Keep sooner.`,
      task: 'Raise peak_keep + soft_plus_giveback; lower peak_arm_soft_mult.',
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
      ],
    },
    {
      title: 'Harder Soft pause min after Soft chain',
      rationale: `Soft×${softL}`,
      task: 'Raise soft_same_side_pause_min.',
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

/** Explore steps when all pattern variants exhausted — still learns, never permanent SKIPPED. */
function exploreVariants(g: BrainGenome, rejectedN: number): Variant[] {
  const step = 0.02 + (rejectedN % 3) * 0.01;
  const keep = Math.min(0.88, Number((g.peak_keep + step).toFixed(2)));
  const gb = Math.min(0.85, Number((g.soft_plus_giveback + step).toFixed(2)));
  const arm = Math.max(0.5, Number((g.peak_arm_soft_mult - step).toFixed(2)));
  const pause = Math.min(8, g.soft_same_side_pause_closes + 1 + (rejectedN % 2));
  return [
    {
      title: `Explore Keep+${step} (rejected=${rejectedN})`,
      rationale: 'All pattern hypotheses tried — explore Peak Keep.',
      task: `Raise peak_keep to ${keep}.`,
      genome_delta: { peak_keep: keep, last_lesson: `Explore keep ${keep}` },
      patches: [genomePatch('peak_keep', keep, `explore Keep ${keep}`)],
    },
    {
      title: `Explore giveback+${step}`,
      rationale: 'Explore Soft+ giveback bank.',
      task: `Raise soft_plus_giveback to ${gb}.`,
      genome_delta: {
        soft_plus_giveback: gb,
        mind_bank_on_turn: true,
        last_lesson: `Explore giveback ${gb}`,
      },
      patches: [
        genomePatch('soft_plus_giveback', gb, `explore giveback ${gb}`),
        genomePatch('mind_bank_on_turn', true, 'mind bank on'),
      ],
    },
    {
      title: `Explore Peak arm −${step}`,
      rationale: 'Explore earlier Peak arm.',
      task: `Lower peak_arm_soft_mult to ${arm}.`,
      genome_delta: { peak_arm_soft_mult: arm, last_lesson: `Explore arm ${arm}` },
      patches: [genomePatch('peak_arm_soft_mult', arm, `explore arm ${arm}`)],
    },
    {
      title: `Explore Soft pause → ${pause}`,
      rationale: 'Explore longer Soft same-side pause.',
      task: `soft_same_side_pause_closes=${pause}.`,
      genome_delta: {
        soft_same_side_pause_closes: pause,
        require_1m_trigger: true,
        last_lesson: `Explore pause ${pause}`,
      },
      patches: [
        genomePatch('soft_same_side_pause_closes', pause, `explore pause ${pause}`),
        genomePatch('require_1m_trigger', true, '1m trigger'),
      ],
    },
  ];
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
  if (!analysis.top_pattern && !analysis.soft_losses && !analysis.patterns.length) {
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

  // Never stall forever — explore knobs stepped by rejected count
  const rejectedN = exp?.rejected_signatures?.length || 0;
  for (const v of exploreVariants(g, rejectedN)) {
    const hypo = tryVariant('explore', v, g, tried);
    if (hypo) return hypo;
  }
  return null;
}
