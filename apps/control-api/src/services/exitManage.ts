/** Live Capital exit — 10s scalp BO with continuation hold support. */

import {
  HARD_INV_GOLD_PT,
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
 * HardInv / PeakProtect must use adverse fill side — mid understates loss by the spread.
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


/** Arm PeakProtect on micro swing — ≥0.20pt Gold (was 1.0pt → +0.25 never locked). */
export function bestOutcomeMfeFloor(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.00004, 0.2);
}

/** Soft TP ≈0.53% — ~25pt Gold — 10s scalp target. */
export function bestOutcomeTarget(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.0053, 0.8);
}

/** Min green for soft TP / timeDecay — ~0.5pt (PeakProtect uses any green). */
export function bestOutcomeMinGreen(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.00015, 0.5);
}

/**
 * PeakProtect: exit when kept MFE drops below 70% (give back max ~30%).
 * Trigger slightly early (73%) so Capital latency doesn't overshoot the lock.
 */
export const BEST_OUTCOME_LOCK_RETENTION = 0.7;
/** Fire PeakProtect when ret falls under this (buffer above 70% for exit lag). */
export const BEST_OUTCOME_LOCK_TRIGGER = 0.73;

export function isHardBoReason(reason: string): boolean {
  return /HardInvalidation|ThesisFailure · short|PeakProtection/i.test(reason);
}

export type BoExitOpts = {
  /** When true — skip soft TP / thesis / timeDecay. Does NOT skip PeakProtect or HardInv. */
  continuationSameSide?: boolean;
};

export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number,
  opts?: BoExitOpts
): { exit: boolean; reason: string } {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const tp = bestOutcomeTarget(entry);
  const sl = hardInvalidationDistance(entry);
  const mfeFloor = bestOutcomeMfeFloor(entry);
  const minGreen = bestOutcomeMinGreen(entry);
  const armed = s.mfe >= mfeFloor;
  // Live retention from points — never trust stale peak_retention alone
  const liveRet = s.mfe > 0 ? Math.max(0, fav / s.mfe) : null;
  const ret = liveRet ?? s.peak_retention;
  const holdCont = Boolean(opts?.continuationSameSide);

  if (fav <= -sl) {
    return { exit: true, reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}` };
  }

  const short = s.short_net_pct;
  if (short != null && Number.isFinite(short)) {
    if (s.open_side === 'BUY' && short <= -SHORT_THESIS_MOVE_PCT) {
      return {
        exit: true,
        reason: `ThesisFailure · short dump ${(short * 100).toFixed(2)}% (~${HARD_INV_GOLD_PT}pt) vs BUY`,
      };
    }
    if (s.open_side === 'SELL' && short >= SHORT_THESIS_MOVE_PCT) {
      return {
        exit: true,
        reason: `ThesisFailure · short rally ${(short * 100).toFixed(2)}% (~${HARD_INV_GOLD_PT}pt) vs SELL`,
      };
    }
  }

  // Gave back to flat/red after a real peak — still cut (don't hold hope into minus)
  if (armed && fav <= 0) {
    return {
      exit: true,
      reason: `BestOutcome cut · gave back MFE ${s.mfe.toFixed(5)} → UPL ${fav.toFixed(5)} (lock before minus)`,
    };
  }

  // PeakProtect — max ~30% giveback. Trigger @73% so exit lag doesn't overshoot 70% lock
  if (armed && ret != null && ret < BEST_OUTCOME_LOCK_TRIGGER && fav > 0) {
    return {
      exit: true,
      reason: `PeakProtection · keep ${(ret * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} · UPL ${fav.toFixed(5)} · lock@${(
        BEST_OUTCOME_LOCK_RETENTION * 100
      ).toFixed(0)}% (trig@${(BEST_OUTCOME_LOCK_TRIGGER * 100).toFixed(0)}%)`,
    };
  }

  // Continuation: only soft exits skipped (TP / thesis / timeDecay)
  if (holdCont) {
    return { exit: false, reason: '' };
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
  // TimeDecay after ~12 min on 10s holds
  if (heldMs > 720_000 && fav >= minGreen && s.mfe >= mfeFloor) {
    return {
      exit: true,
      reason: `TimeDecay · held ${Math.round(heldMs / 1000)}s · realize green UPL ${fav.toFixed(5)}`,
    };
  }

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
  const minGreen = bestOutcomeMinGreen(entry);
  const ret =
    s.peak_retention != null ? `${(s.peak_retention * 100).toFixed(0)}%` : '—';
  const lock = `${(BEST_OUTCOME_LOCK_RETENTION * 100).toFixed(0)}%`;
  const cont =
    opts?.continuationSameSide && opts.continuationReason
      ? ` · HOLD ${opts.continuationReason}`
      : opts?.continuationSameSide
        ? ' · HOLD continuation'
        : '';

  return {
    exit: false,
    reason: '',
    hold: `BO10s · UPL ${fav.toFixed(2)} · min+${minGreen.toFixed(1)} · lock@${lock} · HardInv -${sl.toFixed(2)} · MFE ${s.mfe.toFixed(2)}/${mfeFloor.toFixed(2)} · ret ${ret}${cont}`,
  };
}
