/** Live Capital exit manager — lock majority of MFE; never give back into HardInv red. */

export type ExitSide = 'BUY' | 'SELL';

export type ExitSnapshot = {
  open_side: ExitSide | null;
  entry_price: number | null;
  entry_at: string | null;
  /** Max favorable move in PRICE POINTS (not account $). */
  mfe: number;
  mae: number;
  /** Current fav / mfe in price points (1 = at peak). */
  peak_retention: number | null;
  regime?: string | null;
};

export function favorableMove(side: ExitSide, entry: number, mid: number): number {
  return side === 'BUY' ? mid - entry : entry - mid;
}

/** Opposite regime vs open side. */
export function thesisFailureReason(
  side: ExitSide,
  regime?: string | null
): string | null {
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
      return `ThesisFailure · BUY vs ${r}`;
    }
  } else if (
    r === 'TREND_UP' ||
    r === 'BREAKOUT_UP' ||
    r === 'PULLBACK_UPTREND' ||
    r === 'FAILED_BREAKOUT_DOWN'
  ) {
    return `ThesisFailure · SELL vs ${r}`;
  }
  return null;
}

/** Robot HardInv ≈0.16% — before broker disaster SL (~0.25%, micro-friendly). */
export function hardInvalidationDistance(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.0016, 0.16);
}

/** Arm protection from ≈1.0pt on Gold ~4600. */
export function bestOutcomeMfeFloor(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.00022, 0.8);
}

/** Soft TP ≈0.22% — take winners earlier. */
export function bestOutcomeTarget(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.0022, 0.22);
}

/** Min green for thesis/TP on young trades (no MFE yet). */
export function bestOutcomeMinGreen(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.00004, 0.1);
}

/**
 * Lock majority of peak: exit when retention drops below this (keep ~65%+ of MFE).
 * Was 0.35 → waited until 65% giveback → often flat/red before exit.
 */
export const BEST_OUTCOME_LOCK_RETENTION = 0.65;

/**
 * Manage exit — Best Outcome locks the majority; never ride giveback into HardInv.
 * MFE / retention MUST be price points (same unit as favorableMove).
 */
export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number
): { exit: boolean; reason: string } {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const tp = bestOutcomeTarget(entry);
  const sl = hardInvalidationDistance(entry);
  const mfeFloor = bestOutcomeMfeFloor(entry);
  const minGreen = bestOutcomeMinGreen(entry);
  const armed = s.mfe >= mfeFloor;
  const ret = s.peak_retention;

  if (fav <= -sl) {
    return { exit: true, reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}` };
  }

  // After a real peak — never give everything back into flat/HardInv red
  if (armed) {
    if (fav <= 0) {
      return {
        exit: true,
        reason: `BestOutcome cut · gave back MFE ${s.mfe.toFixed(5)} → UPL ${fav.toFixed(5)} (lock before minus)`,
      };
    }
    // Lock majority of peak while still green
    if (ret != null && ret < BEST_OUTCOME_LOCK_RETENTION) {
      return {
        exit: true,
        reason: `PeakProtection · keep ${(ret * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} · UPL ${fav.toFixed(5)}`,
      };
    }
  }

  // Young trade / no peak yet — ignore micro noise
  if (fav < minGreen) {
    return { exit: false, reason: '' };
  }

  const thesis = thesisFailureReason(s.open_side, s.regime);
  if (thesis) {
    return { exit: true, reason: `${thesis} · lock green ${fav.toFixed(5)}` };
  }

  if (fav >= tp) {
    return {
      exit: true,
      reason: `Target / best outcome · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`,
    };
  }

  // Light harvest: still green, gave back ~25%+ of peak
  if (armed && ret != null && ret < 0.75) {
    return {
      exit: true,
      reason: `BestOutcome harvest · UPL ${fav.toFixed(5)} after MFE ${s.mfe.toFixed(5)} (ret ${(ret * 100).toFixed(0)}%)`,
    };
  }

  const heldMs = s.entry_at ? Date.now() - new Date(s.entry_at).getTime() : 0;
  if (heldMs > 240_000 && fav > 0 && s.mfe >= mfeFloor * 0.5) {
    return {
      exit: true,
      reason: `TimeDecay · held ${Math.round(heldMs / 1000)}s · realize green UPL ${fav.toFixed(5)}`,
    };
  }

  return { exit: false, reason: '' };
}

/** Operator-facing hold line when Best Outcome did not fire. */
export function describeBestOutcomeState(
  s: ExitSnapshot,
  mid: number
): { exit: boolean; reason: string; hold: string } {
  const decision = decideBestOutcomeExit(s, mid);
  if (decision.exit) return { ...decision, hold: '' };

  if (!s.open_side || s.entry_price == null) {
    return {
      exit: false,
      reason: '',
      hold: 'BO blocked — missing entry_price (manage robot not seeded?)',
    };
  }

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const sl = hardInvalidationDistance(entry);
  const mfeFloor = bestOutcomeMfeFloor(entry);
  const ret =
    s.peak_retention != null ? `${(s.peak_retention * 100).toFixed(0)}%` : '—';
  const lock = `${(BEST_OUTCOME_LOCK_RETENTION * 100).toFixed(0)}%`;

  return {
    exit: false,
    reason: '',
    hold: `BO · UPL ${fav.toFixed(2)} · lock@${lock} · HardInv -${sl.toFixed(2)} · MFE ${s.mfe.toFixed(2)}/${mfeFloor.toFixed(2)} · ret ${ret}`,
  };
}
