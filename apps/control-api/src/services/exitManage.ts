/** PROFIT engine — bank green fast, cut red at HardInv, zero flip-only hold. */

import {
  PROFIT_TIME_DECAY_MS,
  PROFIT_TP_GOLD_PT,
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

/** Arm PeakProtect after ~1.0pt MFE — real swing, not micro noise. */
export function bestOutcomeMfeFloor(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.00022, 1.0);
}

/** Micro-scalp TP — 2pt Gold, pct-scaled elsewhere. */
export function bestOutcomeTarget(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  if (abs >= 1000) return PROFIT_TP_GOLD_PT;
  return Math.max(abs * 0.00043, 0.8);
}

export function bestOutcomeMinGreen(entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  return Math.max(abs * 0.00015, 0.5);
}

export const BEST_OUTCOME_LOCK_RETENTION = 0.75;
export const BEST_OUTCOME_LOCK_TRIGGER = 0.78;

export function isHardBoReason(reason: string): boolean {
  return /HardInvalidation|ThesisFailure · short|PeakProtection|OppositeSignal|Target \/ best outcome|TimeDecay|BestOutcome cut/i.test(
    reason
  );
}

export type BoExitOpts = {
  oppositeEntrySignal?: boolean;
  oppositeReason?: string;
  /** @deprecated profit mode ignores — never skip bank paths */
  continuationSameSide?: boolean;
};

/**
 * Exit priority (all active — no hold-until-flip):
 * 1) HardInv 2pt
 * 2) Short thesis 3pt
 * 3) Armed flat → cut before minus
 * 4) PeakProtect 75%
 * 5) Opposite tape
 * 6) Thesis vs regime (green lock)
 * 7) TP 2pt
 * 8) TimeDecay 3min green
 */
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
  const liveRet = s.mfe > 0 ? Math.max(0, fav / s.mfe) : null;
  const ret = liveRet ?? s.peak_retention;

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

  if (armed && fav <= 0) {
    return {
      exit: true,
      reason: `BestOutcome cut · gave back MFE ${s.mfe.toFixed(5)} → UPL ${fav.toFixed(5)} (lock before minus)`,
    };
  }

  if (armed && ret != null && ret < BEST_OUTCOME_LOCK_TRIGGER && fav > 0) {
    return {
      exit: true,
      reason: `PeakProtection · keep ${(ret * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} · UPL ${fav.toFixed(5)} · lock@${(
        BEST_OUTCOME_LOCK_RETENTION * 100
      ).toFixed(0)}% (trig@${(BEST_OUTCOME_LOCK_TRIGGER * 100).toFixed(0)}%)`,
    };
  }

  if (opts?.oppositeEntrySignal) {
    const why = opts.oppositeReason || 'tape flipped';
    return {
      exit: true,
      reason: `OppositeSignal · exit ${s.open_side} · ${why}`,
    };
  }

  if (fav >= minGreen) {
    const thesis = thesisFailureReason(s.open_side, s.regime);
    if (thesis) {
      return { exit: true, reason: `${thesis} · lock green ${fav.toFixed(5)}` };
    }
  }

  if (fav >= tp) {
    return {
      exit: true,
      reason: `Target / best outcome · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`,
    };
  }

  const heldMs = s.entry_at ? Date.now() - new Date(s.entry_at).getTime() : 0;
  if (heldMs > PROFIT_TIME_DECAY_MS && fav >= minGreen && s.mfe >= mfeFloor) {
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
      hold: 'PROFIT blocked — missing entry_price',
    };
  }

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const sl = hardInvalidationDistance(entry);
  const tp = bestOutcomeTarget(entry);
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
    hold: `PROFIT · UPL ${fav.toFixed(2)} · TP ${tp.toFixed(1)} · HardInv -${sl.toFixed(2)} · MFE ${s.mfe.toFixed(2)} (${armed}) · ret ${retTxt} · lock@${lock}${cont}`,
  };
}
