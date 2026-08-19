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
 * Never close from Best Outcome. Broker SAFETY SL (0.25%) is the loss stop.
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

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const minDist =
    opts?.minStopDistance != null && Number.isFinite(opts.minStopDistance) && opts.minStopDistance > 0
      ? opts.minStopDistance
      : 0;
  // Gold 10s noise is ~0.3–2pt. Broker min-stop (~0.4) is too tight for BE —
  // wait until plus is at least the 0.25% safety distance (~11pt on Gold).
  const beMove = Math.max(minDist, Math.abs(entry) * SAFETY_SL_REL);

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
