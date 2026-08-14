/** Live Capital exit manager — per-robot, best-outcome + thesis failure from regime. */

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

/**
 * Manage exit — lock the best available outcome.
 * Never give a printed plus back to minus. Broker SAFETY SL is last resort.
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
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  const tp = Math.max(absEntry * 0.0022, 0.22);
  const sl = Math.max(absEntry * 0.0015, 0.15);
  /** Any plus that counts as "had a winner" — Gold ~2pts, FX ~0.08 */
  const lockFloor = Math.max(absEntry * 0.00045, 0.08);
  const retention = s.peak_retention;

  // 1) Had plus → never ride it into minus
  if (s.mfe >= lockFloor && fav <= 0) {
    return {
      exit: true,
      reason: `GaveBackPlus · MFE ${s.mfe.toFixed(5)} now UPL ${fav.toFixed(5)} → lock, do not wait for minus`,
    };
  }

  // 2) Trail: keep ~half of best once a real plus existed
  if (s.mfe >= lockFloor && retention != null && retention < 0.5) {
    return {
      exit: true,
      reason: `PeakProtection · retention ${(retention * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} → lock best`,
    };
  }

  // 3) Still green but fading — harvest remaining plus
  if (s.mfe >= lockFloor && fav > 0 && retention != null && retention < 0.62) {
    return {
      exit: true,
      reason: `BestOutcome harvest · UPL ${fav.toFixed(5)} after MFE ${s.mfe.toFixed(5)} (ret ${(retention * 100).toFixed(0)}%)`,
    };
  }

  // 4) Take the plus when target is hit (do not wait for a bigger dream)
  if (fav >= tp) {
    return {
      exit: true,
      reason: `Target / best outcome · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`,
    };
  }

  // 5) Last-resort hard invalidation (no plus was ever locked)
  if (fav <= -sl) {
    return { exit: true, reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}` };
  }

  const heldMs = s.entry_at ? Date.now() - new Date(s.entry_at).getTime() : 0;
  if (heldMs > 90_000 && fav > 0 && s.mfe >= lockFloor * 0.6) {
    return {
      exit: true,
      reason: `TimeDecay · held ${Math.round(heldMs / 1000)}s · take plus ${fav.toFixed(5)}`,
    };
  }
  if (heldMs > 180_000 && fav >= 0) {
    return {
      exit: true,
      reason: `TimeDecay · held ${Math.round(heldMs / 1000)}s · flatten non-negative ${fav.toFixed(5)}`,
    };
  }

  return { exit: false, reason: '' };
}
