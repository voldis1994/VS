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
 * Missing entry_setup → no ThesisFailure (HardInvalidation / trail still apply).
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
 * Manage exit — lock the best available outcome.
 * Never give a printed plus back to minus. Broker SAFETY SL is last resort.
 *
 * @param nowMs Evaluation clock — must be wall time at T (injectable for tests; no look-ahead).
 */
export type BestOutcomeAction = 'HOLD' | 'CLOSE' | 'TRAIL';

export type BestOutcome = {
  /** True only when the broker position must be closed now. */
  exit: boolean;
  action: BestOutcomeAction;
  reason: string;
  /** Absolute stopLevel to PUT on Capital when action=TRAIL */
  trail_stop: number | null;
};

function hold(): BestOutcome {
  return { exit: false, action: 'HOLD', reason: '', trail_stop: null };
}

function close(reason: string): BestOutcome {
  return { exit: true, action: 'CLOSE', reason, trail_stop: null };
}

function trail(reason: string, stop: number): BestOutcome {
  return { exit: false, action: 'TRAIL', reason, trail_stop: stop };
}

/** Lock half of *current* favorable move (not original MFE — that would be through the market). */
export function trailStopLevel(side: ExitSide, entry: number, mid: number): number | null {
  const fav = favorableMove(side, entry, mid);
  if (!(fav > 0) || !Number.isFinite(entry) || !Number.isFinite(mid)) return null;
  const lock = fav * 0.5;
  return side === 'BUY' ? entry + lock : entry - lock;
}

export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number,
  nowMs: number = Date.now()
): BestOutcome {
  if (!s.open_side || s.entry_price == null) return hold();
  if (!Number.isFinite(mid)) return hold();

  const thesis = thesisFailureReason(s.open_side, s.regime, s.entry_setup);
  if (thesis) return close(thesis);

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  const tp = Math.max(absEntry * 0.0022, 0.22);
  const sl = Math.max(absEntry * 0.0015, 0.15);
  /** Any plus that counts as "had a winner" — Gold ~2pts, FX ~0.08 */
  const lockFloor = Math.max(absEntry * 0.00045, 0.08);
  const retention = s.peak_retention;

  // 1) Had plus → never ride it into minus
  if (s.mfe >= lockFloor && fav <= 0) {
    return close(
      `GaveBackPlus · MFE ${s.mfe.toFixed(5)} now UPL ${fav.toFixed(5)} → lock, do not wait for minus`
    );
  }

  // 2) Trail: move Capital SL to lock half of remaining plus (do not close)
  if (s.mfe >= lockFloor && retention != null && retention < 0.5 && fav > 0) {
    const stop = trailStopLevel(s.open_side, entry, mid);
    if (stop != null && Number.isFinite(stop)) {
      return trail(
        `PeakProtection · retention ${(retention * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} → trail SL ${stop.toFixed(5)}`,
        stop
      );
    }
  }

  // 3) Still green but fading — harvest remaining plus
  if (s.mfe >= lockFloor && fav > 0 && retention != null && retention < 0.62) {
    return close(
      `BestOutcome harvest · UPL ${fav.toFixed(5)} after MFE ${s.mfe.toFixed(5)} (ret ${(retention * 100).toFixed(0)}%)`
    );
  }

  // 4) Take the plus when target is hit (do not wait for a bigger dream)
  if (fav >= tp) {
    return close(`Target / best outcome · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`);
  }

  // 5) Last-resort hard invalidation (no plus was ever locked)
  if (fav <= -sl) {
    return close(`HardInvalidation · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}`);
  }

  const entryMs = s.entry_at ? new Date(s.entry_at).getTime() : NaN;
  const heldMs = Number.isFinite(entryMs) ? Math.max(0, nowMs - entryMs) : 0;
  if (heldMs > 90_000 && fav > 0 && s.mfe >= lockFloor * 0.6) {
    return close(`TimeDecay · held ${Math.round(heldMs / 1000)}s · take plus ${fav.toFixed(5)}`);
  }
  if (heldMs > 180_000 && fav >= 0) {
    return close(`TimeDecay · held ${Math.round(heldMs / 1000)}s · flatten non-negative ${fav.toFixed(5)}`);
  }

  return hold();
}
