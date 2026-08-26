/** Live Capital exit — hold until opposite entry signal (or HardInv). */

import {
  SHORT_THESIS_GOLD_PT,
  SHORT_THESIS_MOVE_PCT,
  hardInvalidationDistance,
} from './microScalpThresholds.js';

export { hardInvalidationDistance };

export type ExitSide = 'BUY' | 'SELL';

export type ExitSnapshot = {
  open_side: ExitSide | null;
  entry_price: number | null;
  entry_at: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  regime?: string | null;
  short_net_pct?: number | null;
};

export function favorableMove(side: ExitSide, entry: number, mid: number): number {
  return side === 'BUY' ? mid - entry : entry - mid;
}

/**
 * Price to evaluate BO exits.
 * HardInv must use adverse fill side — mid understates loss by the spread.
 * BUY open → exit sells at bid; SELL open → exit buys at ask.
 */
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

/** Kept for UI / journal — PeakProtect no longer soft-exits (hold until opposite). */
export function bestOutcomeMfeFloor(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.00022, 1.0);
}

export function bestOutcomeTarget(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.0053, 0.8);
}

export function bestOutcomeMinGreen(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.00022, 1.0);
}

/** Display lock % — soft PeakProtect disabled; hold until opposite. */
export const BEST_OUTCOME_LOCK_RETENTION = 0.7;
export const BEST_OUTCOME_LOCK_TRIGGER = 0.73;

export function isHardBoReason(reason: string): boolean {
  return /HardInvalidation|ThesisFailure · short|OppositeSignal/i.test(reason);
}

export type BoExitOpts = {
  /** True when 5m+1m tape clearly flipped vs open side. */
  oppositeEntrySignal?: boolean;
  oppositeReason?: string;
  /** @deprecated soft continuation — hold-until-opposite ignores PeakProtect anyway */
  continuationSameSide?: boolean;
};

/**
 * Hold until opposite entry signal (tape flip) or HardInv.
 * No PeakProtect / soft TP / £0 giveback cuts — those caused 5× same-side spam.
 */
export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number,
  opts?: BoExitOpts
): { exit: boolean; reason: string } {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const sl = hardInvalidationDistance(entry);

  if (fav <= -sl) {
    return { exit: true, reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}` };
  }

  // Violent short-window dump/rally vs open — treat as opposite pressure
  const short = s.short_net_pct;
  if (short != null && Number.isFinite(short)) {
    if (s.open_side === 'BUY' && short <= -SHORT_THESIS_MOVE_PCT) {
      return {
        exit: true,
        reason: `ThesisFailure · short dump ${(short * 100).toFixed(2)}% (~${SHORT_THESIS_GOLD_PT}pt) vs BUY`,
      };
    }
    if (s.open_side === 'SELL' && short >= SHORT_THESIS_MOVE_PCT) {
      return {
        exit: true,
        reason: `ThesisFailure · short rally ${(short * 100).toFixed(2)}% (~${SHORT_THESIS_GOLD_PT}pt) vs SELL`,
      };
    }
  }

  if (opts?.oppositeEntrySignal) {
    const why = opts.oppositeReason || 'tape flipped';
    return {
      exit: true,
      reason: `OppositeSignal · exit ${s.open_side} · ${why}`,
    };
  }

  // Hold — wait for opposite entry signal (or HardInv above)
  return { exit: false, reason: '' };
}

export function describeBestOutcomeState(
  s: ExitSnapshot,
  mid: number,
  opts?: BoExitOpts & { continuationReason?: string }
): { exit: boolean; reason: string; hold: string } {
  const decision = decideBestOutcomeExit(s, mid, opts);
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
  const wait = opts?.continuationReason
    ? ` · HOLD until opposite · ${opts.continuationReason}`
    : ' · HOLD until opposite entry signal';

  return {
    exit: false,
    reason: '',
    hold: `BO10s · UPL ${fav.toFixed(2)} · HardInv -${sl.toFixed(2)} · MFE ${s.mfe.toFixed(2)}${wait}`,
  };
}
