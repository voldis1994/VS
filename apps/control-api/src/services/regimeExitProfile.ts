/**
 * Per-regime exit thesis — mirrors entry intent.
 *
 * Entry is precise (DIP/RALLY + zone + story). Exit must not be one universal
 * Soft/Peak/Target stack: a RANGE fade and a TREND pullback need different
 * targets, Peak arming, and structure invalidation.
 *
 * Abs mults apply AFTER scaleDeskAbs (same % language on every market).
 * Live values come from BrainGenome exit_* family knobs (factory = prior consts).
 */
import { getBrainGenome, type BrainGenome } from '../brainSelfImprove/brainGenome.js';
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
  /** Peak retention override (null = desk/genome Keep) */
  peak_retention: number | null;
  /** Target distance multiplier */
  target_mult: number;
  /** TimeDecay min hold ms */
  timedecay_hold_ms: number;
  /** TimeDecay min-fav multiplier vs REF floor */
  timedecay_min_fav_mult: number;
  structure: StructureInvalidation;
};

/** Genome peak_retention 0 → null (use desk/genome Keep). */
export function peakRetentionFromGenome(raw: number): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function familyProfile(
  family: RegimeExitFamily,
  hardinv_mult: number,
  peak_arm: PeakArmMode,
  peak_mfe_mult: number,
  peak_giveback_mult: number,
  peak_retention_raw: number,
  target_mult: number,
  timedecay_hold_ms: number,
  timedecay_min_fav_mult: number,
  structure: StructureInvalidation
): RegimeExitProfile {
  return {
    family,
    hardinv_mult,
    peak_arm,
    peak_mfe_mult,
    peak_giveback_mult,
    peak_retention: peakRetentionFromGenome(peak_retention_raw),
    target_mult,
    timedecay_hold_ms,
    timedecay_min_fav_mult,
    structure,
  };
}

/** Genome default TimeDecay min hold when a profile leaves hold ms unset. */
export function genomeTimedecayMinHoldMs(g: BrainGenome = getBrainGenome()): number {
  const n = g.timedecay_min_hold_ms;
  return Number.isFinite(n) && n > 0 ? n : 12 * 60_000;
}

/** Build live exit profiles for all families from active BrainGenome. */
export function exitProfilesFromGenome(
  g: BrainGenome = getBrainGenome()
): Record<RegimeExitFamily, RegimeExitProfile> {
  return {
    trend: familyProfile(
      'trend',
      g.exit_trend_hardinv_mult,
      g.exit_trend_peak_arm,
      g.exit_trend_peak_mfe_mult,
      g.exit_trend_peak_giveback_mult,
      g.exit_trend_peak_retention,
      g.exit_trend_target_mult,
      g.exit_trend_timedecay_hold_ms,
      g.exit_trend_timedecay_min_fav_mult,
      g.exit_trend_structure
    ),
    pullback: familyProfile(
      'pullback',
      g.exit_pullback_hardinv_mult,
      g.exit_pullback_peak_arm,
      g.exit_pullback_peak_mfe_mult,
      g.exit_pullback_peak_giveback_mult,
      g.exit_pullback_peak_retention,
      g.exit_pullback_target_mult,
      g.exit_pullback_timedecay_hold_ms,
      g.exit_pullback_timedecay_min_fav_mult,
      g.exit_pullback_structure
    ),
    break: familyProfile(
      'break',
      g.exit_break_hardinv_mult,
      g.exit_break_peak_arm,
      g.exit_break_peak_mfe_mult,
      g.exit_break_peak_giveback_mult,
      g.exit_break_peak_retention,
      g.exit_break_target_mult,
      g.exit_break_timedecay_hold_ms,
      g.exit_break_timedecay_min_fav_mult,
      g.exit_break_structure
    ),
    break_fail: familyProfile(
      'break_fail',
      g.exit_break_fail_hardinv_mult,
      g.exit_break_fail_peak_arm,
      g.exit_break_fail_peak_mfe_mult,
      g.exit_break_fail_peak_giveback_mult,
      g.exit_break_fail_peak_retention,
      g.exit_break_fail_target_mult,
      g.exit_break_fail_timedecay_hold_ms,
      g.exit_break_fail_timedecay_min_fav_mult,
      g.exit_break_fail_structure
    ),
    fade: familyProfile(
      'fade',
      g.exit_fade_hardinv_mult,
      g.exit_fade_peak_arm,
      g.exit_fade_peak_mfe_mult,
      g.exit_fade_peak_giveback_mult,
      g.exit_fade_peak_retention,
      g.exit_fade_target_mult,
      g.exit_fade_timedecay_hold_ms,
      g.exit_fade_timedecay_min_fav_mult,
      g.exit_fade_structure
    ),
    expansion: familyProfile(
      'expansion',
      g.exit_expansion_hardinv_mult,
      g.exit_expansion_peak_arm,
      g.exit_expansion_peak_mfe_mult,
      g.exit_expansion_peak_giveback_mult,
      g.exit_expansion_peak_retention,
      g.exit_expansion_target_mult,
      g.exit_expansion_timedecay_hold_ms,
      g.exit_expansion_timedecay_min_fav_mult,
      g.exit_expansion_structure
    ),
    reversal: familyProfile(
      'reversal',
      g.exit_reversal_hardinv_mult,
      g.exit_reversal_peak_arm,
      g.exit_reversal_peak_mfe_mult,
      g.exit_reversal_peak_giveback_mult,
      g.exit_reversal_peak_retention,
      g.exit_reversal_target_mult,
      g.exit_reversal_timedecay_hold_ms,
      g.exit_reversal_timedecay_min_fav_mult,
      g.exit_reversal_structure
    ),
    chop: familyProfile(
      'chop',
      g.exit_chop_hardinv_mult,
      g.exit_chop_peak_arm,
      g.exit_chop_peak_mfe_mult,
      g.exit_chop_peak_giveback_mult,
      g.exit_chop_peak_retention,
      g.exit_chop_target_mult,
      g.exit_chop_timedecay_hold_ms,
      g.exit_chop_timedecay_min_fav_mult,
      g.exit_chop_structure
    ),
  };
}

/**
 * Regime → exit family mapping (stable; profile numbers come from genome).
 * Kept as BY_REGIME-compatible shape via regimeExitProfile().
 */
export const REGIME_EXIT_FAMILY: Record<RegimeName, RegimeExitFamily> = {
  UNKNOWN: 'chop',
  RANGE: 'fade',
  TREND_UP: 'trend',
  TREND_DOWN: 'trend',
  PULLBACK_UPTREND: 'pullback',
  PULLBACK_DOWNTREND: 'pullback',
  COMPRESSION: 'chop',
  EXPANSION: 'expansion',
  BREAKOUT_UP: 'break',
  BREAKOUT_DOWN: 'break',
  FAILED_BREAKOUT_UP: 'break_fail',
  FAILED_BREAKOUT_DOWN: 'break_fail',
  REVERSAL_CANDIDATE: 'reversal',
  TRANSITION: 'chop',
};

/** Live BY_REGIME table from genome (factory defaults = prior hardcoded consts). */
export function byRegimeExitProfiles(
  g: BrainGenome = getBrainGenome()
): Record<RegimeName, RegimeExitProfile> {
  const fam = exitProfilesFromGenome(g);
  const out = {} as Record<RegimeName, RegimeExitProfile>;
  for (const r of Object.keys(REGIME_EXIT_FAMILY) as RegimeName[]) {
    out[r] = fam[REGIME_EXIT_FAMILY[r]];
  }
  return out;
}

export function regimeExitProfile(regime?: string | null): RegimeExitProfile {
  const family = REGIME_EXIT_FAMILY[normalizeRegime(regime)];
  return exitProfilesFromGenome()[family];
}

export function regimeExitFamily(regime?: string | null): RegimeExitFamily {
  return REGIME_EXIT_FAMILY[normalizeRegime(regime)];
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
  const slack =
    width * Math.max(0, getBrainGenome().exit_range_through_mid_slack || 0.05);

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
      if (side === 'BUY' && mid > zMid + slack) {
        return `StructureInvalidation · RANGE fade BUY through mid ${zMid.toFixed(2)}`;
      }
      if (side === 'SELL' && mid < zMid - slack) {
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
