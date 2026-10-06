/**
 * HTF Market State Engine v2
 *
 * Capital HTF → FACTS → INTERPRETATION → Market Thesis → (TraderMind / learning)
 *
 * Never opens/closes orders. Structure from closed candles only (no lookahead).
 * Thesis is frozen at creation; only `state` advances via post-creation events.
 */
import type { TfDir } from './multiTfRead.js';
import {
  buildHtfFacts,
  factsFrame,
  type HtfCandleBook,
  type HtfFactsBundle,
  type HtfStructureLabel,
  type HtfTfFacts,
  type HtfTfFrame,
  type HtfTimedCandle,
  type HtfVolatility,
  FRAME_ORDER,
  HTF_HISTORY_MIN,
  HTF_HISTORY_TARGET,
} from './htfFacts.js';
import {
  interpretHtf,
  type HtfInterpretation,
  type HtfPhase,
  type HtfTrendMaturity,
  type HtfTfInterpretation,
} from './htfInterpretation.js';

export type {
  HtfCandleBook,
  HtfFactsBundle,
  HtfStructureLabel,
  HtfTfFrame,
  HtfTimedCandle,
  HtfVolatility,
  HtfTfFacts,
} from './htfFacts.js';
export {
  closedCandlesOnly,
  buildHtfFacts,
  structureFromSwings,
  HTF_HISTORY_MIN,
  HTF_HISTORY_TARGET,
  FRAME_ORDER,
} from './htfFacts.js';
export type {
  HtfInterpretation,
  HtfPhase,
  HtfTrendMaturity,
  HtfTfInterpretation,
} from './htfInterpretation.js';
export { interpretHtf, classifyOppositeMove } from './htfInterpretation.js';

export type HtfPathStatus =
  | 'PENDING'
  | 'CONFIRMING'
  | 'CONFIRMED'
  | 'INVALIDATED'
  | 'EXPIRED';

export type HtfThesisSide = 'BUY' | 'SELL' | 'WAIT';

export type ThesisConditionKind =
  | 'CLOSE_ABOVE'
  | 'CLOSE_BELOW'
  | 'CROSS_ABOVE'
  | 'CROSS_BELOW'
  | 'STRUCTURAL_HOLD'
  | 'NEW_HH'
  | 'NEW_HL'
  | 'NEW_LL'
  | 'NEW_LH'
  | 'ACCEPTANCE_UP'
  | 'ACCEPTANCE_DOWN';

export type ThesisCondition = {
  id: string;
  kind: ThesisConditionKind;
  level: number | null;
  tf: HtfTfFrame;
  description: string;
  /**
   * True if level was already satisfied by freeze baseline close.
   * Such conditions need a leave+re-cross (or are ignored until retest).
   */
  satisfied_at_creation: boolean;
};

export type HtfThesisLeg = {
  side: HtfThesisSide;
  summary: string;
  structure: HtfStructureLabel;
  phase: HtfPhase;
  anchor_tf: HtfTfFrame;
};

/**
 * Verifiable Market Thesis — frozen after creation.
 * Only `state` (+ timing fields) may change via advanceFrozenThesis.
 */
export type MarketThesis = {
  primary_thesis: HtfThesisLeg;
  alternative_thesis: HtfThesisLeg;
  expected_events: string[];
  confirmation_conditions: ThesisCondition[];
  invalidation_conditions: ThesisCondition[];
  state: HtfPathStatus;
  /** Heuristic score 0..1 — NOT calibrated probability */
  score: number;
  created_at: number;
  freeze: {
    price: number;
    last_index_by_tf: Partial<Record<HtfTfFrame, number>>;
    last_time_by_tf: Partial<Record<HtfTfFrame, number | null>>;
  };
  /** Filled when state becomes CONFIRMING / CONFIRMED */
  confirmed_at: number | null;
  /** Filled when INVALIDATED */
  invalidated_at: number | null;
  events_hit: string[];
};

export type HTFMarketState = {
  at_ms: number;
  facts: HtfFactsBundle;
  interpretation: HtfInterpretation;
  thesis: MarketThesis;
  /** Convenience mirrors for desk / mind */
  bias: TfDir;
  path_status: HtfPathStatus;
  summary: string;
  summary_lv: string;
  /** @deprecated use thesis.score — kept for compact compat during transition */
  score: number;
};

/** Compact snapshot frozen on entry / closed trade. */
export type HTFMarketStateCompact = {
  bias: TfDir | string;
  structure: HtfStructureLabel | string;
  phase: HtfPhase | string;
  maturity: HtfTrendMaturity | string;
  volatility: HtfVolatility | string;
  primary_side: HtfThesisSide | string;
  alt_side: HtfThesisSide | string;
  path_status: HtfPathStatus | string;
  /** Heuristic score — not probability */
  score: number;
  /** @deprecated alias of score */
  confidence?: number;
  anchor_tf: HtfTfFrame | string;
  liquidity: string;
  breakout: string;
  price_location: string;
  expected_path: string;
  invalidation: string;
  thesis_created_at: number | null;
  expected_events: string[];
  events_hit: string[];
  confirmed_at: number | null;
  invalidated_at: number | null;
};

/** Outcome metrics measured at trade close against frozen thesis. */
export type HtfThesisOutcome = {
  thesis_direction_correct: boolean | null;
  phase_at_entry: string | null;
  phase_at_exit: string | null;
  expected_events_hit: string[];
  expected_events_missed: string[];
  invalidated: boolean;
  time_to_confirmation_ms: number | null;
  time_to_invalidation_ms: number | null;
  path_status: HtfPathStatus | string;
};

function leg(
  side: HtfThesisSide,
  summary: string,
  structure: HtfStructureLabel,
  phase: HtfPhase,
  anchor_tf: HtfTfFrame
): HtfThesisLeg {
  return { side, summary, structure, phase, anchor_tf };
}

function beyondClose(
  close: number,
  kind: ThesisConditionKind,
  level: number | null
): boolean {
  if (level == null || !Number.isFinite(level)) return false;
  const eps = Math.max(Math.abs(close) * 1e-5, 1e-9);
  if (kind === 'CLOSE_ABOVE' || kind === 'CROSS_ABOVE') return close > level + eps;
  if (kind === 'CLOSE_BELOW' || kind === 'CROSS_BELOW') return close < level - eps;
  return false;
}

function buildConditions(
  bias: TfDir,
  phase: HtfPhase,
  anchor: HtfTfFacts | null,
  freezePrice: number
): {
  expected_events: string[];
  confirmation: ThesisCondition[];
  invalidation: ThesisCondition[];
  invalidation_text: string;
  description: string;
} {
  const tf = anchor?.tf || '30m';
  const sh = anchor?.structure_high ?? null;
  const sl = anchor?.structure_low ?? null;
  const confirmation: ThesisCondition[] = [];
  const invalidation: ThesisCondition[] = [];
  const expected_events: string[] = [];
  let description: string;
  let invalidation_text: string;

  const sat = (kind: ThesisConditionKind, level: number | null) =>
    beyondClose(freezePrice, kind, level);

  if (bias === 'UP') {
    if (phase === 'PULLBACK') {
      description = 'Correction toward HL/discount, then continuation impulse UP';
      expected_events.push('hold_hl', 'impulse_up', 'new_hh_or_extension');
      if (sl != null) {
        confirmation.push({
          id: 'c_hold_hl',
          kind: 'STRUCTURAL_HOLD',
          level: sl,
          tf,
          description: `Hold above HL ${sl.toFixed(2)} then impulse close`,
          satisfied_at_creation: freezePrice > sl,
        });
        invalidation.push({
          id: 'i_break_hl',
          kind: 'CROSS_BELOW',
          level: sl,
          tf,
          description: `Closed break below HL ${sl.toFixed(2)}`,
          satisfied_at_creation: sat('CROSS_BELOW', sl),
        });
      }
      if (sh != null) {
        confirmation.push({
          id: 'c_ext_high',
          kind: 'CROSS_ABOVE',
          level: sh,
          tf,
          description: `Cross above structure high ${sh.toFixed(2)} after thesis`,
          satisfied_at_creation: sat('CROSS_ABOVE', sh),
        });
      }
      confirmation.push({
        id: 'c_accept_up',
        kind: 'ACCEPTANCE_UP',
        level: sh,
        tf,
        description: 'Two-close acceptance above structure high',
        satisfied_at_creation: false,
      });
      invalidation_text =
        sl != null
          ? `Closed break below HL ${sl.toFixed(2)} invalidates bullish path`
          : 'Closed break of bullish structure invalidates path';
    } else if (phase === 'COMPRESSION' || phase === 'RANGE_BALANCE') {
      description = 'Compression/balance — wait accepted UP break';
      expected_events.push('compress', 'acceptance_up', 'expansion_up');
      if (sh != null) {
        confirmation.push({
          id: 'c_accept_up',
          kind: 'ACCEPTANCE_UP',
          level: sh,
          tf,
          description: `Acceptance above ${sh.toFixed(2)}`,
          satisfied_at_creation: false,
        });
      }
      if (sl != null) {
        invalidation.push({
          id: 'i_accept_down',
          kind: 'ACCEPTANCE_DOWN',
          level: sl,
          tf,
          description: `Acceptance below ${sl.toFixed(2)}`,
          satisfied_at_creation: false,
        });
      }
      invalidation_text = 'Accepted downside break invalidates bullish compression path';
    } else {
      description = 'Bullish impulse/expansion — hold structure, seek extension';
      expected_events.push('hold_structure', 'extension_up', 'new_hh');
      if (sh != null) {
        confirmation.push({
          id: 'c_new_hh',
          kind: 'NEW_HH',
          level: sh,
          tf,
          description: `New HH / close above ${sh.toFixed(2)} after thesis`,
          satisfied_at_creation: sat('CROSS_ABOVE', sh),
        });
      }
      if (sl != null) {
        invalidation.push({
          id: 'i_break_hl',
          kind: 'CROSS_BELOW',
          level: sl,
          tf,
          description: `Closed break below ${sl.toFixed(2)}`,
          satisfied_at_creation: sat('CROSS_BELOW', sl),
        });
      }
      invalidation_text =
        sl != null
          ? `Closed break below ${sl.toFixed(2)} invalidates UP path`
          : 'Loss of bullish structure invalidates path';
    }
  } else if (bias === 'DOWN') {
    if (phase === 'PULLBACK') {
      description = 'Correction toward LH/premium, then continuation impulse DOWN';
      expected_events.push('hold_lh', 'impulse_down', 'new_ll_or_extension');
      if (sh != null) {
        confirmation.push({
          id: 'c_hold_lh',
          kind: 'STRUCTURAL_HOLD',
          level: sh,
          tf,
          description: `Hold below LH ${sh.toFixed(2)} then impulse close`,
          satisfied_at_creation: freezePrice < sh,
        });
        invalidation.push({
          id: 'i_break_lh',
          kind: 'CROSS_ABOVE',
          level: sh,
          tf,
          description: `Closed break above LH ${sh.toFixed(2)}`,
          satisfied_at_creation: sat('CROSS_ABOVE', sh),
        });
      }
      if (sl != null) {
        confirmation.push({
          id: 'c_ext_low',
          kind: 'CROSS_BELOW',
          level: sl,
          tf,
          description: `Cross below structure low ${sl.toFixed(2)} after thesis`,
          satisfied_at_creation: sat('CROSS_BELOW', sl),
        });
      }
      confirmation.push({
        id: 'c_accept_down',
        kind: 'ACCEPTANCE_DOWN',
        level: sl,
        tf,
        description: 'Two-close acceptance below structure low',
        satisfied_at_creation: false,
      });
      invalidation_text =
        sh != null
          ? `Closed break above LH ${sh.toFixed(2)} invalidates bearish path`
          : 'Closed break of bearish structure invalidates path';
    } else if (phase === 'COMPRESSION' || phase === 'RANGE_BALANCE') {
      description = 'Compression/balance — wait accepted DOWN break';
      expected_events.push('compress', 'acceptance_down', 'expansion_down');
      if (sl != null) {
        confirmation.push({
          id: 'c_accept_down',
          kind: 'ACCEPTANCE_DOWN',
          level: sl,
          tf,
          description: `Acceptance below ${sl.toFixed(2)}`,
          satisfied_at_creation: false,
        });
      }
      if (sh != null) {
        invalidation.push({
          id: 'i_accept_up',
          kind: 'ACCEPTANCE_UP',
          level: sh,
          tf,
          description: `Acceptance above ${sh.toFixed(2)}`,
          satisfied_at_creation: false,
        });
      }
      invalidation_text = 'Accepted upside break invalidates bearish compression path';
    } else {
      description = 'Bearish impulse/expansion — hold structure, seek extension';
      expected_events.push('hold_structure', 'extension_down', 'new_ll');
      if (sl != null) {
        confirmation.push({
          id: 'c_new_ll',
          kind: 'NEW_LL',
          level: sl,
          tf,
          description: `New LL / close below ${sl.toFixed(2)} after thesis`,
          satisfied_at_creation: sat('CROSS_BELOW', sl),
        });
      }
      if (sh != null) {
        invalidation.push({
          id: 'i_break_lh',
          kind: 'CROSS_ABOVE',
          level: sh,
          tf,
          description: `Closed break above ${sh.toFixed(2)}`,
          satisfied_at_creation: sat('CROSS_ABOVE', sh),
        });
      }
      invalidation_text =
        sh != null
          ? `Closed break above ${sh.toFixed(2)} invalidates DOWN path`
          : 'Loss of bearish structure invalidates path';
    }
  } else {
    description = 'No clear HTF path — wait for accepted range break';
    expected_events.push('wait_break_accept');
    if (sh != null) {
      confirmation.push({
        id: 'c_accept_up',
        kind: 'ACCEPTANCE_UP',
        level: sh,
        tf,
        description: `Acceptance above ${sh.toFixed(2)}`,
        satisfied_at_creation: false,
      });
    }
    if (sl != null) {
      confirmation.push({
        id: 'c_accept_down',
        kind: 'ACCEPTANCE_DOWN',
        level: sl,
        tf,
        description: `Acceptance below ${sl.toFixed(2)}`,
        satisfied_at_creation: false,
      });
    }
    invalidation_text = 'Path undefined until hierarchical bias forms';
  }

  return {
    expected_events,
    confirmation,
    invalidation,
    invalidation_text,
    description,
  };
}

function createThesisLegs(
  interp: HtfInterpretation
): { primary: HtfThesisLeg; alternative: HtfThesisLeg } {
  const anchor = interp.anchor_tf || '30m';
  const structure = interp.structure;
  const phase = interp.phase;
  if (interp.bias === 'UP') {
    return {
      primary: leg(
        'BUY',
        phase === 'PULLBACK'
          ? `${anchor} bullish · correction — expect HL hold then continuation`
          : `${anchor} bullish (${structure}) · ${phase.toLowerCase()} — work as buyer`,
        structure,
        phase,
        anchor
      ),
      alternative: leg(
        'SELL',
        interp.maturity === 'EXHAUSTED'
          ? `Alt: exhausted ${anchor} rally — fade only on rejection+acceptance down`
          : `Alt: failed HL / structural transition flips to SELL`,
        structure === 'HH' || structure === 'HL' ? 'LH' : 'RANGE',
        'TRANSITION',
        anchor
      ),
    };
  }
  if (interp.bias === 'DOWN') {
    return {
      primary: leg(
        'SELL',
        phase === 'PULLBACK'
          ? `${anchor} bearish · correction — expect LH hold then continuation`
          : `${anchor} bearish (${structure}) · ${phase.toLowerCase()} — work as seller`,
        structure,
        phase,
        anchor
      ),
      alternative: leg(
        'BUY',
        interp.maturity === 'EXHAUSTED'
          ? `Alt: exhausted ${anchor} selloff — fade only on rejection+acceptance up`
          : `Alt: failed LH / structural transition flips to BUY`,
        structure === 'LL' || structure === 'LH' ? 'HL' : 'RANGE',
        'TRANSITION',
        anchor
      ),
    };
  }
  return {
    primary: leg(
      'WAIT',
      `${anchor} unclear (${structure}) — no HTF side`,
      structure,
      phase,
      anchor
    ),
    alternative: leg('WAIT', 'Alt: wait accepted break', 'RANGE', 'COMPRESSION', anchor),
  };
}

/**
 * Create a frozen Market Thesis. State always starts PENDING —
 * never CONFIRMED because price already sits beyond a level.
 */
export function createMarketThesis(
  facts: HtfFactsBundle,
  interp: HtfInterpretation,
  createdAt: number
): MarketThesis {
  const anchorFacts = interp.anchor_tf
    ? factsFrame(facts, interp.anchor_tf)
    : facts.frames[0] || null;
  const freezePrice =
    anchorFacts?.last_close ??
    facts.frames[facts.frames.length - 1]?.last_close ??
    0;
  const built = buildConditions(interp.bias, interp.phase, anchorFacts, freezePrice);
  const legs = createThesisLegs(interp);
  const last_index_by_tf: Partial<Record<HtfTfFrame, number>> = {};
  const last_time_by_tf: Partial<Record<HtfTfFrame, number | null>> = {};
  for (const f of facts.frames) {
    last_index_by_tf[f.tf] = f.last_index;
    last_time_by_tf[f.tf] = f.last_open_time_ms;
  }

  return {
    primary_thesis: legs.primary,
    alternative_thesis: legs.alternative,
    expected_events: built.expected_events,
    confirmation_conditions: built.confirmation,
    invalidation_conditions: built.invalidation,
    state: 'PENDING',
    score: interp.score,
    created_at: createdAt,
    freeze: { price: freezePrice, last_index_by_tf, last_time_by_tf },
    confirmed_at: null,
    invalidated_at: null,
    events_hit: [],
  };
}

/** Candles that closed strictly after thesis freeze (by index or time). */
export function postThesisCandles(
  facts: HtfTfFacts,
  thesis: MarketThesis
): HtfTimedCandle[] {
  const freezeIdx = thesis.freeze.last_index_by_tf[facts.tf];
  const freezeTime = thesis.freeze.last_time_by_tf[facts.tf];
  return facts.candles.filter((c, i) => {
    if (freezeTime != null && c.open_time_ms != null && Number.isFinite(c.open_time_ms)) {
      return c.open_time_ms > freezeTime;
    }
    if (freezeIdx != null && Number.isFinite(freezeIdx)) {
      // After freeze the book may grow — compare absolute index in current book
      // Prefer time; index fallback: any candle beyond freeze length snapshot
      return i > freezeIdx;
    }
    // No freeze marker — treat none as post-thesis (fail closed)
    return false;
  });
}

function crossingEvent(
  candles: HtfTimedCandle[],
  kind: 'CROSS_ABOVE' | 'CROSS_BELOW',
  level: number
): boolean {
  if (candles.length < 1) return false;
  const eps = Math.max(Math.abs(level) * 1e-5, 1e-9);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const prevClose =
      i === 0
        ? null
        : candles[i - 1]!.close;
    if (kind === 'CROSS_ABOVE') {
      const now = c.close > level + eps;
      const was = prevClose == null ? false : prevClose <= level + eps;
      // Need actual cross: previous not above, now above
      if (now && (prevClose == null || was)) {
        // If first post-thesis candle is already above, require it crossed from open
        if (prevClose == null) {
          if (c.open <= level + eps && c.close > level + eps) return true;
        } else if (was && now) return true;
      }
    } else {
      const now = c.close < level - eps;
      const was = prevClose == null ? false : prevClose >= level - eps;
      if (now && (prevClose == null || was)) {
        if (prevClose == null) {
          if (c.open >= level - eps && c.close < level - eps) return true;
        } else if (was && now) return true;
      }
    }
  }
  return false;
}

function acceptanceAfter(
  facts: HtfTfFacts,
  thesis: MarketThesis,
  side: 'UP' | 'DOWN',
  level: number | null
): boolean {
  if (level == null) return false;
  const post = postThesisCandles(facts, thesis);
  if (post.length < 2) return false;
  const eps = Math.max(Math.abs(level) * 1e-5, 1e-9);
  for (let i = 1; i < post.length; i++) {
    const a = post[i]!;
    const b = post[i - 1]!;
    if (side === 'UP' && a.close > level + eps && b.close > level + eps) return true;
    if (side === 'DOWN' && a.close < level - eps && b.close < level - eps) return true;
  }
  return false;
}

function conditionMet(
  cond: ThesisCondition,
  facts: HtfFactsBundle,
  thesis: MarketThesis
): boolean {
  const tfFacts = factsFrame(facts, cond.tf) || facts.frames[0];
  if (!tfFacts) return false;
  const post = postThesisCandles(tfFacts, thesis);
  if (!post.length && cond.kind !== 'STRUCTURAL_HOLD') return false;

  switch (cond.kind) {
    case 'CROSS_ABOVE':
      if (cond.level == null) return false;
      if (cond.satisfied_at_creation) {
        // Need leave then re-cross
        const left = post.some((c) => c.close <= cond.level!);
        if (!left) return false;
        return crossingEvent(post, 'CROSS_ABOVE', cond.level);
      }
      return crossingEvent(post, 'CROSS_ABOVE', cond.level);
    case 'CROSS_BELOW':
      if (cond.level == null) return false;
      if (cond.satisfied_at_creation) {
        const left = post.some((c) => c.close >= cond.level!);
        if (!left) return false;
        return crossingEvent(post, 'CROSS_BELOW', cond.level);
      }
      return crossingEvent(post, 'CROSS_BELOW', cond.level);
    case 'CLOSE_ABOVE':
    case 'CLOSE_BELOW':
      // Legacy aliases → treat as cross events (never level-already-true)
      return conditionMet(
        {
          ...cond,
          kind: cond.kind === 'CLOSE_ABOVE' ? 'CROSS_ABOVE' : 'CROSS_BELOW',
        },
        facts,
        thesis
      );
    case 'ACCEPTANCE_UP':
      return acceptanceAfter(tfFacts, thesis, 'UP', cond.level);
    case 'ACCEPTANCE_DOWN':
      return acceptanceAfter(tfFacts, thesis, 'DOWN', cond.level);
    case 'NEW_HH':
    case 'NEW_HL':
    case 'NEW_LL':
    case 'NEW_LH': {
      // New swing printed after freeze with matching structure step
      const highs = tfFacts.swing_highs.filter((s) => {
        const t = s.open_time_ms;
        const ft = thesis.freeze.last_time_by_tf[tfFacts.tf];
        if (t != null && ft != null) return t > ft;
        return s.index > (thesis.freeze.last_index_by_tf[tfFacts.tf] ?? -1);
      });
      const lows = tfFacts.swing_lows.filter((s) => {
        const t = s.open_time_ms;
        const ft = thesis.freeze.last_time_by_tf[tfFacts.tf];
        if (t != null && ft != null) return t > ft;
        return s.index > (thesis.freeze.last_index_by_tf[tfFacts.tf] ?? -1);
      });
      if (cond.kind === 'NEW_HH' && highs.length && cond.level != null) {
        return highs.some((h) => h.price > cond.level!);
      }
      if (cond.kind === 'NEW_LL' && lows.length && cond.level != null) {
        return lows.some((l) => l.price < cond.level!);
      }
      if (cond.kind === 'NEW_HL' && lows.length >= 1) return true;
      if (cond.kind === 'NEW_LH' && highs.length >= 1) return true;
      // Also allow cross as proxy for extension
      if (cond.kind === 'NEW_HH' && cond.level != null) {
        return crossingEvent(post, 'CROSS_ABOVE', cond.level);
      }
      if (cond.kind === 'NEW_LL' && cond.level != null) {
        return crossingEvent(post, 'CROSS_BELOW', cond.level);
      }
      return false;
    }
    case 'STRUCTURAL_HOLD': {
      // Hold = no invalidating cross yet + at least one post candle closed on hold side
      if (cond.level == null || post.length < 1) return false;
      const eps = Math.max(Math.abs(cond.level) * 1e-5, 1e-9);
      const broken = post.some((c) => c.close < cond.level! - eps);
      if (broken) return false;
      // Require a later impulse in hold direction (displacement)
      return post.some((c) => c.close > c.open && Math.abs(c.close - c.open) > eps);
    }
    default:
      return false;
  }
}

/**
 * Advance frozen thesis state from live facts.
 * Never mutates primary/alt/conditions/score/created_at.
 */
export function evaluateThesisEvents(
  thesis: MarketThesis,
  liveFacts: HtfFactsBundle,
  nowMs?: number
): MarketThesis {
  if (
    thesis.state === 'INVALIDATED' ||
    thesis.state === 'CONFIRMED' ||
    thesis.state === 'EXPIRED'
  ) {
    return thesis;
  }
  const now = nowMs ?? Date.now();
  const events_hit = [...thesis.events_hit];

  for (const cond of thesis.invalidation_conditions) {
    if (cond.satisfied_at_creation) continue; // already broken at birth — ignore until re-cross
    if (conditionMet(cond, liveFacts, thesis)) {
      events_hit.push(`invalidated:${cond.id}`);
      return {
        ...thesis,
        state: 'INVALIDATED',
        invalidated_at: thesis.invalidated_at ?? now,
        events_hit,
      };
    }
  }
  // Re-cross invalidation if was satisfied at creation
  for (const cond of thesis.invalidation_conditions) {
    if (!cond.satisfied_at_creation) continue;
    if (conditionMet(cond, liveFacts, thesis)) {
      events_hit.push(`invalidated:${cond.id}`);
      return {
        ...thesis,
        state: 'INVALIDATED',
        invalidated_at: thesis.invalidated_at ?? now,
        events_hit,
      };
    }
  }

  let confirmHits = 0;
  for (const cond of thesis.confirmation_conditions) {
    if (conditionMet(cond, liveFacts, thesis)) {
      confirmHits += 1;
      if (!events_hit.includes(`confirm:${cond.id}`)) {
        events_hit.push(`confirm:${cond.id}`);
      }
    }
  }

  if (confirmHits >= 1) {
    const next: HtfPathStatus =
      thesis.state === 'CONFIRMING' || confirmHits >= 2 ? 'CONFIRMED' : 'CONFIRMING';
    return {
      ...thesis,
      state: next,
      confirmed_at:
        next === 'CONFIRMED' || next === 'CONFIRMING'
          ? thesis.confirmed_at ?? now
          : thesis.confirmed_at,
      events_hit,
    };
  }

  return { ...thesis, events_hit };
}

/**
 * Build live HTF state. New thesis always PENDING (no confirm-from-spot).
 */
export function buildHtfMarketState(book: HtfCandleBook): HTFMarketState {
  const now = book.now_ms ?? Date.now();
  const facts = buildHtfFacts(book);
  const interpretation = interpretHtf(facts);
  const thesis = createMarketThesis(facts, interpretation, now);
  const summary = interpretation.summary;
  const summary_lv =
    interpretation.bias === 'UP'
      ? `HTF ${summary} — primārā tēze BUY (${interpretation.phase.toLowerCase()}).`
      : interpretation.bias === 'DOWN'
        ? `HTF ${summary} — primārā tēze SELL (${interpretation.phase.toLowerCase()}).`
        : `HTF ${summary} — nav skaidras puses.`;

  return {
    at_ms: now,
    facts,
    interpretation,
    thesis,
    bias: interpretation.bias,
    path_status: thesis.state,
    summary,
    summary_lv,
    score: interpretation.score,
  };
}

/**
 * Keep frozen thesis; refresh facts/interpretation for UI; advance thesis.state only.
 */
export function advanceFrozenThesis(
  frozen: HTFMarketState,
  book: HtfCandleBook
): HTFMarketState {
  const now = book.now_ms ?? Date.now();
  const facts = buildHtfFacts(book);
  const interpretation = interpretHtf(facts);
  const thesis = evaluateThesisEvents(frozen.thesis, facts, now);
  return {
    ...frozen,
    at_ms: now,
    facts,
    interpretation,
    thesis,
    // Frozen working bias/score for learning stay on thesis; live bias for UI mind
    bias: frozen.thesis.primary_thesis.side === 'BUY'
      ? 'UP'
      : frozen.thesis.primary_thesis.side === 'SELL'
        ? 'DOWN'
        : frozen.bias,
    path_status: thesis.state,
    summary: frozen.summary,
    summary_lv: frozen.summary_lv,
    score: frozen.thesis.score,
  };
}

/** @deprecated use advanceFrozenThesis */
export function trackHtfPathLive(input: {
  entry_htf: HTFMarketState;
  live_price: number | null | undefined;
  live_htf?: HTFMarketState | null;
  live_book?: HtfCandleBook | null;
}): HtfPathStatus {
  if (input.live_book) {
    return advanceFrozenThesis(input.entry_htf, input.live_book).path_status;
  }
  // Fallback: hierarchical flip only (no level-already-true confirm)
  const entry = input.entry_htf;
  if (
    input.live_htf &&
    entry.bias !== 'FLAT' &&
    input.live_htf.bias !== 'FLAT' &&
    input.live_htf.bias !== entry.bias &&
    input.live_htf.score >= 0.55 &&
    input.live_htf.interpretation.phase === 'TRANSITION'
  ) {
    return 'INVALIDATED';
  }
  return entry.path_status;
}

export function compactHtfMarketState(
  state: HTFMarketState | null | undefined
): HTFMarketStateCompact | null {
  if (!state) return null;
  const anchor = state.thesis.primary_thesis.anchor_tf;
  const frame = state.facts.frames.find((f) => f.tf === anchor) || state.facts.frames[0];
  const inv =
    state.thesis.invalidation_conditions.map((c) => c.description).join('; ') ||
    'n/a';
  return {
    bias: state.bias,
    structure: state.thesis.primary_thesis.structure,
    phase: state.thesis.primary_thesis.phase,
    maturity: state.interpretation.maturity,
    volatility: frame?.volatility ?? 'NORMAL',
    primary_side: state.thesis.primary_thesis.side,
    alt_side: state.thesis.alternative_thesis.side,
    path_status: state.thesis.state,
    score: state.thesis.score,
    confidence: state.thesis.score,
    anchor_tf: anchor,
    liquidity: frame?.liquidity
      ? `${frame.liquidity.kind}:${frame.liquidity.reaction}`
      : 'NONE',
    breakout: frame?.breakout
      ? `${frame.breakout.side}:${frame.breakout.status}`
      : 'NONE',
    price_location: frame?.price_location ?? 'MID_RANGE',
    expected_path: state.thesis.expected_events.join(','),
    invalidation: inv,
    thesis_created_at: state.thesis.created_at,
    expected_events: state.thesis.expected_events,
    events_hit: state.thesis.events_hit,
    confirmed_at: state.thesis.confirmed_at,
    invalidated_at: state.thesis.invalidated_at,
  };
}

export function measureThesisOutcome(input: {
  entry: HTFMarketState | HTFMarketStateCompact | null | undefined;
  exit_phase?: string | null;
  direction: 'BUY' | 'SELL';
  pnl_pts: number | null;
  mfe: number;
  mae: number;
}): HtfThesisOutcome {
  const entry = input.entry;
  if (!entry) {
    return {
      thesis_direction_correct: null,
      phase_at_entry: null,
      phase_at_exit: input.exit_phase ?? null,
      expected_events_hit: [],
      expected_events_missed: [],
      invalidated: false,
      time_to_confirmation_ms: null,
      time_to_invalidation_ms: null,
      path_status: 'PENDING',
    };
  }
  const isFull = 'thesis' in entry;
  const primarySide = isFull
    ? entry.thesis.primary_thesis.side
    : String((entry as HTFMarketStateCompact).primary_side);
  const phaseEntry = isFull
    ? entry.thesis.primary_thesis.phase
    : String((entry as HTFMarketStateCompact).phase);
  const path = isFull
    ? entry.thesis.state
    : String((entry as HTFMarketStateCompact).path_status);
  const eventsHit = isFull
    ? entry.thesis.events_hit
    : (entry as HTFMarketStateCompact).events_hit || [];
  const expected = isFull
    ? entry.thesis.expected_events
    : (entry as HTFMarketStateCompact).expected_events || [];
  const created = isFull
    ? entry.thesis.created_at
    : (entry as HTFMarketStateCompact).thesis_created_at;
  const confirmedAt = isFull
    ? entry.thesis.confirmed_at
    : (entry as HTFMarketStateCompact).confirmed_at;
  const invalidatedAt = isFull
    ? entry.thesis.invalidated_at
    : (entry as HTFMarketStateCompact).invalidated_at;

  let thesis_direction_correct: boolean | null = null;
  if (primarySide === 'BUY' || primarySide === 'SELL') {
    // Direction correct if trade side matched thesis and realized positive path,
    // or MFE in thesis direction exceeded MAE when sides match.
    if (input.direction === primarySide) {
      if (input.pnl_pts != null && Number.isFinite(input.pnl_pts)) {
        thesis_direction_correct = input.pnl_pts > 0;
      } else {
        thesis_direction_correct = input.mfe > Math.abs(input.mae);
      }
    } else {
      thesis_direction_correct = false;
    }
  }

  return {
    thesis_direction_correct,
    phase_at_entry: phaseEntry,
    phase_at_exit: input.exit_phase ?? null,
    expected_events_hit: eventsHit.filter((e) => e.startsWith('confirm:')),
    expected_events_missed: expected.filter(
      (e) => !eventsHit.some((h) => h.includes(e) || h.endsWith(e))
    ),
    invalidated: path === 'INVALIDATED',
    time_to_confirmation_ms:
      created != null && confirmedAt != null
        ? Math.max(0, confirmedAt - created)
        : null,
    time_to_invalidation_ms:
      created != null && invalidatedAt != null
        ? Math.max(0, invalidatedAt - created)
        : null,
    path_status: path,
  };
}

export function htfExpectancyKey(input: {
  structure?: string | null;
  phase?: string | null;
  setup?: string | null;
  side?: string | null;
}): string {
  const s = String(input.structure || 'UNKNOWN').toUpperCase();
  const p = String(input.phase || 'UNKNOWN').toUpperCase();
  const setup = String(input.setup || 'NONE').toUpperCase();
  const side = String(input.side || 'NONE').toUpperCase();
  return `${s}|${p}|${setup}|${side}`;
}

export function htfFrameDir(
  state: HTFMarketState | null | undefined,
  tf: HtfTfFrame
): TfDir | null {
  const f = state?.interpretation.frames.find((x) => x.tf === tf);
  return f ? f.trend : null;
}

/** History depth helpers for Capital fetch sizing. */
export function htfFetchMax(tf: HtfTfFrame): number {
  // +1 for forming tip that will be dropped
  return HTF_HISTORY_TARGET[tf] + 1;
}

export function htfHistoryAdequate(
  tf: HtfTfFrame,
  rawCount: number
): boolean {
  // raw includes forming tip
  const closed = Math.max(0, rawCount >= 2 ? rawCount - 1 : rawCount);
  return closed >= HTF_HISTORY_MIN[tf];
}

/** Compat: old evaluateHtfPathStatus removed from public confirm-by-level API */
export function evaluateHtfPathStatus(): never {
  throw new Error(
    'evaluateHtfPathStatus removed — use evaluateThesisEvents / advanceFrozenThesis'
  );
}
