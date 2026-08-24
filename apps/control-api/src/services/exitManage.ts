/** Live Capital exit manager — #136 original Best Outcome + thesis failure. */

export type ExitSide = 'BUY' | 'SELL';

export type ExitSnapshot = {
  open_side: ExitSide | null;
  entry_price: number | null;
  entry_at: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  regime?: string | null;
};

export function favorableMove(side: ExitSide, entry: number, mid: number): number {
  return side === 'BUY' ? mid - entry : entry - mid;
}

/** Opposite regime vs open side — original PositionManager thesis failure. */
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

/** #136 HardInv ≈0.22% (min 0.22). */
export function hardInvalidationDistance(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.0022, 0.22);
}

/** #136 Peak/harvest arm ≈0.0708% (min 0.12) — ~3.2pt on Gold ~4500. */
export function bestOutcomeMfeFloor(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.000708, 0.12);
}

/** #136 soft TP ≈0.35%. */
export function bestOutcomeTarget(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.0035, 0.35);
}

/**
 * Manage exit — #136 original.
 * Broker SAFETY SL is the hard cushion; this is best-outcome + thesis management.
 * Isolated: caller must pass ONE robot's snapshot (never mix clients).
 */
export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number
): { exit: boolean; reason: string } {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const thesis = thesisFailureReason(s.open_side, s.regime);
  if (thesis) return { exit: true, reason: thesis };

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const tp = bestOutcomeTarget(entry);
  const sl = hardInvalidationDistance(entry);
  const mfeFloor = bestOutcomeMfeFloor(entry);

  if (fav <= -sl) {
    return { exit: true, reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}` };
  }

  if (s.mfe >= mfeFloor && s.peak_retention != null && s.peak_retention < 0.3) {
    return {
      exit: true,
      reason: `PeakProtection · retention ${(s.peak_retention * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} → lock best`,
    };
  }

  if (fav >= tp) {
    return {
      exit: true,
      reason: `Target / best outcome · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`,
    };
  }

  if (s.mfe >= mfeFloor && fav > 0 && s.peak_retention != null && s.peak_retention < 0.4) {
    return {
      exit: true,
      reason: `BestOutcome harvest · UPL ${fav.toFixed(5)} after MFE ${s.mfe.toFixed(5)} (ret ${(s.peak_retention * 100).toFixed(0)}%)`,
    };
  }

  const heldMs = s.entry_at ? Date.now() - new Date(s.entry_at).getTime() : 0;
  if (heldMs > 480_000 && fav >= 0 && s.mfe >= mfeFloor * 0.5) {
    return {
      exit: true,
      reason: `TimeDecay · held ${Math.round(heldMs / 1000)}s · realize non-negative best UPL ${fav.toFixed(5)}`,
    };
  }

  return { exit: false, reason: '' };
}

/** Operator-facing hold line when Best Outcome did not fire an exit. */
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

  return {
    exit: false,
    reason: '',
    hold: `BO #136 · UPL ${fav.toFixed(2)} · HardInv @ -${sl.toFixed(2)} · MFE ${s.mfe.toFixed(2)}/${mfeFloor.toFixed(2)} · ret ${ret}`,
  };
}
