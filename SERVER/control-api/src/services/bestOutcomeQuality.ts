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

/** LIVE confirmation at or above this is "strong". */
export const LIVE_CONFIRM_STRONG = 0.6;

/**
 * Min BO score for OPTIMIZATION CLOSE when opposite is confirmed.
 * BO = R + α×D×C — opposite strong often pushes BO above retention.
 */
export const LIVE_BO_CLOSE_MIN = 0.55;

/** Base confirmation weights (renormalized among available). Feed boosted when others missing. */
export const NEXT_SIGNAL_CONFIRM_WEIGHTS = {
  candle: 0.25,
  feed: 0.3,
  momentum: 0.2,
  regime: 0.25,
} as const;

/** Extra feed weight multiplier when candle/momentum/regime are sparse. */
export const FEED_FALLBACK_BOOST = 2.0;

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

/** Weighted average; missing components dropped; Feed weight boosted when others are scarce. */
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

  const available = (
    Object.keys(NEXT_SIGNAL_CONFIRM_WEIGHTS) as Array<keyof typeof NEXT_SIGNAL_CONFIRM_WEIGHTS>
  ).filter((key) => {
    const val = components[key];
    return val != null && Number.isFinite(val);
  });

  if (!available.length) {
    return { confirm: null, components };
  }

  const nonFeed = available.filter((k) => k !== 'feed');
  const boostFeed = nonFeed.length <= 1 && available.includes('feed');

  let weightSum = 0;
  let scoreSum = 0;
  for (const key of available) {
    let w = NEXT_SIGNAL_CONFIRM_WEIGHTS[key];
    if (boostFeed && key === 'feed') w *= FEED_FALLBACK_BOOST;
    weightSum += w;
    scoreSum += w * (components[key] as number);
  }

  const confirm = weightSum > 0 ? clamp01(scoreSum / weightSum) : null;
  return { confirm, components };
}

/**
 * When Strategy signal is missing, infer LIVE direction from regime / bias /
 * cross-market / bars / feed mid drift so BO still gets a real D and C.
 */
export function inferMarketDirectionFromFeed(input: {
  feed?: MultiFeedPrice | null;
  crossMarket?: CrossMarketPressure | null;
  regime?: string | null;
  bias?: string | null;
  closedBars?: TenSecBar[] | null;
}): ExitSide | null {
  const r = String(input.regime || '').toUpperCase();
  const b = String(input.bias || 'FLAT').toUpperCase();

  if (r.includes('TREND_UP') || r.includes('BREAKOUT_UP') || r.includes('PULLBACK_UP')) return 'BUY';
  if (r.includes('TREND_DOWN') || r.includes('BREAKOUT_DOWN') || r.includes('PULLBACK_DOWN')) {
    return 'SELL';
  }
  if (b === 'UP') return 'BUY';
  if (b === 'DOWN') return 'SELL';

  const p = input.crossMarket?.pressure;
  if (p != null && Number.isFinite(p)) {
    if (p > 0.08) return 'BUY';
    if (p < -0.08) return 'SELL';
  }

  const bars = (input.closedBars || []).filter((x) => x && Number.isFinite(x.close));
  if (bars.length >= 3) {
    const m = momentumBias(bars);
    if (m === 'BULLISH') return 'BUY';
    if (m === 'BEARISH') return 'SELL';
  }

  // Feed mid vs recent bar close — last-resort direction when agreement is usable.
  const feed = input.feed;
  const mid = feed?.mid;
  if (
    mid != null &&
    Number.isFinite(mid) &&
    bars.length >= 1 &&
    (feed!.agreement === 'STRONG' || feed!.agreement === 'OK' || feed!.agreement === 'INSUFFICIENT')
  ) {
    const last = bars[bars.length - 1]!.close;
    const rel = (mid - last) / Math.max(Math.abs(last), 1e-9);
    if (rel > 0.00015) return 'BUY';
    if (rel < -0.00015) return 'SELL';
  }

  return null;
}

/** Min favorable UPL (price points) before weak-path OPTIMIZATION may CLOSE. */
export function minMeaningfulUpl(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return abs >= 1000 ? 0.5 : abs * 0.00025;
}

export function hasMeaningfulProfit(entry: number, upl: number): boolean {
  return Number.isFinite(upl) && upl + 1e-9 >= minMeaningfulUpl(entry);
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

/** LIVE quality while the position is still OPEN — current valid signal vs open side.
 * If Strategy signal missing, infer direction from Feed/regime/bias so formula still runs.
 */
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
  const currentSide =
    input.currentSide ??
    inferMarketDirectionFromFeed({
      feed: input.feed,
      crossMarket: input.crossMarket,
      regime: input.regime,
      bias: input.bias,
      closedBars: input.closedBars,
    });

  if (!currentSide) {
    // Still compute Feed-only confirm vs open side for logging; D stays 0.
    const feedOnly = computeNextSignalConfirm({
      side: input.openSide,
      closedBars: input.closedBars,
      feed: input.feed,
      crossMarket: input.crossMarket,
      regime: input.regime,
      bias: input.bias,
    });
    const base = computeBestOutcomeScore({
      mfe: input.mfe,
      uplAtExit: input.upl,
      previousSide: input.openSide,
      nextSide: null,
      nextConfirm: feedOnly.confirm,
      alpha: input.alpha,
    });
    return { ...base, confirm_components: feedOnly.components, next_signal_confirm: feedOnly.confirm };
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
