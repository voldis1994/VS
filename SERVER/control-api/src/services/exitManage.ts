import { PROFIT_LOCK_RATIO, SAFETY_SL_REL } from './capitalCom.js';
import { trendBiasFromBars, type TrendBias } from './entryFromRegime.js';
import { bodyPct, type TenSecBar } from './tenSecondOhlc.js';

/** Live Capital exit manager — per-robot, best-outcome + thesis invalidation.

 * Strategy owns ENTRY. Exit owns management of an EXISTING position.
 * Exit must NOT re-run entry permission via live regime gates.
 */

export type ExitSide = 'BUY' | 'SELL';

/** Setup families where opposite live regime is expected / not automatic invalidation. */
export const COUNTERTREND_EXIT_SETUPS = new Set([
  'FADE',
  'REVERSAL',
  'FAILED_BREAKOUT',
  'RANGE_REJECTION',
]);

/** With-trend families — opposite live regime may invalidate the entry thesis. */
export const WITH_TREND_EXIT_SETUPS = new Set([
  'PULLBACK',
  'CONTINUATION',
  'BREAKOUT',
]);

export type ExitSnapshot = {
  open_side: ExitSide | null;
  entry_price: number | null;
  entry_at: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  /** Live regime (market context for manage) — not entry permission. */
  regime?: string | null;
  /** Immutable Strategy setup family at entry (persisted). */
  entry_setup?: string | null;
  /** Immutable regime observed at entry (persisted). */
  entry_regime?: string | null;
  /** Persisted Best Outcome state — survives robot cycles for this deal. */
  best_outcome_state?: BestOutcomeStateName | null;
  best_outcome_reason?: string | null;
  best_price_seen?: number | null;
  consecutive_adverse?: number;
};

export type BestOutcomeStateName =
  | 'TRACKING'
  | 'HOLD'
  | 'WEAKENING'
  | 'REVERSAL_CONFIRMING'
  | 'EXIT';

export type BestOutcomeMarketContext = {
  closedBars?: TenSecBar[];
  trend_bias?: TrendBias | string | null;
  regime?: string | null;
};

export type BestOutcomeTrack = {
  state: BestOutcomeStateName;
  reason: string;
  best_price_seen: number;
  max_profit_seen: number;
  consecutive_adverse: number;
};

export type BestOutcomeView = {
  entry_price: number;
  best_price_seen: number;
  current_price: number;
  current_profit: number;
  max_profit_seen: number;
  profit_giveback: number;
  best_outcome_state: BestOutcomeStateName;
  best_outcome_reason: string;
  peak_retention: number | null;
};

export type BestOutcomeEvaluation = BestOutcome & {
  track: BestOutcomeTrack;
  view: BestOutcomeView;
};

export function initBestOutcomeTrack(entryPrice: number): BestOutcomeTrack {
  return {
    state: 'TRACKING',
    reason: 'position open · tracking development',
    best_price_seen: entryPrice,
    max_profit_seen: 0,
    consecutive_adverse: 0,
  };
}

export function trackFromSnapshot(s: ExitSnapshot, mid: number): BestOutcomeTrack {
  const entry = s.entry_price ?? mid;
  return {
    state: s.best_outcome_state ?? 'TRACKING',
    reason: s.best_outcome_reason ?? '',
    best_price_seen: s.best_price_seen ?? s.entry_price ?? mid,
    max_profit_seen: s.mfe,
    consecutive_adverse: s.consecutive_adverse ?? 0,
  };
}

function barAgainstSide(side: ExitSide, bar: TenSecBar): boolean {
  const bp = bodyPct(bar);
  return side === 'BUY' ? bp <= -0.00003 : bp >= 0.00003;
}

function barWithSide(side: ExitSide, bar: TenSecBar): boolean {
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

function biasSupportsSide(side: ExitSide, bias?: TrendBias | string | null): boolean {
  const b = String(bias || 'FLAT').toUpperCase();
  if (b === 'FLAT') return false;
  return (side === 'BUY' && b === 'UP') || (side === 'SELL' && b === 'DOWN');
}

function biasOpposesSide(side: ExitSide, bias?: TrendBias | string | null): boolean {
  const b = String(bias || 'FLAT').toUpperCase();
  if (b === 'FLAT') return false;
  return (side === 'BUY' && b === 'DOWN') || (side === 'SELL' && b === 'UP');
}

function significantMfe(entry: number, mfe: number): boolean {
  const abs = Math.max(Math.abs(entry), 1e-9);
  const minPts = abs >= 1000 ? 0.5 : abs * 0.00025;
  return mfe + 1e-9 >= minPts;
}

function netFlowSupportsSide(side: ExitSide, bars: TenSecBar[]): boolean {
  const w = bars.filter((b) => b && Number.isFinite(b.close)).slice(-5);
  if (w.length < 2) return false;
  const net = (w[w.length - 1]!.close - w[0]!.open) / Math.max(Math.abs(w[0]!.open), 1e-9);
  return side === 'BUY' ? net >= 0.00005 : net <= -0.00005;
}

function updateBestPrice(side: ExitSide, entry: number, mid: number, prev: number): number {
  if (side === 'BUY') return Math.max(prev, mid);
  return Math.min(prev, mid);
}

function countConsecutiveAdverse(side: ExitSide, bars: TenSecBar[]): number {
  let n = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i]!;
    if (barAgainstSide(side, b)) n += 1;
    else break;
  }
  return n;
}

export function favorableMove(side: ExitSide, entry: number, mid: number): number {
  return side === 'BUY' ? mid - entry : entry - mid;
}

/**
 * Opposite live regime vs open side — ONLY for with-trend entry setups.
 * Counter-trend setups (FADE / REVERSAL / FAILED_BREAKOUT / RANGE_REJECTION)
 * must not be killed by re-applying opposite-regime as entry permission.
 * Missing entry_setup → no ThesisFailure (Best Outcome only trails SL to BE).
 */
export function thesisFailureReason(
  side: ExitSide,
  regime?: string | null,
  entrySetup?: string | null
): string | null {
  const setup = String(entrySetup || '')
    .trim()
    .toUpperCase();
  if (!setup || COUNTERTREND_EXIT_SETUPS.has(setup)) return null;
  if (!WITH_TREND_EXIT_SETUPS.has(setup)) return null;

  const r = String(regime || '')
    .trim()
    .toUpperCase();
  if (!r || r === 'UNKNOWN') return null;
  if (side === 'BUY') {
    if (
      r === 'TREND_DOWN' ||
      r === 'BREAKOUT_DOWN' ||
      r === 'PULLBACK_DOWNTREND' ||
      r === 'FAILED_BREAKOUT_UP'
    ) {
      return `ThesisFailure · BUY ${setup} vs ${r}`;
    }
  } else if (
    r === 'TREND_UP' ||
    r === 'BREAKOUT_UP' ||
    r === 'PULLBACK_UPTREND' ||
    r === 'FAILED_BREAKOUT_DOWN'
  ) {
    return `ThesisFailure · SELL ${setup} vs ${r}`;
  }
  return null;
}

/** Close when peak profit retention falls below this (locks PROFIT_LOCK_RATIO of MFE). */
export const PEAK_RETENTION_EXIT_THRESHOLD = PROFIT_LOCK_RATIO;

export type BestOutcomeAction = 'HOLD' | 'CLOSE';

/** HARD_SAFETY must close immediately. OPTIMIZATION is an EXIT CANDIDATE for the LIVE formula. */
export type BestOutcomeExitKind = 'NONE' | 'HARD_SAFETY' | 'OPTIMIZATION';

export type BestOutcome = {
  /** True when the broker position must be closed now. */
  exit: boolean;
  action: BestOutcomeAction;
  reason: string;
  exit_kind: BestOutcomeExitKind;
};

/**
 * Broker BE stop level rounding:
 * - BUY must not round ABOVE entry (would create immediate small loss).
 * - SELL must not round BELOW entry.
 *
 * We quantize by Gold-like increments, but then force the stop to be on the
 * "safe side" relative to the true entry.
 */
export function breakevenStopLevelForSide(side: ExitSide, entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  const scale = abs >= 1000 ? 10 : abs >= 100 ? 100 : abs >= 1 ? 10000 : 1e6;
  if (side === 'BUY') return Math.floor(entry * scale) / scale;
  return Math.ceil(entry * scale) / scale;
}

/** Min favorable move before Best Outcome may close after inputs ended (Gold ≈ 1.8 pts). */
export function breakevenTriggerMove(entry: number, minStopDistance?: number | null): number {
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  const minDist =
    minStopDistance != null && Number.isFinite(minStopDistance) && minStopDistance > 0
      ? minStopDistance
      : 0;
  const goldBeTriggerPoints = 1.8;
  return absEntry >= 1000
    ? Math.max(minDist, goldBeTriggerPoints)
    : Math.max(minDist, absEntry * SAFETY_SL_REL);
}

/** Back-compat: old signature rounds to the nearest (may be slightly unsafe for BUY/SELL). */
export function breakevenStopLevel(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  const scale = abs >= 1000 ? 10 : abs >= 100 ? 100 : abs >= 1 ? 10000 : 1e6;
  return Math.round(entry * scale) / scale;
}

/** @deprecated Best Outcome trails to BE, not half of remaining plus. */
export function trailStopLevel(side: ExitSide, entry: number, mid: number): number | null {
  void mid;
  if (!Number.isFinite(entry)) return null;
  return breakevenStopLevelForSide(side, entry);
}

export function evaluateBestOutcome(
  s: ExitSnapshot,
  mid: number,
  ctx: BestOutcomeMarketContext,
  trackIn: BestOutcomeTrack,
  opts?: { minStopDistance?: number | null; nowMs?: number }
): BestOutcomeEvaluation {
  void opts?.nowMs;
  const holdResult = (): BestOutcomeEvaluation => ({
    exit: false,
    action: 'HOLD',
    reason: trackIn.reason,
    exit_kind: 'NONE',
    track: trackIn,
    view: buildView(s, mid, trackIn),
  });

  if (!s.open_side || s.entry_price == null || !Number.isFinite(mid)) {
    return holdResult();
  }

  const side = s.open_side;
  const entry = s.entry_price;
  const fav = favorableMove(side, entry, mid);
  const bars = (ctx.closedBars || []).filter((b) => b && Number.isFinite(b.close));
  const lastBar = bars.length ? bars[bars.length - 1]! : null;

  let track: BestOutcomeTrack = { ...trackIn };
  track.best_price_seen = updateBestPrice(side, entry, mid, track.best_price_seen);
  track.max_profit_seen = Math.max(track.max_profit_seen, s.mfe, fav);
  track.consecutive_adverse = countConsecutiveAdverse(side, bars);

  const peakMfe = Math.max(s.mfe, track.max_profit_seen);
  const retention = peakMfe > 0 ? Math.max(0, fav / peakMfe) : null;
  const giveback = peakMfe > 0 ? Math.max(0, peakMfe - fav) : 0;
  const mfeSignificant = significantMfe(entry, peakMfe);
  const minDist =
    opts?.minStopDistance != null && Number.isFinite(opts.minStopDistance) && opts.minStopDistance > 0
      ? opts.minStopDistance
      : 0;
  const closeMove = breakevenTriggerMove(entry, minDist > 0 ? minDist : null);

  // ——— Active Best Outcome exits (CLOSE, not SL trail) ———

  // Never go negative after a meaningful favorable excursion.
  if (mfeSignificant && peakMfe > 0 && fav <= 0) {
    track.state = 'EXIT';
    track.reason = `BestOutcome EXIT · breakeven guard · MFE ${peakMfe.toFixed(5)} → UPL ${fav.toFixed(5)}`;
    return {
      exit: true,
      action: 'CLOSE',
      reason: track.reason,
      exit_kind: 'OPTIMIZATION',
      track,
      view: buildView(s, mid, track),
    };
  }

  // 75% MFE profit lock — close when giveback exceeds allowed retention (after real MFE).
  if (
    mfeSignificant &&
    peakMfe + 1e-9 >= closeMove &&
    retention != null &&
    retention + 1e-9 < PEAK_RETENTION_EXIT_THRESHOLD
  ) {
    track.state = 'EXIT';
    track.reason = `BestOutcome EXIT · profit lock ${(PEAK_RETENTION_EXIT_THRESHOLD * 100).toFixed(0)}% · retention ${(retention * 100).toFixed(0)}% · giveback ${giveback.toFixed(5)}`;
    return {
      exit: true,
      action: 'CLOSE',
      reason: track.reason,
      exit_kind: 'OPTIMIZATION',
      track,
      view: buildView(s, mid, track),
    };
  }

  const thesisFail = thesisFailureReason(side, ctx.regime ?? s.regime, s.entry_setup);
  if (thesisFail && fav <= 0) {
    track.state = 'EXIT';
    track.reason = `${thesisFail} · no favorable move`;
    return {
      exit: true,
      action: 'CLOSE',
      reason: track.reason,
      exit_kind: 'HARD_SAFETY',
      track,
      view: buildView(s, mid, track),
    };
  }

  const entryRegime = s.entry_regime != null ? String(s.entry_regime).toUpperCase() : null;
  const curRegime = String(ctx.regime ?? s.regime ?? '').toUpperCase() || null;
  const impulseEndedKnown =
    entryRegime != null && curRegime != null && entryRegime !== curRegime && curRegime !== 'UNKNOWN';
  const shortBias = bars.length >= 3 ? trendBiasFromBars(bars) : 'FLAT';
  const trendBias = (ctx.trend_bias ?? shortBias) as TrendBias;
  const entrySetup = String(s.entry_setup || '')
    .trim()
    .toUpperCase();
  const withTrendEntry = WITH_TREND_EXIT_SETUPS.has(entrySetup);

  if (impulseEndedKnown && withTrendEntry && fav + 1e-9 >= closeMove) {
    track.state = 'EXIT';
    track.reason = `BestOutcome · inputs ended · favorable move (${fav.toFixed(5)} >= ${closeMove})`;
    return {
      exit: true,
      action: 'CLOSE',
      reason: track.reason,
      exit_kind: 'OPTIMIZATION',
      track,
      view: buildView(s, mid, track),
    };
  }

  let exitScore = 0;
  let holdScore = 0;
  const exitNotes: string[] = [];
  const holdNotes: string[] = [];

  if (biasOpposesSide(side, trendBias)) {
    exitScore += 2;
    exitNotes.push(`bias ${trendBias} vs ${side}`);
  }
  if (regimeOpposesSide(side, curRegime)) {
    exitScore += 2;
    exitNotes.push(`regime ${curRegime}`);
  }
  if (track.consecutive_adverse >= 2) {
    exitScore += 2;
    exitNotes.push(`${track.consecutive_adverse} adverse 10s`);
  } else if (track.consecutive_adverse === 1) {
    holdScore += 1;
    holdNotes.push('single adverse 10s · pullback');
  }
  if (impulseEndedKnown) {
    holdNotes.push('inputs ended · waiting for confirmation');
  }
  if (mfeSignificant && retention != null && retention < 0.45 && fav > 0) {
    exitScore += 2;
    exitNotes.push(`retention ${(retention * 100).toFixed(0)}%`);
  }
  if (mfeSignificant && giveback > 0 && fav > 0 && bars.length >= 2 && !netFlowSupportsSide(side, bars)) {
    exitScore += 1;
    exitNotes.push('10s flow against');
  }

  if (biasSupportsSide(side, trendBias)) {
    holdScore += 2;
    holdNotes.push(`bias ${trendBias}`);
  }
  if (regimeSupportsSide(side, curRegime)) {
    holdScore += 1;
    holdNotes.push(`regime ${curRegime}`);
  }
  if (lastBar && barWithSide(side, lastBar)) {
    holdScore += 1;
    holdNotes.push('last 10s with side');
  }
  if (fav + 1e-9 >= s.mfe && s.mfe > 0) {
    holdScore += 2;
    holdNotes.push('new best price');
  }
  if (retention != null && retention >= 0.72) {
    holdScore += 1;
    holdNotes.push(`retention ${(retention * 100).toFixed(0)}%`);
  }
  if (netFlowSupportsSide(side, bars)) {
    holdScore += 1;
    holdNotes.push('10s flow with side');
  }
  if (impulseEndedKnown && lastBar && barWithSide(side, lastBar) && netFlowSupportsSide(side, bars)) {
    holdScore += 2;
    holdNotes.push('trend resumes after pullback');
  }

  let state: BestOutcomeStateName = 'TRACKING';
  let reason = '';

  if (!mfeSignificant) {
    state = 'TRACKING';
    reason = holdNotes.length
      ? `tracking · ${holdNotes.slice(0, 2).join(' · ')}`
      : 'tracking · waiting for meaningful move';
  } else if (
    exitScore >= 4 ||
    (exitScore >= 3 && holdScore <= 1 && track.consecutive_adverse >= 2) ||
    (mfeSignificant &&
      exitScore >= 2 &&
      track.consecutive_adverse >= 2 &&
      retention != null &&
      retention < 0.6) ||
    (mfeSignificant && exitScore >= 3 && retention != null && retention < 0.7)
  ) {
    state = 'EXIT';
    reason = `BestOutcome EXIT · ${exitNotes.join(' · ')}`;
    return {
      exit: true,
      action: 'CLOSE',
      reason,
      exit_kind: 'OPTIMIZATION',
      track: { ...track, state, reason },
      view: buildView(s, mid, { ...track, state, reason }),
    };
  } else if (exitScore >= 2 && exitScore > holdScore) {
    state = 'REVERSAL_CONFIRMING';
    reason = `reversal confirming · ${exitNotes.join(' · ')}`;
  } else if (exitScore >= 1) {
    state = 'WEAKENING';
    reason = `weakening · ${exitNotes.join(' · ') || 'momentum fade'}`;
  } else {
    state = 'HOLD';
    reason = holdNotes.length
      ? `hold · ${holdNotes.slice(0, 3).join(' · ')}`
      : 'hold · move still supported';
  }

  track = { ...track, state, reason };
  return {
    exit: false,
    action: 'HOLD',
    reason: track.reason,
    exit_kind: 'NONE',
    track,
    view: buildView(s, mid, track),
  };
}

function buildView(s: ExitSnapshot, mid: number, track: BestOutcomeTrack): BestOutcomeView {
  const entry = s.entry_price ?? mid;
  const currentProfit = s.open_side ? favorableMove(s.open_side, entry, mid) : 0;
  const maxProfit = Math.max(track.max_profit_seen, s.mfe);
  const giveback = maxProfit > 0 ? Math.max(0, maxProfit - currentProfit) : 0;
  return {
    entry_price: entry,
    best_price_seen: track.best_price_seen,
    current_price: mid,
    current_profit: currentProfit,
    max_profit_seen: maxProfit,
    profit_giveback: giveback,
    best_outcome_state: track.state,
    best_outcome_reason: track.reason,
    peak_retention: maxProfit > 0 ? Math.max(0, currentProfit / maxProfit) : s.peak_retention,
  };
}

export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number,
  nowMs: number = Date.now(),
  opts?: {
    minStopDistance?: number | null;
    market?: BestOutcomeMarketContext;
    track?: BestOutcomeTrack;
  }
): BestOutcome {
  const track = opts?.track ?? trackFromSnapshot(s, mid);
  const ctx = opts?.market ?? { regime: s.regime, closedBars: [], trend_bias: 'FLAT' };
  const evalResult = evaluateBestOutcome(s, mid, ctx, track, {
    minStopDistance: opts?.minStopDistance ?? null,
    nowMs,
  });
  return {
    exit: evalResult.exit,
    action: evalResult.action,
    reason: evalResult.reason,
    exit_kind: evalResult.exit_kind,
  };
}

/** Full evaluation including persisted track — used by robotDesk manage loop. */
export function decideBestOutcomeExitFull(
  s: ExitSnapshot,
  mid: number,
  ctx: BestOutcomeMarketContext,
  track: BestOutcomeTrack,
  opts?: { minStopDistance?: number | null; nowMs?: number }
): BestOutcomeEvaluation {
  return evaluateBestOutcome(s, mid, ctx, track, opts);
}
