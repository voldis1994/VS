/**
 * Best Outcome — 5m trade management.
 * MAX OUTCOME MEMORY + STRUCTURE REVERSAL EXIT.
 * HOLD while thesis/structure is alive; normal retrace is NOT an exit.
 * Capital Safety SL is separate (broker). Manual lot_size unchanged.
 */

import {
  hardInvalidationDistance,
  shortThesisMovePct,
  shortThesisPts,
} from './microScalpThresholds.js';
import {
  detectStructureReversalExit,
  thesisAlive5m,
  type StructureReversalInput,
} from './structureReversalExit.js';
import type { StructureBar } from './marketStructure.js';

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

export type PeakProtectStrength = 'strong' | 'normal' | 'weak';

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

/** 1R distance (HardInv). Structure target is separate. */
export function bestOutcomeTarget(
  entry: number,
  atr?: number | null,
  meta?: { tick_size?: number | null },
  _structureTarget?: number | null
): number | null {
  return hardInvalidationDistance(entry, atr, meta);
}

/**
 * PeakProtect arms only when MFE ≥ max(1R, ATR_5m).
 * Below that: HOLD through normal 5m retrace (no small-profit scalp exits).
 */
export function peakProtectArmThreshold(
  entry: number,
  atr?: number | null,
  meta?: { tick_size?: number | null }
): number | null {
  const oneR = hardInvalidationDistance(entry, atr, meta);
  if (oneR == null || !(oneR > 0)) return null;
  if (atr != null && Number.isFinite(atr) && atr > 0) {
    return Math.max(oneR, atr);
  }
  return oneR;
}

/** @deprecated alias — arm threshold is max(1R, ATR), not half HardInv */
export function bestOutcomeMfeFloor(
  entry: number,
  atr?: number | null,
  meta?: { tick_size?: number | null }
): number | null {
  return peakProtectArmThreshold(entry, atr, meta);
}

export function bestOutcomeMinGreen(
  entry: number,
  atr?: number | null,
  meta?: { tick_size?: number | null }
): number | null {
  const floor = peakProtectArmThreshold(entry, atr, meta);
  return floor == null ? null : floor * 0.35;
}

/**
 * Retrace allowance K for ProtectedProfit = MFE − K×ATR_5m.
 * Strong continuation → larger K (more room). Weak/choppy → tighter.
 */
export function peakProtectK(
  regime?: string | null,
  opts?: { continuationSameSide?: boolean; strength?: PeakProtectStrength }
): { k: number; strength: PeakProtectStrength; detail: string } {
  if (opts?.strength) {
    const k =
      opts.strength === 'strong' ? 1.0 : opts.strength === 'weak' ? 0.4 : 0.7;
    return { k, strength: opts.strength, detail: `K=${k} (${opts.strength})` };
  }
  const r = String(regime || '')
    .trim()
    .toUpperCase();
  if (
    opts?.continuationSameSide &&
    (r === 'TREND_UP' ||
      r === 'TREND_DOWN' ||
      r === 'BREAKOUT_UP' ||
      r === 'BREAKOUT_DOWN' ||
      r === 'PULLBACK_UPTREND' ||
      r === 'PULLBACK_DOWNTREND')
  ) {
    return { k: 1.0, strength: 'strong', detail: 'K=1.0 (strong continuation)' };
  }
  if (
    r === 'RANGE' ||
    r === 'TRANSITION' ||
    r === 'REVERSAL_CANDIDATE' ||
    r === 'EXPANSION' ||
    r === 'UNKNOWN' ||
    !r
  ) {
    return { k: 0.4, strength: 'weak', detail: 'K=0.4 (weak/choppy)' };
  }
  return { k: 0.7, strength: 'normal', detail: 'K=0.7 (normal)' };
}

/**
 * ATR buffer for PeakProtect. Prefer ATR_5m; fall back to 1R only when ATR UNKNOWN
 * so we do not invent a synthetic ATR magnitude.
 */
export function peakProtectAtrBuffer(
  entry: number,
  atr: number | null | undefined,
  meta?: { tick_size?: number | null }
): number | null {
  if (atr != null && Number.isFinite(atr) && atr > 0) return atr;
  return hardInvalidationDistance(entry, atr, meta);
}

export function protectedProfitLevel(
  mfe: number,
  atrBuffer: number,
  k: number
): number {
  return mfe - k * atrBuffer;
}

/** @deprecated legacy % PeakProtect — kept for import stability; unused by 5m BO */
export const BEST_OUTCOME_LOCK_RETENTION = 0.75;
export const BEST_OUTCOME_LOCK_TRIGGER = 0.78;

/** @deprecated — 5m BO uses K×ATR ProtectedProfit, not % retention trigger */
export function peakProtectTrigger(
  entry: number,
  atr: number | null | undefined,
  regime?: string | null
): { retention: number; trigger: number; detail: string } {
  const { k, strength, detail } = peakProtectK(regime);
  return {
    retention: BEST_OUTCOME_LOCK_RETENTION,
    trigger: BEST_OUTCOME_LOCK_TRIGGER,
    detail: `legacy% unused · 5m ${detail} strength=${strength} entry=${entry} atr=${atr ?? '—'}`,
  };
}

export function isHardBoReason(reason: string): boolean {
  return /HardInvalidation|StructuralInvalidation|ThesisFailure|PeakProtection|OppositeSignal|Target \/|BO BLOCK/i.test(
    reason
  );
}

export type BoExitOpts = {
  oppositeEntrySignal?: boolean;
  oppositeReason?: string;
  continuationSameSide?: boolean;
  ignoreMicroOpposite?: boolean;
  peakProtectStrength?: PeakProtectStrength;
  /** 5m/1m/10s bars for structure-reversal exit (preferred over PeakProtect). */
  bars5m?: StructureBar[] | null;
  bars1m?: StructureBar[] | null;
  bars10s?: StructureBar[] | null;
  structureReversal?: StructureReversalInput | null;
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
  const hitEps = Math.max(Math.abs(entry) * 1e-12, 1e-9);
  const cont = Boolean(opts?.continuationSameSide);

  // Critical UNKNOWN HardInv without structural SL → cannot manage
  if (hardInv == null && structDist == null) {
    return {
      exit: true,
      reason: 'BO BLOCK · HardInv/structural SL UNKNOWN · close to safety',
    };
  }

  const sl = structDist ?? hardInv!;

  // 1) Structural invalidation → EXIT
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

  // 2) Hard invalidation → EXIT
  if (fav <= -sl) {
    return { exit: true, reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}` };
  }

  // 3) Thesis failure (regime flip / short dump against side) → EXIT
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

  const regimeThesis = thesisFailureReason(s.open_side, s.regime);
  if (regimeThesis) {
    return { exit: true, reason: regimeThesis };
  }

  const structTarget =
    s.structure_target != null && Number.isFinite(s.structure_target) && s.structure_target > 0
      ? s.structure_target
      : null;

  // 4a) Structure target reached + continuation ended → EXIT (no bars required)
  if (structTarget != null && fav + hitEps >= structTarget && !cont) {
    return {
      exit: true,
      reason: `TargetEnd · UPL ${fav.toFixed(5)} ≥ structure ${structTarget.toFixed(5)} · continuation ended`,
    };
  }

  // 4) Structure reversal exit — CHoCH / HL-LH break / failed continuation
  const revInput: StructureReversalInput | null =
    opts?.structureReversal ??
    (opts?.bars5m && opts.bars5m.length >= 4
      ? {
          side: s.open_side,
          price: mid,
          entry,
          mfe: s.mfe,
          bars5m: opts.bars5m,
          bars1m: opts.bars1m,
          bars10s: opts.bars10s,
          atr,
          tick_size: s.tick_size,
          structure_target: structTarget,
          continuationSameSide: cont,
        }
      : null);

  if (revInput) {
    const rev = detectStructureReversalExit(revInput);
    if (rev.exit) {
      return { exit: true, reason: rev.reason };
    }
  }

  // 5) Opposite tape — only when structure thesis dead (not a scalp on retrace)
  if (opts?.oppositeEntrySignal && !opts?.ignoreMicroOpposite && !cont) {
    const bars = opts?.bars5m ?? revInput?.bars5m ?? [];
    const thesis = bars.length >= 4 ? thesisAlive5m(s.open_side, bars) : { alive: true, detail: '' };
    if (!thesis.alive) {
      return {
        exit: true,
        reason: `OppositeSignal · ${opts.oppositeReason || 'tape flipped'} · ${thesis.detail}`,
      };
    }
  }

  // HOLD — max outcome memory (MFE tracked on session); normal retrace ≠ exit
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
  const cont = Boolean(opts?.continuationSameSide);
  const bars = opts?.bars5m ?? [];
  const thesis =
    bars.length >= 4
      ? thesisAlive5m(s.open_side, bars)
      : { alive: true, detail: 'structure seeding' };
  const contTxt = opts?.continuationReason ? ` · ${opts.continuationReason}` : '';
  const structTxt =
    s.structural_sl != null ? ` · structSL ${s.structural_sl.toFixed(2)}` : '';

  return {
    exit: false,
    reason: '',
    hold: `BO 5m HOLD · UPL ${fav.toFixed(2)} · peak MFE ${s.mfe.toFixed(2)} · 1R ${tp?.toFixed(2) ?? 'UNKNOWN'}${
      s.structure_target != null ? ` · structTgt ${s.structure_target.toFixed(2)}` : ''
    } · HardInv -${sl?.toFixed(2) ?? 'UNKNOWN'}${structTxt} · thesis ${thesis.alive ? 'ALIVE' : 'BREAK'} · ${
      thesis.detail
    }${contTxt}`,
  };
}
