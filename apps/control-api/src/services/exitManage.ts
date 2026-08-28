/**
 * Best Outcome — restored Aug 13 2026 17:43 setup (commit e0e479a).
 * Simple % TP/SL + peak retention harvest on MID price.
 * No GivebackBE / 5m young mute / hybrid PeakTrail (those were chopping +£0.86 → +£0.01).
 */

export type ExitSide = 'BUY' | 'SELL';

export type ExitSnapshot = {
  open_side: ExitSide | null;
  entry_price: number | null;
  entry_at: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  regime?: string | null;
  /** Ignored by Aug-13 BO — kept for session/journal typing */
  short_net_pct?: number | null;
  atr?: number | null;
  structural_sl?: number | null;
  structure_target?: number | null;
  tick_size?: number | null;
  broker_upl?: number | null;
  spread?: number | null;
};

/** Aug-13 constants */
export const BO_TP_PCT = 0.0035;
export const BO_TP_MIN = 0.35;
export const BO_SL_PCT = 0.0022;
export const BO_SL_MIN = 0.22;
export const BO_MFE_FLOOR_PCT = 0.0012;
export const BO_MFE_FLOOR_MIN = 0.12;
export const BO_PEAK_PROTECT_RETENTION = 0.3;
export const BO_HARVEST_RETENTION = 0.4;
export const BO_TIME_DECAY_MS = 480_000;

export type BoExitOpts = Record<string, unknown>;

export function favorableMove(side: ExitSide, entry: number, mid: number): number {
  return side === 'BUY' ? mid - entry : entry - mid;
}

export function manageExitPrice(
  side: ExitSide,
  quote: { bid?: number | null; ask?: number | null; mid?: number | null }
): number | null {
  if (side === 'BUY') {
    if (quote.bid != null && Number.isFinite(quote.bid)) return quote.bid;
  } else {
    if (quote.ask != null && Number.isFinite(quote.ask)) return quote.ask;
  }
  if (quote.mid != null && Number.isFinite(quote.mid)) return quote.mid;
  return null;
}

export function boTpDistance(entry: number): number {
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  return Math.max(absEntry * BO_TP_PCT, BO_TP_MIN);
}

export function boSlDistance(entry: number): number {
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  return Math.max(absEntry * BO_SL_PCT, BO_SL_MIN);
}

export function boMfeFloor(entry: number): number {
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  return Math.max(absEntry * BO_MFE_FLOOR_PCT, BO_MFE_FLOOR_MIN);
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

export function isHardBoReason(reason: string): boolean {
  return /HardInvalidation|ThesisFailure|PeakProtection|Target \/|BestOutcome harvest|TimeDecay/i.test(
    reason
  );
}

/**
 * Manage exit — give the trade room to develop (~10s scalp with breathing room).
 * Broker SAFETY SL is the hard cushion; this is best-outcome + thesis management.
 * Uses MID price (Aug 13) — never broker £ UPL for exit decisions.
 */
export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number,
  _opts?: BoExitOpts
): { exit: boolean; reason: string } {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const thesis = thesisFailureReason(s.open_side, s.regime);
  if (thesis) return { exit: true, reason: thesis };

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const hitEps = Math.max(Math.abs(entry) * 1e-12, 1e-9);
  const tp = boTpDistance(entry);
  const sl = boSlDistance(entry);
  const mfeFloor = boMfeFloor(entry);

  if (fav <= -sl) {
    return { exit: true, reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}` };
  }

  if (s.mfe >= mfeFloor && s.peak_retention != null && s.peak_retention < BO_PEAK_PROTECT_RETENTION) {
    return {
      exit: true,
      reason: `PeakProtection · retention ${(s.peak_retention * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} → lock best`,
    };
  }

  if (fav + hitEps >= tp) {
    return {
      exit: true,
      reason: `Target / best outcome · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`,
    };
  }

  if (
    s.mfe >= mfeFloor &&
    fav > 0 &&
    s.peak_retention != null &&
    s.peak_retention < BO_HARVEST_RETENTION
  ) {
    return {
      exit: true,
      reason: `BestOutcome harvest · UPL ${fav.toFixed(5)} after MFE ${s.mfe.toFixed(5)} (ret ${(s.peak_retention * 100).toFixed(0)}%)`,
    };
  }

  const heldMs = s.entry_at ? Date.now() - new Date(s.entry_at).getTime() : 0;
  if (heldMs > BO_TIME_DECAY_MS && fav >= 0 && s.mfe >= mfeFloor * 0.5) {
    return {
      exit: true,
      reason: `TimeDecay · held ${Math.round(heldMs / 1000)}s · realize non-negative best UPL ${fav.toFixed(5)}`,
    };
  }

  return { exit: false, reason: '' };
}

export function describeBestOutcomeState(
  s: ExitSnapshot,
  mid: number,
  _opts?: BoExitOpts & { continuationReason?: string }
): { exit: boolean; reason: string; hold: string } {
  const decision = decideBestOutcomeExit(s, mid);
  if (decision.exit) return { ...decision, hold: '' };

  if (!s.open_side || s.entry_price == null) {
    return { exit: false, reason: '', hold: 'BO blocked — missing entry_price' };
  }

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const tp = boTpDistance(entry);
  const sl = boSlDistance(entry);
  const mfeFloor = boMfeFloor(entry);

  return {
    exit: false,
    reason: '',
    hold: `BO HOLD · UPL ${fav.toFixed(2)} · peak MFE ${s.mfe.toFixed(2)} · TP ${tp.toFixed(2)} · SL ${sl.toFixed(2)} · floor ${mfeFloor.toFixed(2)} · ret ${
      s.peak_retention != null ? `${(s.peak_retention * 100).toFixed(0)}%` : '—'
    }`,
  };
}
