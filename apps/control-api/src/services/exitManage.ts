/** Live Capital exit manager — fix win/loss asymmetry on micro (no +£0.01 vs −£0.60). */

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

/** Robot HardInv ≈0.08% — Gold ~3.7pt ≈ ~£0.40 on 0.14 lot (was ~£0.60). */
export function hardInvalidationDistance(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.0008, 0.08);
}

/**
 * Arm peak/harvest only after a REAL excursion — ~2.2pt Gold.
 * Was ~1.0pt → locked +£0.01 noise while HardInv still took −£0.60.
 */
export function bestOutcomeMfeFloor(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.00048, 1.8);
}

/** Soft TP ≈0.28% — winners must grow (~13pt Gold) before target exit. */
export function bestOutcomeTarget(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.0028, 0.28);
}

/**
 * Min green to soft-exit (peak / thesis / time) — ~1.2pt Gold.
 * Blocks micro-harvest (+£0.01 / +£0.03) that cannot cover one HardInv.
 */
export function bestOutcomeMinGreen(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.00026, 1.0);
}

/** Keep ~70%+ of peak once armed (was 65%). */
export const BEST_OUTCOME_LOCK_RETENTION = 0.7;

/**
 * Manage exit — smaller max loss, larger min win; no micro-green harvest.
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
    // Lock majority — but only if still a meaningful green (not +0.01 noise)
    if (ret != null && ret < BEST_OUTCOME_LOCK_RETENTION && fav >= minGreen) {
      return {
        exit: true,
        reason: `PeakProtection · keep ${(ret * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} · UPL ${fav.toFixed(5)}`,
      };
    }
  }

  // Young / tiny green — hold (covers +£0.01…+£0.06 spam)
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

  // No light harvest band — PeakProtection @ 70% is enough (was double-exit noise)

  const heldMs = s.entry_at ? Date.now() - new Date(s.entry_at).getTime() : 0;
  // TimeDecay only after real MFE and meaningful green (not flat-ish)
  if (heldMs > 300_000 && fav >= minGreen && s.mfe >= mfeFloor) {
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
  const minGreen = bestOutcomeMinGreen(entry);
  const ret =
    s.peak_retention != null ? `${(s.peak_retention * 100).toFixed(0)}%` : '—';
  const lock = `${(BEST_OUTCOME_LOCK_RETENTION * 100).toFixed(0)}%`;

  return {
    exit: false,
    reason: '',
    hold: `BO · UPL ${fav.toFixed(2)} · min+${minGreen.toFixed(1)} · lock@${lock} · HardInv -${sl.toFixed(2)} · MFE ${s.mfe.toFixed(2)}/${mfeFloor.toFixed(2)} · ret ${ret}`,
  };
}
