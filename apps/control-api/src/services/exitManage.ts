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
  atr?: number | null;
  structural_sl?: number | null;
  /** Optional liquidity / structure target beyond 1R */
  structure_target?: number | null;
  tick_size?: number | null;
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

export function bestOutcomeMfeFloor(
  entry: number,
  atr?: number | null,
  meta?: { tick_size?: number | null }
): number | null {
  const d = hardInvalidationDistance(entry, atr, meta);
  return d == null ? null : d * 0.5;
}

/** Primary 1R target distance (HardInv). Structure target is separate (#36/#5). */
export function bestOutcomeTarget(
  entry: number,
  atr?: number | null,
  meta?: { tick_size?: number | null },
  _structureTarget?: number | null
): number | null {
  return hardInvalidationDistance(entry, atr, meta);
}

export function bestOutcomeMinGreen(
  entry: number,
  atr?: number | null,
  meta?: { tick_size?: number | null }
): number | null {
  const floor = bestOutcomeMfeFloor(entry, atr, meta);
  return floor == null ? null : floor * 0.5;
}

/** Default PeakProtect policy — configurable; volatility-aware (#35). */
export const BEST_OUTCOME_LOCK_RETENTION = 0.75;
export const BEST_OUTCOME_LOCK_TRIGGER = 0.78;

/**
 * Adaptive PeakProtect trigger: quieter ATR% → tighter lock; expansion → slightly looser.
 * Still configurable via opts override.
 */
export function peakProtectTrigger(
  entry: number,
  atr: number | null | undefined,
  regime?: string | null
): { retention: number; trigger: number; detail: string } {
  let trigger = BEST_OUTCOME_LOCK_TRIGGER;
  let retention = BEST_OUTCOME_LOCK_RETENTION;
  const abs = Math.max(Math.abs(entry), 1e-9);
  if (atr != null && atr > 0) {
    const pct = atr / abs;
    if (pct < 0.0005) {
      trigger = 0.82;
      retention = 0.8;
    } else if (pct > 0.02) {
      trigger = 0.72;
      retention = 0.68;
    }
  }
  const r = String(regime || '').toUpperCase();
  if (r === 'EXPANSION' || r === 'BREAKOUT_UP' || r === 'BREAKOUT_DOWN') {
    trigger = Math.min(trigger, 0.74);
    retention = Math.min(retention, 0.7);
  }
  return {
    retention,
    trigger,
    detail: `PeakProtect policy ret=${retention} trig=${trigger} (configurable)`,
  };
}

export function isHardBoReason(reason: string): boolean {
  return /HardInvalidation|StructuralInvalidation|ThesisFailure · short|PeakProtection|OppositeSignal|Target \/ best outcome|TimeDecay|BestOutcome cut|BO BLOCK/i.test(
    reason
  );
}

export type BoExitOpts = {
  oppositeEntrySignal?: boolean;
  oppositeReason?: string;
  continuationSameSide?: boolean;
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

export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number,
  opts?: BoExitOpts
): { exit: boolean; reason: string } {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const entry = s.entry_price;
  const atr = s.atr ?? null;
  const meta = { tick_size: s.tick_size };
  const fav = favorableMove(s.open_side, entry, mid);
  const hardInv = hardInvalidationDistance(entry, atr, meta);
  const structDist = structuralInvalidationDistance(s.open_side, entry, s.structural_sl);

  // Critical UNKNOWN HardInv without structural SL → cannot manage (#32)
  if (hardInv == null && structDist == null) {
    return {
      exit: true,
      reason: 'BO BLOCK · HardInv/structural SL UNKNOWN · close to safety',
    };
  }

  const sl = structDist ?? hardInv!;
  const mfeFloor = bestOutcomeMfeFloor(entry, atr, meta) ?? sl * 0.5;
  const minGreen = bestOutcomeMinGreen(entry, atr, meta) ?? mfeFloor * 0.5;
  const armed = s.mfe >= mfeFloor;
  const liveRet = s.mfe > 0 ? Math.max(0, fav / s.mfe) : null;
  const ret = liveRet ?? s.peak_retention;
  const pp = peakProtectTrigger(entry, atr, s.regime);

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

  const thesisPct = shortThesisMovePct(entry, atr, meta);
  const thesisPts = shortThesisPts(entry, atr, meta);
  const short = s.short_net_pct;
  if (thesisPct != null && thesisPts != null && short != null && Number.isFinite(short)) {
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

  if (armed && ret != null && ret < pp.trigger && fav > 0) {
    return {
      exit: true,
      reason: `PeakProtection · keep ${(ret * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} · UPL ${fav.toFixed(5)} · lock@${(
        pp.retention * 100
      ).toFixed(0)}% (trig@${(pp.trigger * 100).toFixed(0)}%) · ${pp.detail}`,
    };
  }

  if (opts?.oppositeEntrySignal && !opts?.ignoreMicroOpposite) {
    const why = opts.oppositeReason || 'tape flipped';
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

  // 1R / structure target — continuation can hold past 1R toward structure_target
  const oneR = hardInv;
  const structTarget =
    s.structure_target != null && Number.isFinite(s.structure_target) && s.structure_target > 0
      ? s.structure_target
      : null;
  // Price float epsilon so entry+target mid round-trips still count as hit
  const hitEps = Math.max(Math.abs(entry) * 1e-12, 1e-9);

  if (oneR != null && fav + hitEps >= oneR) {
    const hitStruct = structTarget != null && fav + hitEps >= structTarget;
    const canHoldPast1R =
      Boolean(opts?.continuationSameSide) &&
      structTarget != null &&
      structTarget > oneR + hitEps &&
      !hitStruct;
    if (canHoldPast1R) {
      // hold toward structure/liquidity target — PeakProtect/HardInv already above
    } else if (hitStruct) {
      return {
        exit: true,
        reason: `Target / structure · UPL ${fav.toFixed(5)} ≥ structure ${structTarget!.toFixed(5)}`,
      };
    } else {
      return {
        exit: true,
        reason: `Target / best outcome · UPL ${fav.toFixed(5)} ≥ 1R ${oneR.toFixed(5)}`,
      };
    }
  }

  // Structure target hit even if 1R unknown (still after safety exits)
  if (structTarget != null && fav + hitEps >= structTarget) {
    return {
      exit: true,
      reason: `Target / structure · UPL ${fav.toFixed(5)} ≥ structure ${structTarget.toFixed(5)}`,
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
  const meta = { tick_size: s.tick_size };
  const fav = favorableMove(s.open_side, entry, mid);
  const structDist = structuralInvalidationDistance(s.open_side, entry, s.structural_sl);
  const hardInv = hardInvalidationDistance(entry, atr, meta);
  const sl = structDist ?? hardInv;
  const tp = bestOutcomeTarget(entry, atr, meta, s.structure_target);
  const mfeFloor = bestOutcomeMfeFloor(entry, atr, meta);
  const liveRet = s.mfe > 0 ? Math.max(0, fav / s.mfe) : null;
  const ret = liveRet ?? s.peak_retention;
  const pp = peakProtectTrigger(entry, atr, s.regime);
  const retTxt = ret != null ? `${(ret * 100).toFixed(0)}%` : '—';
  const armed =
    mfeFloor != null && s.mfe >= mfeFloor ? 'armed' : `arm@${mfeFloor?.toFixed(2) ?? '?'}`;
  const cont = opts?.continuationReason ? ` · ${opts.continuationReason}` : '';
  const structTxt =
    s.structural_sl != null ? ` · structSL ${s.structural_sl.toFixed(2)}` : '';

  return {
    exit: false,
    reason: '',
    hold: `BO · UPL ${fav.toFixed(2)} · 1R ${tp?.toFixed(2) ?? 'UNKNOWN'}${
      s.structure_target != null ? ` · structTgt ${s.structure_target.toFixed(2)}` : ''
    } · HardInv -${sl?.toFixed(2) ?? 'UNKNOWN'}${structTxt} · MFE ${s.mfe.toFixed(2)} (${armed}) · ret ${retTxt} · lock@${(pp.retention * 100).toFixed(0)}%${cont}`,
  };
}
