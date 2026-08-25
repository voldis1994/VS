/** Live Capital exit manager — 5m brain: hold winners longer through noise. */

export type ExitSide = 'BUY' | 'SELL';

export type ExitSnapshot = {
  open_side: ExitSide | null;
  entry_price: number | null;
  entry_at: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  regime?: string | null;
  /** Short ~30m net move as fraction (e.g. -0.004 = −0.4%). Cuts BUY into dump even if regime lags. */
  short_net_pct?: number | null;
};

export function favorableMove(side: ExitSide, entry: number, mid: number): number {
  return side === 'BUY' ? mid - entry : entry - mid;
}

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

/** HardInv ≈0.22% — Gold ~10pt (survive 5m noise). */
export function hardInvalidationDistance(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.0022, 0.2);
}

/**
 * Arm peak trail only after a real swing — ~0.28% / ~13pt Gold.
 * (Was ~0.12% / ~5.5pt — locked too early on noise pullbacks.)
 */
export function bestOutcomeMfeFloor(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.0028, 8);
}

/** Soft TP ≈1.20% — ~55pt Gold — let 5m trends run. */
export function bestOutcomeTarget(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.012, 1.2);
}

/** Min green soft-exit ~0.12% / ~5.5pt — don't bank micro scraps. */
export function bestOutcomeMinGreen(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.0012, 5);
}

/**
 * Peak trail lock: exit when retention falls below this while still green.
 * 0.50 = allow ~50% giveback of MFE (was 0.70 → cut on tiny dips).
 */
export const BEST_OUTCOME_LOCK_RETENTION = 0.5;

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

  // Price already dumped/rallied against us — don't wait for regime label to flip
  const short = s.short_net_pct;
  if (short != null && Number.isFinite(short)) {
    if (s.open_side === 'BUY' && short <= -0.002) {
      return {
        exit: true,
        reason: `ThesisFailure · short dump ${(short * 100).toFixed(2)}% vs BUY`,
      };
    }
    if (s.open_side === 'SELL' && short >= 0.002) {
      return {
        exit: true,
        reason: `ThesisFailure · short rally ${(short * 100).toFixed(2)}% vs SELL`,
      };
    }
  }

  if (armed) {
    if (fav <= 0) {
      return {
        exit: true,
        reason: `BestOutcome cut · gave back MFE ${s.mfe.toFixed(5)} → UPL ${fav.toFixed(5)} (lock before minus)`,
      };
    }
    if (ret != null && ret < BEST_OUTCOME_LOCK_RETENTION && fav >= minGreen) {
      return {
        exit: true,
        reason: `PeakProtection · keep ${(ret * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} · UPL ${fav.toFixed(5)}`,
      };
    }
  }

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

  const heldMs = s.entry_at ? Date.now() - new Date(s.entry_at).getTime() : 0;
  // TimeDecay after ~75 min on 5m holds
  if (heldMs > 4_500_000 && fav >= minGreen && s.mfe >= mfeFloor) {
    return {
      exit: true,
      reason: `TimeDecay · held ${Math.round(heldMs / 1000)}s · realize green UPL ${fav.toFixed(5)}`,
    };
  }

  return { exit: false, reason: '' };
}

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
    hold: `BO5m · UPL ${fav.toFixed(2)} · min+${minGreen.toFixed(1)} · lock@${lock} · HardInv -${sl.toFixed(2)} · MFE ${s.mfe.toFixed(2)}/${mfeFloor.toFixed(2)} · ret ${ret}`,
  };
}
