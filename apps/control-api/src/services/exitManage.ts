/** Best Outcome — 5m trade management. Structural SL + Capital Safety SL separated. */

import {
  PROFIT_TIME_DECAY_MS,
  hardInvalidationDistance,
  shortThesisMovePct,
  shortThesisPts,
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
  /** 5m ATR for universal thresholds */
  atr?: number | null;
  /** Soft structural invalidation level (not Capital Safety SL) */
  structural_sl?: number | null;
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

/** Arm PeakProtect after meaningful MFE (ATR / pct — not Gold 1.0pt hardcode). */
export function bestOutcomeMfeFloor(entry: number, atr?: number | null): number {
  return hardInvalidationDistance(entry, atr) * 0.5;
}

/** 5m TP — ATR/pct scaled (universal). */
export function bestOutcomeTarget(entry: number, atr?: number | null): number {
  return hardInvalidationDistance(entry, atr);
}

export function bestOutcomeMinGreen(entry: number, atr?: number | null): number {
  return bestOutcomeMfeFloor(entry, atr) * 0.5;
}

export const BEST_OUTCOME_LOCK_RETENTION = 0.75;
export const BEST_OUTCOME_LOCK_TRIGGER = 0.78;

export function isHardBoReason(reason: string): boolean {
  return /HardInvalidation|StructuralInvalidation|ThesisFailure · short|PeakProtection|OppositeSignal|Target \/ best outcome|TimeDecay|BestOutcome cut/i.test(
    reason
  );
}

export type BoExitOpts = {
  oppositeEntrySignal?: boolean;
  oppositeReason?: string;
  continuationSameSide?: boolean;
  /** When true, opposite LTF tape alone does not exit a valid 5m hold */
  ignoreMicroOpposite?: boolean;
};

function structuralInvalidationDistance(
  side: ExitSide,
  entry: number,
  structuralSl: number | null | undefined
): number | null {
  if (structuralSl == null || !Number.isFinite(structuralSl)) return null;
  if (side === 'BUY') {
    const d = entry - structuralSl;
    return d > 0 ? d : null;
  }
  const d = structuralSl - entry;
  return d > 0 ? d : null;
}

/**
 * Exit priority:
 * 1) Structural invalidation (soft SL)
 * 2) HardInv (ATR fallback)
 * 3) Short thesis dump/rally
 * 4) Armed flat → cut before minus
 * 5) PeakProtect 75%
 * 6) Opposite structure (not micro-noise alone)
 * 7) Thesis vs regime (green lock)
 * 8) TP
 * 9) TimeDecay 15min green
 */
export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number,
  opts?: BoExitOpts
): { exit: boolean; reason: string } {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const entry = s.entry_price;
  const atr = s.atr ?? null;
  const fav = favorableMove(s.open_side, entry, mid);
  const tp = bestOutcomeTarget(entry, atr);
  const structDist = structuralInvalidationDistance(s.open_side, entry, s.structural_sl);
  const sl = structDist ?? hardInvalidationDistance(entry, atr);
  const mfeFloor = bestOutcomeMfeFloor(entry, atr);
  const minGreen = bestOutcomeMinGreen(entry, atr);
  const armed = s.mfe >= mfeFloor;
  const liveRet = s.mfe > 0 ? Math.max(0, fav / s.mfe) : null;
  const ret = liveRet ?? s.peak_retention;

  if (s.structural_sl != null && Number.isFinite(s.structural_sl)) {
    if (s.open_side === 'BUY' && mid <= s.structural_sl) {
      return {
        exit: true,
        reason: `StructuralInvalidation · mid ${mid.toFixed(5)} ≤ SL ${s.structural_sl.toFixed(5)}`,
      };
    }
    if (s.open_side === 'SELL' && mid >= s.structural_sl) {
      return {
        exit: true,
        reason: `StructuralInvalidation · mid ${mid.toFixed(5)} ≥ SL ${s.structural_sl.toFixed(5)}`,
      };
    }
  }

  if (fav <= -sl) {
    return { exit: true, reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}` };
  }

  const thesisPct = shortThesisMovePct(entry, atr);
  const thesisPts = shortThesisPts(entry, atr);
  const short = s.short_net_pct;
  if (short != null && Number.isFinite(short)) {
    if (s.open_side === 'BUY' && short <= -thesisPct) {
      return {
        exit: true,
        reason: `ThesisFailure · short dump ${(short * 100).toFixed(2)}% (~${thesisPts.toFixed(2)}pt) vs BUY`,
      };
    }
    if (s.open_side === 'SELL' && short >= thesisPct) {
      return {
        exit: true,
        reason: `ThesisFailure · short rally ${(short * 100).toFixed(2)}% (~${thesisPts.toFixed(2)}pt) vs SELL`,
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

  if (opts?.oppositeEntrySignal && !opts?.ignoreMicroOpposite) {
    const why = opts.oppositeReason || 'tape flipped';
    // Only exit on opposite if MFE not strongly held — avoid micro-noise kills
    if (!armed || (ret != null && ret < 0.9) || fav < minGreen) {
      return {
        exit: true,
        reason: `OppositeSignal · exit ${s.open_side} · ${why}`,
      };
    }
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
      hold: 'BO blocked — missing entry_price',
    };
  }

  const entry = s.entry_price;
  const atr = s.atr ?? null;
  const fav = favorableMove(s.open_side, entry, mid);
  const structDist = structuralInvalidationDistance(s.open_side, entry, s.structural_sl);
  const sl = structDist ?? hardInvalidationDistance(entry, atr);
  const tp = bestOutcomeTarget(entry, atr);
  const mfeFloor = bestOutcomeMfeFloor(entry, atr);
  const liveRet = s.mfe > 0 ? Math.max(0, fav / s.mfe) : null;
  const ret = liveRet ?? s.peak_retention;
  const lock = `${(BEST_OUTCOME_LOCK_RETENTION * 100).toFixed(0)}%`;
  const retTxt = ret != null ? `${(ret * 100).toFixed(0)}%` : '—';
  const armed = s.mfe >= mfeFloor ? 'armed' : `arm@${mfeFloor.toFixed(2)}`;
  const cont = opts?.continuationReason ? ` · ${opts.continuationReason}` : '';
  const structTxt =
    s.structural_sl != null ? ` · structSL ${s.structural_sl.toFixed(2)}` : '';

  return {
    exit: false,
    reason: '',
    hold: `BO · UPL ${fav.toFixed(2)} · TP ${tp.toFixed(2)} · HardInv -${sl.toFixed(2)}${structTxt} · MFE ${s.mfe.toFixed(2)} (${armed}) · ret ${retTxt} · lock@${lock}${cont}`,
  };
}
