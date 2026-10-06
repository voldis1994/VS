/**
 * HTF INTERPRETATION — reads HTF FACTS into market narrative.
 *
 * Hierarchy 4H → 1H → 30m → 15m → 5m. No timeframe majority voting.
 * Opposite lower-TF move is NOT automatically PULLBACK — must distinguish
 * correction (structure holds) vs structural transition (HL/LH broken).
 */
import type { TfDir } from './multiTfRead.js';
import {
  FRAME_ORDER,
  type HtfFactsBundle,
  type HtfStructureLabel,
  type HtfTfFacts,
  type HtfTfFrame,
  type HtfVolatility,
} from './htfFacts.js';

export type HtfTrendMaturity =
  | 'EARLY'
  | 'MID'
  | 'LATE'
  | 'EXHAUSTED'
  | 'NONE';

export type HtfPhase =
  | 'IMPULSE'
  | 'PULLBACK'
  | 'TRANSITION'
  | 'COMPRESSION'
  | 'EXPANSION'
  | 'RANGE_BALANCE'
  | 'REVERSAL_CANDIDATE';

export type HtfTfInterpretation = {
  tf: HtfTfFrame;
  trend: TfDir;
  phase: HtfPhase;
  maturity: HtfTrendMaturity;
  structure: HtfStructureLabel;
  volatility: HtfVolatility;
  /** Heuristic score 0..1 — NOT a calibrated probability */
  score: number;
  /** Why opposite move was classified this way */
  opposite_read: 'CORRECTION' | 'STRUCTURAL_TRANSITION' | 'NONE';
};

export type HtfInterpretation = {
  frames: HtfTfInterpretation[];
  /** Hierarchical working bias (4H leads) */
  bias: TfDir;
  phase: HtfPhase;
  anchor_tf: HtfTfFrame | null;
  structure: HtfStructureLabel;
  maturity: HtfTrendMaturity;
  /** Heuristic score — not probability */
  score: number;
  summary: string;
};

function structureBias(label: HtfStructureLabel): TfDir {
  if (label === 'HH' || label === 'HL') return 'UP';
  if (label === 'LL' || label === 'LH') return 'DOWN';
  return 'FLAT';
}

/**
 * Exhaustion needs failed extension / declining displacement — not zone alone.
 */
export function maturityFromFacts(f: HtfTfFacts, trend: TfDir, phase: HtfPhase): HtfTrendMaturity {
  if (trend === 'FLAT') return 'NONE';
  if (phase === 'TRANSITION' || phase === 'COMPRESSION' || phase === 'RANGE_BALANCE') {
    return 'NONE';
  }
  const swings = f.swing_highs.length + f.swing_lows.length;
  if (swings <= 2) return 'EARLY';

  const brk = f.breakout;
  const failedExt =
    brk?.status === 'REJECTION' &&
    ((trend === 'UP' && brk.side === 'UP') || (trend === 'DOWN' && brk.side === 'DOWN'));
  const weakDisp =
    (trend === 'UP' && f.displacement < 0.35 && (f.structure_pos ?? 0) >= 0.8) ||
    (trend === 'DOWN' && f.displacement > -0.35 && (f.structure_pos ?? 1) <= 0.2);
  const liqFail =
    (f.liquidity?.kind === 'SWEEP_HIGH' &&
      trend === 'UP' &&
      f.liquidity.reaction === 'RECLAIMED') ||
    (f.liquidity?.kind === 'SWEEP_LOW' &&
      trend === 'DOWN' &&
      f.liquidity.reaction === 'RECLAIMED');

  if (failedExt && (weakDisp || liqFail)) return 'EXHAUSTED';
  if (swings >= 6 && weakDisp && (f.structure_pos != null && (f.structure_pos >= 0.85 || f.structure_pos <= 0.15))) {
    return 'LATE';
  }
  if (swings >= 5) return 'LATE';
  if (swings >= 3) return 'MID';
  return 'EARLY';
}

/**
 * Per-frame phase from facts (no hierarchy yet).
 */
export function phaseFromFacts(f: HtfTfFacts, trend: TfDir): HtfPhase {
  if (f.volatility === 'LOW' && (f.structure_label === 'RANGE' || f.structure_label === 'UNKNOWN')) {
    return 'COMPRESSION';
  }
  if (f.breakout?.status === 'ACCEPTANCE') return 'EXPANSION';
  if (f.breakout?.status === 'REJECTION') return 'REVERSAL_CANDIDATE';

  if (trend === 'FLAT' || f.structure_label === 'RANGE') {
    return f.volatility === 'LOW' ? 'COMPRESSION' : 'RANGE_BALANCE';
  }

  // Correction vs impulse on same frame
  if (trend === 'UP' && f.last_dir === 'DOWN') {
    const depth = f.pullback_depth;
    // Structural break against HL → transition, not pullback
    const brokeHl =
      f.structure_low != null &&
      f.structural_breaks.some(
        (b) => b.side === 'DOWN' && b.confirm_index >= f.last_index - 2
      );
    if (brokeHl) return 'TRANSITION';
    if (depth != null && depth > 0.85) return 'TRANSITION';
    return 'PULLBACK';
  }
  if (trend === 'DOWN' && f.last_dir === 'UP') {
    const brokeLh =
      f.structure_high != null &&
      f.structural_breaks.some(
        (b) => b.side === 'UP' && b.confirm_index >= f.last_index - 2
      );
    if (brokeLh) return 'TRANSITION';
    const depth = f.pullback_depth;
    if (depth != null && depth > 0.85) return 'TRANSITION';
    return 'PULLBACK';
  }

  if (Math.abs(f.displacement) >= 1.1) return 'IMPULSE';
  if (f.volatility === 'HIGH' || f.volatility === 'EXTREME') return 'EXPANSION';
  return 'IMPULSE';
}

function scoreFromFrame(f: HtfTfFacts, trend: TfDir, phase: HtfPhase, maturity: HtfTrendMaturity): number {
  let s = 0.4;
  if (f.structure_label === 'HH' || f.structure_label === 'LL') s += 0.18;
  else if (f.structure_label === 'HL' || f.structure_label === 'LH') s += 0.1;
  if (phase === 'IMPULSE' || phase === 'EXPANSION') s += 0.1;
  if (phase === 'PULLBACK') s += 0.05;
  if (phase === 'TRANSITION' || phase === 'REVERSAL_CANDIDATE') s -= 0.08;
  if (maturity === 'EXHAUSTED') s -= 0.15;
  if (maturity === 'EARLY') s += 0.04;
  if (f.breakout?.status === 'ACCEPTANCE') s += 0.08;
  if (f.breakout?.status === 'REJECTION') s -= 0.06;
  if (f.liquidity?.reaction === 'RECLAIMED') s += 0.04;
  if (trend === 'FLAT') s -= 0.1;
  return Math.max(0.1, Math.min(0.95, s));
}

export function interpretTf(f: HtfTfFacts): HtfTfInterpretation {
  let trend = structureBias(f.structure_label);
  // Net path can nullify stale structure label
  if (f.candles.length >= 8) {
    const first = f.candles[Math.max(0, f.candles.length - 16)]!;
    const net = f.last_close - first.open;
    const thr = Math.max(Math.abs(f.last_close) * 0.0005, 1e-9);
    if (trend === 'UP' && net < -thr * 2) trend = 'FLAT';
    if (trend === 'DOWN' && net > thr * 2) trend = 'FLAT';
  }
  const phase = phaseFromFacts(f, trend);
  const maturity = maturityFromFacts(f, trend, phase);
  return {
    tf: f.tf,
    trend,
    phase,
    maturity,
    structure: f.structure_label,
    volatility: f.volatility,
    score: scoreFromFrame(f, trend, phase, maturity),
    opposite_read: 'NONE',
  };
}

/**
 * Classify lower-TF opposite move vs higher bias.
 * CORRECTION = structure of higher TF still intact.
 * STRUCTURAL_TRANSITION = HL/LH (or equivalent) broken on child.
 */
export function classifyOppositeMove(
  higher: HtfTfFacts,
  child: HtfTfFacts,
  bias: TfDir
): 'CORRECTION' | 'STRUCTURAL_TRANSITION' {
  if (bias === 'UP') {
    // Structural transition only if higher HL/structure_low is closed-broken
    if (
      higher.structure_low != null &&
      child.last_close < higher.structure_low
    ) {
      const recentBreak = child.structural_breaks.some(
        (b) =>
          b.side === 'DOWN' &&
          b.confirm_index >= child.last_index - 3 &&
          (higher.structure_low == null || b.level <= higher.structure_low + 1e-9)
      );
      if (recentBreak || child.last_close < higher.structure_low) {
        // Require either a recorded break event or a decisive close through higher HL
        if (
          recentBreak ||
          (child.breakout?.status === 'ACCEPTANCE' && child.breakout.side === 'DOWN')
        ) {
          return 'STRUCTURAL_TRANSITION';
        }
      }
    }
    return 'CORRECTION';
  }
  if (bias === 'DOWN') {
    if (
      higher.structure_high != null &&
      child.last_close > higher.structure_high
    ) {
      const recentBreak = child.structural_breaks.some(
        (b) =>
          b.side === 'UP' &&
          b.confirm_index >= child.last_index - 3
      );
      if (
        recentBreak ||
        (child.breakout?.status === 'ACCEPTANCE' && child.breakout.side === 'UP')
      ) {
        return 'STRUCTURAL_TRANSITION';
      }
    }
    return 'CORRECTION';
  }
  return 'STRUCTURAL_TRANSITION';
}

/**
 * Hierarchical interpretation — higher TF leads; no majority vote.
 */
export function interpretHtf(facts: HtfFactsBundle): HtfInterpretation {
  const frames = facts.frames.map(interpretTf);
  if (!frames.length) {
    return {
      frames: [],
      bias: 'FLAT',
      phase: 'TRANSITION',
      anchor_tf: null,
      structure: 'UNKNOWN',
      maturity: 'NONE',
      score: 0,
      summary: 'HTF no frames',
    };
  }

  let anchor = frames.find((f) => f.trend === 'UP' || f.trend === 'DOWN') ?? null;
  if (!anchor) {
    const lowest = frames[frames.length - 1]!;
    return {
      frames,
      bias: 'FLAT',
      phase: lowest.phase === 'COMPRESSION' ? 'COMPRESSION' : 'RANGE_BALANCE',
      anchor_tf: lowest.tf,
      structure: lowest.structure,
      maturity: 'NONE',
      score: Math.min(...frames.map((f) => f.score)),
      summary: `HTF chop · ${lowest.tf} ${lowest.phase}`,
    };
  }

  let bias: TfDir = anchor.trend;
  let phase = anchor.phase;
  let score = anchor.score;
  const anchorFacts = facts.frames.find((f) => f.tf === anchor!.tf)!;

  for (const f of frames) {
    if (f.tf === anchor.tf) continue;
    const rank = FRAME_ORDER.indexOf(f.tf);
    const aRank = FRAME_ORDER.indexOf(anchor.tf);
    if (rank <= aRank) continue;
    const childFacts = facts.frames.find((x) => x.tf === f.tf);
    if (!childFacts) continue;

    if (f.trend === bias || f.trend === 'FLAT') {
      if (f.trend === bias) {
        if (f.phase === 'PULLBACK') phase = 'PULLBACK';
        else if (
          (f.phase === 'IMPULSE' || f.phase === 'EXPANSION') &&
          phase !== 'PULLBACK'
        ) {
          phase = f.phase;
          score = Math.min(0.95, score + 0.03);
        }
      } else if (f.phase === 'COMPRESSION') {
        phase = 'COMPRESSION';
        score = Math.max(0.15, score - 0.05);
      }
      continue;
    }

    // Opposite child — distinguish correction vs structural transition
    const read = classifyOppositeMove(anchorFacts, childFacts, bias);
    f.opposite_read = read;
    if (read === 'STRUCTURAL_TRANSITION') {
      // Immediate child structural break → flatten working bias
      if (rank - aRank === 1) {
        bias = 'FLAT';
        phase = 'TRANSITION';
        score = Math.max(0.15, Math.min(score, f.score) - 0.12);
        break;
      }
      phase = 'TRANSITION';
      score = Math.max(0.2, score - 0.1);
    } else {
      // Correction inside intact higher structure
      phase = 'PULLBACK';
      score = Math.max(0.25, score - 0.06);
    }
  }

  if (anchor.maturity === 'EXHAUSTED' && phase !== 'PULLBACK') {
    phase = phase === 'IMPULSE' ? 'REVERSAL_CANDIDATE' : phase;
    score = Math.max(0.15, score - 0.08);
  }

  const summary = `${FRAME_ORDER.map((tf) => {
    const fr = frames.find((x) => x.tf === tf);
    if (!fr) return `${tf}?`;
    const a = fr.trend === 'UP' ? '↑' : fr.trend === 'DOWN' ? '↓' : '→';
    return `${tf}${a}`;
  }).join(' ')} · bias ${bias} · ${phase} · score ${(score * 100).toFixed(0)}`;

  return {
    frames,
    bias,
    phase,
    anchor_tf: anchor.tf,
    structure: anchor.structure,
    maturity: anchor.maturity,
    score,
    summary,
  };
}
