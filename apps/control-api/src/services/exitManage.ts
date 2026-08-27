/**
 * Best Outcome — hybrid:
 * 1) Structure / thesis / HardInv cut losers (anytime).
 * 2) Early BE lock: once MFE ≥ minGreen (~0.35×1R), never give green back to flat/red.
 * 3) After MFE ≥ 1R: soft ATR trail + breakeven floor
 *    Protected = max(0, MFE − K×ATR) with wide K (strong 2.5 / normal 1.5 / weak 1.0).
 * Capital Safety SL is separate (broker). Manual lot_size unchanged.
 *
 * Asymmetry rule: a trade that was green must not be allowed to become a full HardInv red
 * — that was "plus smaller than minus" in live Capital history.
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
 * PeakProtect / trail arms when MFE ≥ 1R (HardInv distance).
 * Earlier arm (was max(1R, ATR)) meant trail almost never engaged before flip exits
 * — winners stayed tiny while losers ran to full HardInv.
 */
export function peakProtectArmThreshold(
  entry: number,
  atr?: number | null,
  meta?: { tick_size?: number | null }
): number | null {
  const oneR = hardInvalidationDistance(entry, atr, meta);
  if (oneR == null || !(oneR > 0)) return null;
  return oneR;
}

/** @deprecated alias — arm threshold is 1R */
export function bestOutcomeMfeFloor(
  entry: number,
  atr?: number | null,
  meta?: { tick_size?: number | null }
): number | null {
  return peakProtectArmThreshold(entry, atr, meta);
}

/** Green enough to lock breakeven — do not give this back to red. */
export function bestOutcomeMinGreen(
  entry: number,
  atr?: number | null,
  meta?: { tick_size?: number | null }
): number | null {
  const oneR = hardInvalidationDistance(entry, atr, meta);
  return oneR == null || !(oneR > 0) ? null : oneR * 0.35;
}

/**
 * Hybrid trail K for ProtectedProfit = max(0, MFE − K×ATR_5m).
 * Wide bands so runners can retrace; not the old tight 0.4–1.0 scalp K.
 * Strong continuation → larger K (more room). Weak/choppy → tighter.
 */
export function peakProtectK(
  regime?: string | null,
  opts?: { continuationSameSide?: boolean; strength?: PeakProtectStrength }
): { k: number; strength: PeakProtectStrength; detail: string } {
  if (opts?.strength) {
    const k =
      opts.strength === 'strong' ? 2.5 : opts.strength === 'weak' ? 1.0 : 1.5;
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
    return { k: 2.5, strength: 'strong', detail: 'K=2.5 (strong continuation)' };
  }
  if (
    r === 'RANGE' ||
    r === 'TRANSITION' ||
    r === 'REVERSAL_CANDIDATE' ||
    r === 'EXPANSION' ||
    r === 'UNKNOWN' ||
    !r
  ) {
    return { k: 1.0, strength: 'weak', detail: 'K=1.0 (weak/choppy)' };
  }
  return { k: 1.5, strength: 'normal', detail: 'K=1.5 (normal)' };
}

/** Soft floor after arm: never trail below breakeven once runner is armed. */
export function hybridProtectedFloor(
  mfe: number,
  atrBuffer: number,
  k: number
): number {
  return Math.max(0, protectedProfitLevel(mfe, atrBuffer, k));
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
  return /HardInvalidation|StructuralInvalidation|ThesisFailure|PeakProtection|PeakTrail|OppositeSignal|TargetEnd|Target \/|StructureReversal|StructureBreak|BO BLOCK/i.test(
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

  // Young trade: mute ONLY soft profit-management (PeakTrail / TargetEnd).
  // Trend-flip exits (ThesisFailure / StructureReversal / Opposite) fire immediately —
  // holding a bad long through a dump for 5m was the "random stuck trade" bug.
  const entryAtMs = s.entry_at ? Date.parse(s.entry_at) : NaN;
  const ageMs =
    Number.isFinite(entryAtMs) && entryAtMs > 0 ? Date.now() - entryAtMs : 0;
  const YOUNG_MS = 5 * 60_000; // soft profit exits wait a full 5 minutes
  const young = ageMs >= 0 && ageMs < YOUNG_MS;

  // Critical UNKNOWN HardInv without structural SL → cannot manage
  if (hardInv == null && structDist == null) {
    // While young, HOLD rather than instant close-to-safety spam (ATR may still seed).
    if (young) {
      return { exit: false, reason: '' };
    }
    return {
      exit: true,
      reason: 'BO BLOCK · HardInv/structural SL UNKNOWN · close to safety',
    };
  }

  const sl = structDist ?? hardInv!;

  // 1) Structural invalidation → EXIT (anytime)
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

  // 2) Hard invalidation → EXIT (anytime)
  if (fav <= -sl) {
    return { exit: true, reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}` };
  }

  // 2b) Early BE lock (anytime, including young): was green enough → never finish red/flat.
  // Fixes live asymmetry where flip exits banked +£0.02 while givebacks ran to −£0.37.
  const minGreen = bestOutcomeMinGreen(entry, atr, meta);
  if (minGreen != null && s.mfe + hitEps >= minGreen && fav <= 0) {
    return {
      exit: true,
      reason: `GivebackBE · was green MFE ${s.mfe.toFixed(5)} ≥ minGreen ${minGreen.toFixed(5)} · now UPL ${fav.toFixed(5)} ≤ 0 · lock BE`,
    };
  }

  // 3) Thesis failure (regime flip / short dump against side) → EXIT anytime
  // Chart case: BUY into dump → TREND_DOWN / short dump must flip immediately, not wait 5m.
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

  // 4) Structure reversal — CHoCH / HL-LH break / dead thesis → EXIT anytime (trend flip)
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
    // While young: only hard structure flips (not TargetEnd scalp / micro flicker)
    if (rev.exit) {
      const isSoftTarget = /^TargetEnd/i.test(rev.reason);
      const isMicroFlicker = /^MicroReversal/i.test(rev.reason);
      if (!(young && (isSoftTarget || isMicroFlicker))) {
        return { exit: true, reason: rev.reason };
      }
    }
  }

  // 5) Opposite tape + no continuation → EXIT anytime (flip without waiting 5m CHoCH)
  if (opts?.oppositeEntrySignal && !opts?.ignoreMicroOpposite && !cont) {
    const bars = opts?.bars5m ?? revInput?.bars5m ?? [];
    const thesis =
      bars.length >= 4 ? thesisAlive5m(s.open_side, bars) : { alive: false, detail: 'no 5m thesis' };
    return {
      exit: true,
      reason: `OppositeSignal · ${opts.oppositeReason || 'tape flipped'} · ${
        thesis.alive ? 'cont ended' : thesis.detail
      }`,
    };
  }

  // Soft profit-management only after young window (anti open→PeakTrail→reentry spam).
  // GivebackBE above already fired anytime — young mute does not override BE lock.
  if (young) {
    return { exit: false, reason: '' };
  }

  // 6) Structure target reached + continuation ended → EXIT
  if (structTarget != null && fav + hitEps >= structTarget && !cont) {
    return {
      exit: true,
      reason: `TargetEnd · UPL ${fav.toFixed(5)} ≥ structure ${structTarget.toFixed(5)} · continuation ended`,
    };
  }

  // 7) Soft hybrid trail — after MFE ≥ 1R. Wide K; floor ≥ 0 (BE lock).
  const armAt = peakProtectArmThreshold(entry, atr, meta);
  const atrBuf = peakProtectAtrBuffer(entry, atr, meta);
  if (armAt != null && atrBuf != null && s.mfe + hitEps >= armAt) {
    const { k, strength, detail } = peakProtectK(s.regime, {
      continuationSameSide: cont,
      strength: opts?.peakProtectStrength,
    });
    const protectedLvl = hybridProtectedFloor(s.mfe, atrBuf, k);
    if (fav + hitEps < protectedLvl) {
      return {
        exit: true,
        reason: `PeakTrail · UPL ${fav.toFixed(5)} < floor ${protectedLvl.toFixed(5)} · MFE ${s.mfe.toFixed(5)} − K×ATR (${detail} · ATR ${atrBuf.toFixed(5)} · arm@${armAt.toFixed(5)} · ${strength} · BE lock)`,
      };
    }
  }

  // HOLD — structure alive + soft trail not breached
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
  const armAt = peakProtectArmThreshold(entry, atr, meta);
  const atrBuf = peakProtectAtrBuffer(entry, atr, meta);
  const minGreen = bestOutcomeMinGreen(entry, atr, meta);
  const { k, strength, detail } = peakProtectK(s.regime, {
    continuationSameSide: cont,
    strength: opts?.peakProtectStrength,
  });
  const armed = armAt != null && atrBuf != null && s.mfe >= armAt;
  const beLocked = minGreen != null && s.mfe >= minGreen;
  const prot = armed ? hybridProtectedFloor(s.mfe, atrBuf!, k) : beLocked ? 0 : null;
  const contTxt = opts?.continuationReason ? ` · ${opts.continuationReason}` : '';
  const structTxt =
    s.structural_sl != null ? ` · structSL ${s.structural_sl.toFixed(2)}` : '';

  return {
    exit: false,
    reason: '',
    hold: `BO hybrid HOLD · UPL ${fav.toFixed(2)} · peak MFE ${s.mfe.toFixed(2)} · 1R ${tp?.toFixed(2) ?? 'UNKNOWN'}${
      s.structure_target != null ? ` · structTgt ${s.structure_target.toFixed(2)}` : ''
    } · HardInv -${sl?.toFixed(2) ?? 'UNKNOWN'}${structTxt} · thesis ${thesis.alive ? 'ALIVE' : 'BREAK'} · ${
      thesis.detail
    } · trail ${
      armed
        ? `ON floor ${prot?.toFixed(2) ?? '—'} (${detail})`
        : beLocked
          ? `BE lock (minGreen ${minGreen?.toFixed(2)}) · full trail@${armAt?.toFixed(2) ?? '?'}`
          : `off until minGreen ${minGreen?.toFixed(2) ?? '?'} / arm@${armAt?.toFixed(2) ?? '?'}`
    } · ${strength}${contTxt}`,
  };
}
