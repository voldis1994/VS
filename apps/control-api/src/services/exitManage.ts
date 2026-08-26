/** Live Capital exit — close only on flip (or HardInv). No BUY→BUY / SELL→SELL. */

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

/** MFE floor for INFO / journal (PeakProtect no longer soft-exits alone). */
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
  return Math.max(abs * 0.00015, 0.5);
}

/** Display lock % — soft PeakProtect does not close; flip-only exit. */
export const BEST_OUTCOME_LOCK_RETENTION = 0.75;
export const BEST_OUTCOME_LOCK_TRIGGER = 0.78;

export function isHardBoReason(reason: string): boolean {
  return /HardInvalidation|ThesisFailure · short|OppositeSignal/i.test(reason);
}

export type BoExitOpts = {
  /** True when next setup is the opposite side — ONLY green-path close allowed. */
  oppositeEntrySignal?: boolean;
  oppositeReason?: string;
  continuationSameSide?: boolean;
};

/**
 * User rule: close ONLY when next is NOT same side (no SELL→SELL / BUY→BUY).
 *
 * Allowed exits:
 * 1) HardInv 2.0pt (disaster)
 * 2) Short dump/rally thesis 3pt (violent adverse)
 * 3) OppositeSignal — next entry would be the other side
 *
 * PeakProtect / soft TP / timeDecay do NOT close alone (that caused same-side reopen).
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

  // Flip-only green exit — next must be opposite (no BUY→BUY / SELL→SELL)
  if (opts?.oppositeEntrySignal) {
    const why = opts.oppositeReason || 'next setup is opposite';
    const mfeFloor = bestOutcomeMfeFloor(entry);
    const armed = s.mfe >= mfeFloor;
    const liveRet = s.mfe > 0 ? Math.max(0, fav / s.mfe) : null;
    const ret = liveRet ?? s.peak_retention;
    const lockNote =
      armed && ret != null
        ? ` · MFE ${s.mfe.toFixed(2)} ret ${(ret * 100).toFixed(0)}% (lock@${(
            BEST_OUTCOME_LOCK_RETENTION * 100
          ).toFixed(0)}%)`
        : '';
    return {
      exit: true,
      reason: `OppositeSignal · exit ${s.open_side} · next ≠ same · ${why}${lockNote}`,
    };
  }

  // Hold — same-side continuation; PeakProtect does not close alone
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
  const mfeFloor = bestOutcomeMfeFloor(entry);
  const liveRet = s.mfe > 0 ? Math.max(0, fav / s.mfe) : null;
  const ret = liveRet ?? s.peak_retention;
  const lock = `${(BEST_OUTCOME_LOCK_RETENTION * 100).toFixed(0)}%`;
  const retTxt = ret != null ? `${(ret * 100).toFixed(0)}%` : '—';
  const armed = s.mfe >= mfeFloor ? 'armed' : `arm@${mfeFloor.toFixed(1)}`;
  const cont = opts?.continuationReason ? ` · ${opts.continuationReason}` : '';

  return {
    exit: false,
    reason: '',
    hold: `HOLD until flip · UPL ${fav.toFixed(2)} · HardInv -${sl.toFixed(2)} · MFE ${s.mfe.toFixed(2)} (${armed}) · ret ${retTxt} · lock@${lock} INFO${cont}`,
  };
}
