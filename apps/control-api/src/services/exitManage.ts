/** Live Capital exit manager — Best Outcome first; broker SAFETY SL is last-resort only. */

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

/** Opposite regime vs open side — classic #136 thesis failure. */
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

/** Robot HardInv ≈0.32% — closes BEFORE broker disaster SL (~0.50%). */
export function hardInvalidationDistance(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.0032, 0.32);
}

/** Arm peak/harvest from ≈1.4pt on Gold ~4600 (not 3.2pt — too late vs broker SL). */
export function bestOutcomeMfeFloor(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.0003, 0.08);
}

/** Soft TP ≈0.28% — take Best Outcome before Capital noise. */
export function bestOutcomeTarget(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.0028, 0.28);
}

/** Min green to soft-exit (~0.18pt Gold) — never lock flat/−0.01 after giveback. */
export function bestOutcomeMinGreen(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.00004, 0.1);
}

/**
 * Manage exit — Best Outcome first; broker SAFETY SL is last-resort only.
 * Soft exits (thesis / peak / harvest / time) ONLY when still green.
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

  if (fav <= -sl) {
    return { exit: true, reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}` };
  }

  if (fav < minGreen) {
    return { exit: false, reason: '' };
  }

  const thesis = thesisFailureReason(s.open_side, s.regime);
  if (thesis) {
    return { exit: true, reason: `${thesis} · lock green ${fav.toFixed(5)}` };
  }

  if (s.mfe >= mfeFloor && s.peak_retention != null && s.peak_retention < 0.35) {
    return {
      exit: true,
      reason: `PeakProtection · retention ${(s.peak_retention * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} · UPL ${fav.toFixed(5)}`,
    };
  }

  if (fav >= tp) {
    return {
      exit: true,
      reason: `Target / best outcome · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`,
    };
  }

  if (s.mfe >= mfeFloor && s.peak_retention != null && s.peak_retention < 0.5) {
    return {
      exit: true,
      reason: `BestOutcome harvest · UPL ${fav.toFixed(5)} after MFE ${s.mfe.toFixed(5)} (ret ${(s.peak_retention * 100).toFixed(0)}%)`,
    };
  }

  const heldMs = s.entry_at ? Date.now() - new Date(s.entry_at).getTime() : 0;
  if (heldMs > 360_000 && s.mfe >= mfeFloor * 0.5) {
    return {
      exit: true,
      reason: `TimeDecay · held ${Math.round(heldMs / 1000)}s · realize green UPL ${fav.toFixed(5)}`,
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
    hold: `BO · UPL ${fav.toFixed(2)} · HardInv @ -${sl.toFixed(2)} · MFE ${s.mfe.toFixed(2)}/${mfeFloor.toFixed(2)} · ret ${ret}`,
  };
}
