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

/** Broker BE stop = entry (Gold rounded to 1 decimal). */
export function breakevenStopLevel(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  if (abs >= 1000) return Math.round(entry * 10) / 10;
  if (abs >= 100) return Math.round(entry * 100) / 100;
  if (abs >= 1) return Math.round(entry * 10000) / 10000;
  return Math.round(entry * 1e6) / 1e6;
}

/** @deprecated Best Outcome trails to BE, not half of remaining plus. */
export function trailStopLevel(side: ExitSide, entry: number, mid: number): number | null {
  void mid;
  if (!Number.isFinite(entry)) return null;
  void side;
  return breakevenStopLevel(entry);
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

  // Best Outcome = only SL → BE. No TP/harvest/time/thesis close.
  if (fav > 0 && fav >= minDist) {
    const stop = breakevenStopLevel(entry);
    return trail(
      `BestOutcome BE · SL ${stop} · UPL ${fav.toFixed(5)} · entry ${entry}`,
      stop
    );
  }

  return hold();
}
