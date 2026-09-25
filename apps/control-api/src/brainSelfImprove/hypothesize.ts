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
 */
function exploreVariants(g: BrainGenome, rejectedN: number): Variant[] {
  const step = 0.02 + (rejectedN % 3) * 0.01;
  const dir: 1 | -1 = rejectedN % 2 === 0 ? 1 : -1;
  const nextStep = (g.explore_step || 0) + 1;
  const keep = bounceNum(g.peak_keep, step, 0.65, 0.88, dir);
  const gb = bounceNum(g.soft_plus_giveback, step, 0.55, 0.85, dir);
  const arm = bounceNum(g.peak_arm_soft_mult, step, 0.5, 1.2, dir === 1 ? -1 : 1);
  const pause = bounceInt(g.soft_same_side_pause_closes, 1, 1, 12, dir);
  const pauseMin = bounceInt(g.soft_same_side_pause_min, 1, 1, 6, dir);
  const flipWait = !g.wait_on_1m_fight;
  const flipTrig = !g.require_1m_trigger;

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
      rationale: 'Bounce Soft same-side pause knobs.',
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
  for (let i = 0; i < 64; i++) {
    const nextStep = baseStep + tried.size + i;
    const keep = bounceNum(g.peak_keep, 0.01, 0.65, 0.88, nextStep % 2 === 0 ? 1 : -1);
    const gb = bounceNum(g.soft_plus_giveback, 0.01, 0.55, 0.85, nextStep % 2 === 0 ? -1 : 1);
    const nonce = `${Date.now().toString(36)}_${i}`;
    const genome_delta: Record<string, unknown> = {
      explore_step: nextStep,
      peak_keep: keep,
      soft_plus_giveback: gb,
      version: (g.version || 1) + 1,
      last_lesson: `Force explore #${nextStep} · ${nonce}`,
    };
    const patches = compactPatches([
      genomePatch('explore_step', nextStep, `force explore_step ${nextStep}`),
      genomePatch('peak_keep', keep, `force Keep ${keep}`),
      genomePatch('soft_plus_giveback', gb, `force giveback ${gb}`),
    ]);
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
      task: `Mandatory explore_step=${nextStep}, peak_keep→${keep}`,
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
  for (const v of exploreVariants(g, rejectedN)) {
    const hypo = tryVariant('explore', v, g, tried);
    if (hypo) return hypo;
  }

  // NEVER permanent SKIPPED while Soft/patterns exist
  return forceExploreHypothesis(analysis, g, tried);
}
