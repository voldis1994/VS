/**
 * Best Outcome quality scoring — deterministic LIVE formula.
 *
 * BO = R + α × D × C
 *   R = UPL / MFE (retention)
 *   D = next signal direction (−1 same, +1 opposite, 0 none)
 *   C = next signal LIVE confirmation [0, 1]
 *
 * No ML, no historical training. Uses only live Feed / Candle / Momentum / Regime
 * data available in the current VS stack (Book/order-book is not used — not available).
 */

import { momentumBias } from './entryDirectionGate.js';
import type { CrossMarketPressure } from './crossMarketPressure.js';
import type { MultiFeedPrice } from './robotReader.js';
import { bodyPct, type TenSecBar } from './tenSecondOhlc.js';
import type { ExitSide } from './exitManage.js';

/** Next-signal influence weight — single config source. */
export const BEST_OUTCOME_ALPHA = 0.25;

/** LIVE confirmation at or above this is "strong". Below is weak/neutral → original MFE/UPL logic. */
export const LIVE_CONFIRM_STRONG = 0.6;

/** Confirmation component weights (must sum to 1 among available components). Book omitted — no order-book data. */
export const NEXT_SIGNAL_CONFIRM_WEIGHTS = {
  candle: 0.3,
  feed: 0.2,
  momentum: 0.25,
  regime: 0.25,
} as const;

export type NextSignalDirection = -1 | 0 | 1;

export type ConfirmComponents = {
  candle: number | null;
  feed: number | null;
  momentum: number | null;
  regime: number | null;
};

export type BestOutcomeQualityResult = {
  retention: number | null;
  next_signal_direction: NextSignalDirection;
  next_signal_confirm: number | null;
  confirm_components: ConfirmComponents;
  best_outcome_score: number | null;
  mfe: number;
  upl_at_exit: number;
  previous_side: ExitSide;
  next_side: ExitSide | null;
  alpha: number;
};

function sideAlignedBody(side: ExitSide, bar: TenSecBar): boolean {
  const bp = bodyPct(bar);
  return side === 'BUY' ? bp >= 0.00003 : bp <= -0.00003;
}

function regimeSupportsSide(side: ExitSide, regime?: string | null): boolean {
  const r = String(regime || '').toUpperCase();
  if (!r) return false;
  if (side === 'BUY') {
    return (
      r.includes('TREND_UP') ||
      r.includes('BREAKOUT_UP') ||
      r.includes('PULLBACK_UP') ||
      r === 'EXPANSION'
    );
  }
  return (
    r.includes('TREND_DOWN') ||
    r.includes('BREAKOUT_DOWN') ||
    r.includes('PULLBACK_DOWN') ||
    r === 'EXPANSION'
  );
}

function regimeOpposesSide(side: ExitSide, regime?: string | null): boolean {
  const r = String(regime || '').toUpperCase();
  if (!r) return false;
  if (side === 'BUY') {
    return r.includes('TREND_DOWN') || r.includes('BREAKOUT_DOWN') || r.includes('PULLBACK_DOWN');
  }
  return r.includes('TREND_UP') || r.includes('BREAKOUT_UP') || r.includes('PULLBACK_UP');
}

/** MFE retention R = UPL / MFE with safe division. */
export function computeRetention(
  mfe: number | null | undefined,
  upl: number | null | undefined
): number | null {
  if (mfe == null || upl == null || !Number.isFinite(mfe) || !Number.isFinite(upl)) return null;
  if (mfe <= 0) return null;
  const r = upl / mfe;
  if (!Number.isFinite(r)) return null;
  return r;
}

/** D coefficient: −1 same direction, +1 opposite, 0 no valid next signal. */
export function computeNextSignalDirection(
  previousSide: ExitSide,
  nextSide: ExitSide | null | undefined
): NextSignalDirection {
  if (!nextSide) return 0;
  if (nextSide === previousSide) return -1;
  return 1;
}

/** Candle confirmation from closed 10s bars — symmetric BUY/SELL. */
export function candleConfirm(side: ExitSide, bars: TenSecBar[] | null | undefined): number | null {
  const w = (bars || []).filter((b) => b && Number.isFinite(b.close));
  if (w.length < 2) return null;

  const scores: number[] = [];
  const last = w[w.length - 1]!;

  scores.push(sideAlignedBody(side, last) ? 1 : 0);

  let consec = 0;
  for (let i = w.length - 1; i >= 0; i--) {
    if (sideAlignedBody(side, w[i]!)) consec += 1;
    else break;
  }
  scores.push(Math.min(1, consec / 3));

  const window = w.slice(-Math.min(5, w.length));
  const net =
    (window[window.length - 1]!.close - window[0]!.open) /
    Math.max(Math.abs(window[0]!.open), 1e-9);
  const netThreshold = 0.00005;
  if (side === 'BUY') {
    scores.push(net >= netThreshold ? 1 : Math.abs(net) < netThreshold ? 0.5 : 0);
  } else {
    scores.push(net <= -netThreshold ? 1 : Math.abs(net) < netThreshold ? 0.5 : 0);
  }

  const range = last.high - last.low;
  if (range > 1e-9) {
    const closePos =
      side === 'BUY' ? (last.close - last.low) / range : (last.high - last.close) / range;
    scores.push(Math.max(0, Math.min(1, closePos)));
  }

  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return clamp01(avg);
}

/** Feed confirmation from multi-feed agreement and cross-market pressure. */
export function feedConfirm(
  side: ExitSide,
  feed: MultiFeedPrice | null | undefined,
  crossMarket?: CrossMarketPressure | null
): number | null {
  if (!feed && !crossMarket) return null;

  const parts: number[] = [];

  if (feed) {
    let feedScore = 0.25;
    if (feed.agreement === 'STRONG') feedScore += 0.45;
    else if (feed.agreement === 'OK') feedScore += 0.3;
    else if (feed.agreement === 'DIVERGENT') feedScore += 0.08;
    else if (feed.agreement === 'INSUFFICIENT') feedScore += 0.12;

    if (feed.sender_count > 0) {
      feedScore += 0.2 * Math.min(1, feed.contributing / feed.sender_count);
    }
    parts.push(clamp01(feedScore));
  }

  if (crossMarket) {
    const p = crossMarket.pressure;
    const aligned = side === 'BUY' ? p > 0.05 : p < -0.05;
    const opposed = side === 'BUY' ? p < -0.05 : p > 0.05;
    let cmScore = 0.45;
    if (aligned) cmScore = 0.55 + Math.min(0.45, Math.abs(p));
    else if (opposed || crossMarket.against) cmScore = 0.12;
    parts.push(clamp01(cmScore));
  }

  if (!parts.length) return null;
  return clamp01(parts.reduce((a, b) => a + b, 0) / parts.length);
}

/** Momentum confirmation from 10s bar structure. */
export function momentumConfirm(side: ExitSide, bars: TenSecBar[] | null | undefined): number | null {
  const w = (bars || []).filter((b) => b && Number.isFinite(b.close));
  if (w.length < 3) return null;
  const m = momentumBias(w);
  if (m === 'NEUTRAL') return 0.35;
  const aligned = (side === 'BUY' && m === 'BULLISH') || (side === 'SELL' && m === 'BEARISH');
  return aligned ? 0.85 : 0.15;
}

/** Regime confirmation — supports/opposes next signal direction. */
export function regimeConfirm(
  side: ExitSide,
  regime?: string | null,
  bias?: string | null
): number | null {
  const r = String(regime || '').toUpperCase();
  const b = String(bias || 'FLAT').toUpperCase();

  if (regimeSupportsSide(side, r)) return 0.85;
  if (regimeOpposesSide(side, r)) return 0.15;

  if (!r || r === 'UNKNOWN' || r === 'RANGE') {
    if (b === 'UP' && side === 'BUY') return 0.75;
    if (b === 'DOWN' && side === 'SELL') return 0.75;
    if (b === 'UP' && side === 'SELL') return 0.25;
    if (b === 'DOWN' && side === 'BUY') return 0.25;
    return 0.5;
  }

  return 0.5;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Weighted average of available confirmation components; weights renormalized when some are missing. */
export function computeNextSignalConfirm(input: {
  side: ExitSide;
  closedBars?: TenSecBar[] | null;
  feed?: MultiFeedPrice | null;
  crossMarket?: CrossMarketPressure | null;
  regime?: string | null;
  bias?: string | null;
}): { confirm: number | null; components: ConfirmComponents } {
  const components: ConfirmComponents = {
    candle: candleConfirm(input.side, input.closedBars),
    feed: feedConfirm(input.side, input.feed, input.crossMarket),
    momentum: momentumConfirm(input.side, input.closedBars),
    regime: regimeConfirm(input.side, input.regime, input.bias),
  };

  const entries: Array<[keyof typeof NEXT_SIGNAL_CONFIRM_WEIGHTS, number]> = [];
  for (const key of Object.keys(NEXT_SIGNAL_CONFIRM_WEIGHTS) as Array<
    keyof typeof NEXT_SIGNAL_CONFIRM_WEIGHTS
  >) {
    const val = components[key];
    if (val != null && Number.isFinite(val)) {
      entries.push([key, val]);
    }
  }

  if (!entries.length) {
    return { confirm: null, components };
  }

  let weightSum = 0;
  let scoreSum = 0;
  for (const [key, val] of entries) {
    const w = NEXT_SIGNAL_CONFIRM_WEIGHTS[key];
    weightSum += w;
    scoreSum += w * val;
  }

  const confirm = weightSum > 0 ? clamp01(scoreSum / weightSum) : null;
  return { confirm, components };
}

/** Final Best Outcome score: BO = R + α × D × C */
export function computeBestOutcomeScore(input: {
  mfe: number;
  uplAtExit: number;
  previousSide: ExitSide;
  nextSide?: ExitSide | null;
  nextConfirm?: number | null;
  alpha?: number;
}): BestOutcomeQualityResult {
  const alpha = input.alpha ?? BEST_OUTCOME_ALPHA;
  const retention = computeRetention(input.mfe, input.uplAtExit);
  const next_signal_direction = computeNextSignalDirection(input.previousSide, input.nextSide ?? null);
  const c = input.nextConfirm ?? null;

  let best_outcome_score: number | null = null;
  if (retention != null && Number.isFinite(retention)) {
    if (next_signal_direction === 0 || c == null) {
      best_outcome_score = retention;
    } else {
      const delta = alpha * next_signal_direction * c;
      const bo = retention + delta;
      best_outcome_score = Number.isFinite(bo) ? bo : null;
    }
  }

  return {
    retention,
    next_signal_direction,
    next_signal_confirm: c,
    confirm_components: {
      candle: null,
      feed: null,
      momentum: null,
      regime: null,
    },
    best_outcome_score,
    mfe: input.mfe,
    upl_at_exit: input.uplAtExit,
    previous_side: input.previousSide,
    next_side: input.nextSide ?? null,
    alpha,
  };
}

/** Full evaluation: retention + direction + LIVE confirmation + BO score. */
export function evaluateBestOutcomeQuality(input: {
  mfe: number;
  uplAtExit: number;
  previousSide: ExitSide;
  nextSide: ExitSide;
  closedBars?: TenSecBar[] | null;
  feed?: MultiFeedPrice | null;
  crossMarket?: CrossMarketPressure | null;
  regime?: string | null;
  bias?: string | null;
  alpha?: number;
}): BestOutcomeQualityResult {
  const { confirm, components } = computeNextSignalConfirm({
    side: input.nextSide,
    closedBars: input.closedBars,
    feed: input.feed,
    crossMarket: input.crossMarket,
    regime: input.regime,
    bias: input.bias,
  });

  const base = computeBestOutcomeScore({
    mfe: input.mfe,
    uplAtExit: input.uplAtExit,
    previousSide: input.previousSide,
    nextSide: input.nextSide,
    nextConfirm: confirm,
    alpha: input.alpha,
  });

  return { ...base, confirm_components: components, next_signal_confirm: confirm };
}

/** LIVE quality while the position is still OPEN — current valid signal vs open side. */
export function evaluateLiveBestOutcomeQuality(input: {
  mfe: number;
  upl: number;
  openSide: ExitSide;
  currentSide?: ExitSide | null;
  closedBars?: TenSecBar[] | null;
  feed?: MultiFeedPrice | null;
  crossMarket?: CrossMarketPressure | null;
  regime?: string | null;
  bias?: string | null;
  alpha?: number;
}): BestOutcomeQualityResult {
  const currentSide = input.currentSide ?? null;
  if (!currentSide) {
    const base = computeBestOutcomeScore({
      mfe: input.mfe,
      uplAtExit: input.upl,
      previousSide: input.openSide,
      nextSide: null,
      nextConfirm: null,
      alpha: input.alpha,
    });
    return base;
  }
  return evaluateBestOutcomeQuality({
    mfe: input.mfe,
    uplAtExit: input.upl,
    previousSide: input.openSide,
    nextSide: currentSide,
    closedBars: input.closedBars,
    feed: input.feed,
    crossMarket: input.crossMarket,
    regime: input.regime,
    bias: input.bias,
    alpha: input.alpha,
  });
}
