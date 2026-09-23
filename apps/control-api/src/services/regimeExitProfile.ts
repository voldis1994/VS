/**
 * Per-regime exit thesis — mirrors entry intent.
 *
 * Entry is precise (DIP/RALLY + zone + story). Exit must not be one universal
 * Soft/Peak/Target stack: a RANGE fade and a TREND pullback need different
 * targets, Peak arming, and structure invalidation.
 *
 * Abs mults apply AFTER scaleDeskAbs (same % language on every market).
 */
import { normalizeRegime, type RegimeName } from './regimes.js';

export type RegimeExitFamily =
  | 'trend'
  | 'pullback'
  | 'break'
  | 'break_fail'
  | 'expansion'
  | 'fade'
  | 'reversal'
  | 'chop';

/** When PeakProtect may arm (profit trail). */
export type PeakArmMode =
  | 'reverse_1m'
  | 'reverse_or_mid'
  | 'fast';

/**
 * Structure kill beyond Soft pts — uses zone frozen at fill.
 * none: Soft HardInv only
 * back_in_range: BREAKOUT failed (price back inside zone)
 * through_mid: RANGE fade walked through zone mid
 * failed_edge_reclaim: FAILED_BREAKOUT reclaimed the failed edge
 */
export type StructureInvalidation =
  | 'none'
  | 'back_in_range'
  | 'through_mid'
  | 'failed_edge_reclaim';

export type RegimeExitProfile = {
  family: RegimeExitFamily;
  /** Soft HardInv distance multiplier (vs base hardInvStopDistance before RANGE legacy) */
  hardinv_mult: number;
  peak_arm: PeakArmMode;
  /** Peak MFE floor multiplier */
  peak_mfe_mult: number;
  /** Peak min-giveback multiplier */
  peak_giveback_mult: number;
  /** Peak retention override (null = desk calibration) */
  peak_retention: number | null;
  /** Target distance multiplier */
  target_mult: number;
  /** TimeDecay min hold ms */
  timedecay_hold_ms: number;
  /** TimeDecay min-fav multiplier vs REF floor */
  timedecay_min_fav_mult: number;
  structure: StructureInvalidation;
};

const TREND: RegimeExitProfile = {
  family: 'trend',
  hardinv_mult: 1.0,
  peak_arm: 'reverse_1m',
  peak_mfe_mult: 1.0,
  peak_giveback_mult: 1.0,
  peak_retention: null,
  target_mult: 1.15,
  timedecay_hold_ms: 14 * 60_000,
  timedecay_min_fav_mult: 1.0,
  structure: 'none',
};

const PULLBACK: RegimeExitProfile = {
  family: 'pullback',
  hardinv_mult: 0.9,
  peak_arm: 'reverse_1m',
  peak_mfe_mult: 0.9,
  peak_giveback_mult: 0.9,
  peak_retention: null,
  target_mult: 1.05,
  timedecay_hold_ms: 11 * 60_000,
  timedecay_min_fav_mult: 0.95,
  structure: 'none',
};

const BREAKOUT: RegimeExitProfile = {
  family: 'break',
  hardinv_mult: 0.85,
  peak_arm: 'reverse_1m',
  peak_mfe_mult: 1.0,
  peak_giveback_mult: 1.0,
  peak_retention: null,
  target_mult: 1.2,
  timedecay_hold_ms: 12 * 60_000,
  timedecay_min_fav_mult: 1.0,
  structure: 'back_in_range',
};

const FAILED_BREAK: RegimeExitProfile = {
  family: 'break_fail',
  hardinv_mult: 1.0,
  peak_arm: 'reverse_or_mid',
  peak_mfe_mult: 0.7,
  peak_giveback_mult: 0.75,
  peak_retention: 0.7,
  target_mult: 0.55,
  timedecay_hold_ms: 7 * 60_000,
  timedecay_min_fav_mult: 0.65,
  structure: 'failed_edge_reclaim',
};

const RANGE_FADE: RegimeExitProfile = {
  family: 'fade',
  hardinv_mult: 1.15,
  peak_arm: 'reverse_or_mid',
  peak_mfe_mult: 0.7,
  peak_giveback_mult: 0.75,
  peak_retention: 0.7,
  target_mult: 0.55,
  timedecay_hold_ms: 7 * 60_000,
  timedecay_min_fav_mult: 0.65,
  structure: 'through_mid',
};

const EXPANSION: RegimeExitProfile = {
  family: 'expansion',
  hardinv_mult: 1.0,
  peak_arm: 'reverse_1m',
  peak_mfe_mult: 0.85,
  peak_giveback_mult: 0.9,
  peak_retention: null,
  target_mult: 0.95,
  timedecay_hold_ms: 9 * 60_000,
  timedecay_min_fav_mult: 0.85,
  structure: 'none',
};

const REVERSAL: RegimeExitProfile = {
  family: 'reversal',
  hardinv_mult: 0.75,
  peak_arm: 'fast',
  peak_mfe_mult: 0.7,
  peak_giveback_mult: 0.7,
  peak_retention: 0.7,
  target_mult: 0.8,
  timedecay_hold_ms: 5 * 60_000,
  timedecay_min_fav_mult: 0.7,
  structure: 'none',
};

const CHOP: RegimeExitProfile = {
  family: 'chop',
  hardinv_mult: 0.95,
  peak_arm: 'fast',
  peak_mfe_mult: 0.65,
  peak_giveback_mult: 0.7,
  peak_retention: 0.7,
  target_mult: 0.55,
  timedecay_hold_ms: 5 * 60_000,
  timedecay_min_fav_mult: 0.6,
  structure: 'none',
};

const BY_REGIME: Record<RegimeName, RegimeExitProfile> = {
  UNKNOWN: CHOP,
  RANGE: RANGE_FADE,
  TREND_UP: TREND,
  TREND_DOWN: TREND,
  PULLBACK_UPTREND: PULLBACK,
  PULLBACK_DOWNTREND: PULLBACK,
  COMPRESSION: CHOP,
  EXPANSION,
  BREAKOUT_UP: BREAKOUT,
  BREAKOUT_DOWN: BREAKOUT,
  FAILED_BREAKOUT_UP: FAILED_BREAK,
  FAILED_BREAKOUT_DOWN: FAILED_BREAK,
  REVERSAL_CANDIDATE: REVERSAL,
  TRANSITION: CHOP,
};

export function regimeExitProfile(regime?: string | null): RegimeExitProfile {
  return BY_REGIME[normalizeRegime(regime)];
}

export function regimeExitFamily(regime?: string | null): RegimeExitFamily {
  return regimeExitProfile(regime).family;
}

export type ExitZoneSnap = {
  hi: number;
  lo: number;
  mid: number;
  width: number;
};

/**
 * Structure dead — thesis of this regime is broken at the zone.
 * Returns reason string or null.
 */
export function structureInvalidationReason(
  side: 'BUY' | 'SELL',
  mid: number,
  regime: string | null | undefined,
  zone: ExitZoneSnap | null | undefined
): string | null {
  if (!zone || !Number.isFinite(mid)) return null;
  const profile = regimeExitProfile(regime);
  const r = normalizeRegime(regime);
  const { hi, lo, mid: zMid, width } = zone;
  if (!(width > 0) || !(hi > lo)) return null;

  switch (profile.structure) {
    case 'back_in_range': {
      // BREAKOUT_UP BUY dies if price is back under the break level
      if (r === 'BREAKOUT_UP' && side === 'BUY' && mid < hi) {
        return `StructureInvalidation · BREAKOUT_UP back under zone hi ${hi.toFixed(2)}`;
      }
      if (r === 'BREAKOUT_DOWN' && side === 'SELL' && mid > lo) {
        return `StructureInvalidation · BREAKOUT_DOWN back above zone lo ${lo.toFixed(2)}`;
      }
      return null;
    }
    case 'through_mid': {
      // RANGE fade BUY from LO — dead once price holds through mid toward HI
      if (side === 'BUY' && mid > zMid + width * 0.05) {
        return `StructureInvalidation · RANGE fade BUY through mid ${zMid.toFixed(2)}`;
      }
      if (side === 'SELL' && mid < zMid - width * 0.05) {
        return `StructureInvalidation · RANGE fade SELL through mid ${zMid.toFixed(2)}`;
      }
      return null;
    }
    case 'failed_edge_reclaim': {
      // FAILED_BREAKOUT_UP SELL — dead if price reclaims above failed hi
      if (r === 'FAILED_BREAKOUT_UP' && side === 'SELL' && mid > hi) {
        return `StructureInvalidation · FAILED_BREAKOUT_UP reclaim above hi ${hi.toFixed(2)}`;
      }
      // FAILED_BREAKOUT_DOWN BUY — dead if price breaks back under lo
      if (r === 'FAILED_BREAKOUT_DOWN' && side === 'BUY' && mid < lo) {
        return `StructureInvalidation · FAILED_BREAKOUT_DOWN reclaim below lo ${lo.toFixed(2)}`;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Whether PeakProtect should arm on this 1m policy / zone state.
 */
export function shouldArmPeakProtect(opts: {
  regime?: string | null;
  policy: 'continue' | 'reverse' | 'wait';
  side: 'BUY' | 'SELL';
  mid: number;
  zone?: ExitZoneSnap | null;
  mfe: number;
}): boolean {
  const profile = regimeExitProfile(opts.regime);
  if (opts.policy === 'continue') return false;
  if (opts.policy === 'reverse') return true;

  // policy === 'wait'
  if (profile.peak_arm === 'reverse_1m') return false;
  if (profile.peak_arm === 'fast') {
    // Fragile thesis — arm trail once any real MFE exists (doji pause)
    return opts.mfe > 0;
  }
  if (profile.peak_arm === 'reverse_or_mid') {
    const through = structureInvalidationReason(
      opts.side,
      opts.mid,
      opts.regime,
      opts.zone
    );
    // Approaching mid breach on fade → arm Peak early while still green
    return Boolean(through) && opts.mfe > 0;
  }
  return false;
}
