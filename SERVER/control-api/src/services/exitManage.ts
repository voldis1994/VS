import { SAFETY_SL_REL } from './capitalCom.js';

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
};

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

/**
 * Manage exit — lock the best available outcome by moving SL to breakeven.
 * Never close from Best Outcome. Broker SAFETY SL (0.15%) is the loss stop.
 *
 * @param nowMs Evaluation clock — must be wall time at T (injectable for tests; no look-ahead).
 */
export type BestOutcomeAction = 'HOLD' | 'CLOSE' | 'TRAIL';

export type BestOutcome = {
  /** True only when the broker position must be closed now. Best Outcome never closes. */
  exit: boolean;
  action: BestOutcomeAction;
  reason: string;
  /** Absolute stopLevel to PUT on Capital when action=TRAIL */
  trail_stop: number | null;
};

function hold(): BestOutcome {
  return { exit: false, action: 'HOLD', reason: '', trail_stop: null };
}

function trail(reason: string, stop: number): BestOutcome {
  return { exit: false, action: 'TRAIL', reason, trail_stop: stop };
}

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

/** UPL move required before SL may trail to breakeven (Gold ≈ 1.8 pts). */
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

export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number,
  nowMs: number = Date.now(),
  opts?: { minStopDistance?: number | null }
): BestOutcome {
  void nowMs;
  if (!s.open_side || s.entry_price == null) return hold();
  if (!Number.isFinite(mid)) return hold();

  /**
   * “Inputs ended” gate:
   * Let the trade run while the live regime/context matches the entry context.
   * Only then allow Best Outcome to tighten SL to breakeven.
   */
  const entryRegime = s.entry_regime != null ? String(s.entry_regime).toUpperCase() : null;
  const curRegime = s.regime != null ? String(s.regime).toUpperCase() : null;
  const inputsEnded =
    entryRegime && curRegime ? entryRegime !== curRegime : true;
  // Close after BE only when we actually *know* inputs ended via a real entry_regime vs live regime mismatch.
  const impulseEndedKnown = entryRegime != null && curRegime != null && entryRegime !== curRegime;

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const thesisFail = thesisFailureReason(s.open_side, s.regime, s.entry_setup);
  if (thesisFail && fav <= 0) {
    return { exit: true, action: 'CLOSE', reason: `${thesisFail} · no favorable move`, trail_stop: null };
  }
  const minDist =
    opts?.minStopDistance != null && Number.isFinite(opts.minStopDistance) && opts.minStopDistance > 0
      ? opts.minStopDistance
      : 0;
  const absEntry = Math.max(Math.abs(entry), 1e-9);

  const beMove = breakevenTriggerMove(entry, minDist > 0 ? minDist : null);

  // “Impulse ended” behavior:
  // When inputsEnded by this heuristic, we should not keep holding at BE.
  // For with-trend entry setups, after BE is reached we close.
  const entrySetup = String(s.entry_setup || '')
    .trim()
    .toUpperCase();
  const withTrendEntry = WITH_TREND_EXIT_SETUPS.has(entrySetup);
  if (impulseEndedKnown && withTrendEntry && Number.isFinite(fav) && fav + 1e-9 >= beMove) {
    return {
      exit: true,
      action: 'CLOSE',
      reason: `BestOutcome · inputs ended · BE reached (${fav.toFixed(5)} >= ${beMove})`,
      trail_stop: null,
    };
  }

  // If “inputs ended” hasn't happened (regime unchanged), still allow BE only
  // when the move is already clearly beyond normal noise.
  // This prevents a situation where BE never triggers.
  if (!inputsEnded) {
    // For Gold we explicitly want the operator “good feel” trigger (~1.8 UPL points)
    // even when the live regime has not yet “ended” by this heuristic.
    if (absEntry < 1000) {
      const lateBeMove = beMove * 2; // allow BE after a clearly larger move
      if (!(Number.isFinite(fav) && fav + 1e-9 >= lateBeMove)) return hold();
    }
  }

  // Best Outcome = only SL → BE. No TP/harvest/time/thesis close.
  if (Number.isFinite(fav) && fav + 1e-9 >= beMove) {
    const stop = breakevenStopLevelForSide(s.open_side, entry);
    return trail(
      `BestOutcome BE · SL ${stop} · UPL ${fav.toFixed(5)} · entry ${entry}`,
      stop
    );
  }

  return hold();
}
