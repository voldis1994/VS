/** Original spec §13 — all regime names. Regime is a market-state classifier, not an entry. */
import type { TenSecBar } from './tenSecondOhlc.js';
import { bodyPct, rangePct } from './tenSecondOhlc.js';
import { getActiveRegimeBands } from './regimeBands.js';
import { getBrainGenome } from '../brainSelfImprove/brainGenome.js';

export const REGIME_NAMES = [
  'UNKNOWN',
  'RANGE',
  'TREND_UP',
  'TREND_DOWN',
  'PULLBACK_UPTREND',
  'PULLBACK_DOWNTREND',
  'COMPRESSION',
  'EXPANSION',
  'BREAKOUT_UP',
  'BREAKOUT_DOWN',
  'FAILED_BREAKOUT_UP',
  'FAILED_BREAKOUT_DOWN',
  'REVERSAL_CANDIDATE',
  'TRANSITION',
] as const;

export type RegimeName = (typeof REGIME_NAMES)[number];

export const OPERATING_MODES = ['REPLAY', 'PAPER', 'DEMO', 'LIVE'] as const;
export type OperatingModeName = (typeof OPERATING_MODES)[number];

export const TRADE_TYPE_NAMES = ['BUY LONG', 'SELL LONG', 'BUY SCALP', 'SELL SCALP'] as const;
export type TradeTypeName = (typeof TRADE_TYPE_NAMES)[number];

export type TradeStyle = 'LONG' | 'SCALP';

const LONG_REGIMES = new Set<string>([
  'TREND_UP',
  'TREND_DOWN',
  'PULLBACK_UPTREND',
  'PULLBACK_DOWNTREND',
]);

const SCALP_REGIMES = new Set<string>([
  'BREAKOUT_UP',
  'BREAKOUT_DOWN',
  'FAILED_BREAKOUT_UP',
  'FAILED_BREAKOUT_DOWN',
  'COMPRESSION',
  'EXPANSION',
  'RANGE',
  'REVERSAL_CANDIDATE',
  'TRANSITION',
]);

export function isRegimeName(value: string | null | undefined): value is RegimeName {
  const v = String(value || '').toUpperCase();
  return (REGIME_NAMES as readonly string[]).includes(v);
}

export function parseRegimeFromExplanation(text?: string | null): RegimeName | null {
  if (!text) return null;
  const m = String(text).match(/REGIME:\s*\n?\s*([A-Z_]+)/i);
  if (!m) return null;
  const name = m[1]!.toUpperCase();
  return isRegimeName(name) ? name : null;
}

export function normalizeRegime(value: string | null | undefined): RegimeName {
  const v = String(value || '').trim().toUpperCase();
  return isRegimeName(v) ? v : 'UNKNOWN';
}

export function styleFromClassification(
  regime?: string | null,
  setupType?: string | null
): TradeStyle | null {
  const setup = String(setupType || '').trim().toUpperCase();
  if (setup === 'CONTINUATION' || setup === 'PULLBACK') return 'LONG';
  if (setup === 'BREAKOUT' || setup === 'FADE' || setup === 'REVERSAL') return 'SCALP';
  const r = String(regime || '').trim().toUpperCase();
  if (LONG_REGIMES.has(r)) return 'LONG';
  if (SCALP_REGIMES.has(r)) return 'SCALP';
  return null;
}

export type RegimeSnapshot = {
  epic: string;
  display_name: string;
  current: RegimeName;
  previous: RegimeName;
  confidence: number;
  since: string;
  last_update: string;
  last_mid: number | null;
  bar_count: number;
};

type Book = {
  bars: TenSecBar[];
  current: RegimeName;
  previous: RegimeName;
  confidence: number;
  since: string;
  display_name: string;
  last_mid: number | null;
  last_update: string;
  /** Bars spent in current regime (10s each) — dwell / anti-flicker */
  bars_in_current: number;
  /** Candidate waiting for confirmation bars */
  pending: RegimeName | null;
  pending_count: number;
};

const MAX_BARS = 216;
const books = new Map<string, Book>();
/**
 * Structure zone ≈ 30 minutes of 10s bars (180 × 10s) — factory default.
 * Live classify reads getZoneBars() from BrainGenome.zone_bars.
 */
export const ZONE_BARS = 180;
/**
 * Do not trust zone hi/lo / BREAKOUT / RANGE until we have enough history.
 * 90 × 10s = 15m — half zone; thinner books stay UNKNOWN (or sticky prior).
 * Live classify reads getMinBarsForZone() from BrainGenome.min_bars_for_zone.
 */
export const MIN_BARS_FOR_ZONE = 90;

/** Live zone window (10s bars) from BrainGenome — factory = ZONE_BARS. Sanitizer owns range. */
export function getZoneBars(): number {
  return getBrainGenome().zone_bars ?? ZONE_BARS;
}

/** Live min bars before zone classify — factory = MIN_BARS_FOR_ZONE. Sanitizer owns range. */
export function getMinBarsForZone(): number {
  const minNeed = getBrainGenome().min_bars_for_zone ?? MIN_BARS_FOR_ZONE;
  return Math.min(getZoneBars(), minNeed);
}

/** Factory mom length — live path reads BrainGenome via getActiveRegimeBands(). */

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function epicKey(epic: string): string {
  return String(epic || '').trim().toUpperCase();
}

type RegimeFamily = 'UP' | 'DOWN' | 'CHOP' | 'VOL' | 'BRK_UP' | 'BRK_DOWN' | 'REV' | 'UNK';

function regimeFamily(r: RegimeName): RegimeFamily {
  switch (r) {
    case 'TREND_UP':
    case 'PULLBACK_UPTREND':
      return 'UP';
    case 'TREND_DOWN':
    case 'PULLBACK_DOWNTREND':
      return 'DOWN';
    case 'RANGE':
    case 'COMPRESSION':
    case 'TRANSITION':
      return 'CHOP';
    case 'EXPANSION':
      return 'VOL';
    case 'BREAKOUT_UP':
    case 'FAILED_BREAKOUT_UP':
      return 'BRK_UP';
    case 'BREAKOUT_DOWN':
    case 'FAILED_BREAKOUT_DOWN':
      return 'BRK_DOWN';
    case 'REVERSAL_CANDIDATE':
      return 'REV';
    default:
      return 'UNK';
  }
}

/** Hard flips allowed before dwell completes (structure break / violent reverse). */
function isStrongSwitch(from: RegimeName, to: RegimeName): boolean {
  if (from === 'UNKNOWN' || from === 'TRANSITION') return true;
  if (to === 'REVERSAL_CANDIDATE') return true;
  if (to === 'FAILED_BREAKOUT_UP' || to === 'FAILED_BREAKOUT_DOWN') return true;
  if (to === 'BREAKOUT_UP' || to === 'BREAKOUT_DOWN') return true;
  // Chop → trend/pullback must flip at the right moment (Gold grind / selloff).
  // Waiting CONFIRM_BARS left live=RANGE while classify already saw TREND.
  if (
    (from === 'RANGE' || from === 'COMPRESSION') &&
    (to === 'TREND_UP' ||
      to === 'TREND_DOWN' ||
      to === 'PULLBACK_UPTREND' ||
      to === 'PULLBACK_DOWNTREND')
  ) {
    return true;
  }
  const a = regimeFamily(from);
  const b = regimeFamily(to);
  // Opposite trend family
  if ((a === 'UP' || a === 'BRK_UP') && (b === 'DOWN' || b === 'BRK_DOWN')) return true;
  if ((a === 'DOWN' || a === 'BRK_DOWN') && (b === 'UP' || b === 'BRK_UP')) return true;
  return false;
}

/** Structure pierce / fail — may flip even inside the post-switch gap. */
function isStructureFlip(to: RegimeName): boolean {
  return (
    to === 'BREAKOUT_UP' ||
    to === 'BREAKOUT_DOWN' ||
    to === 'FAILED_BREAKOUT_UP' ||
    to === 'FAILED_BREAKOUT_DOWN' ||
    to === 'REVERSAL_CANDIDATE'
  );
}

/**
 * Chop→trend may skip dwell (right moment) even with short bars_in_current.
 * Other strong flips need a short gap so one candle does not walk every regime.
 */
function isChopToTrend(from: RegimeName, to: RegimeName): boolean {
  return (
    (from === 'RANGE' || from === 'COMPRESSION') &&
    (to === 'TREND_UP' ||
      to === 'TREND_DOWN' ||
      to === 'PULLBACK_UPTREND' ||
      to === 'PULLBACK_DOWNTREND')
  );
}

/**
 * Classify from closed 10s OHLC using a 30m structure zone + short momentum.
 * Raw candidate only — live path must run through stabilizeRegime (dwell + confirm).
 * Enter vs stay thresholds keep hysteresis so borderline % ticks do not flip regimes.
 */
export function classifyRegime(bars: TenSecBar[], previous: RegimeName = 'UNKNOWN'): RegimeName {
  if (!bars.length || bars.length < 2) return 'UNKNOWN';

  const genome = getBrainGenome();
  const zoneBars = getZoneBars();
  const minBarsForZone = getMinBarsForZone();

  // Thin book ≠ 30m zone — avoid false RANGE/BREAKOUT on a few SECOND/MINUTE seeds
  if (bars.length < minBarsForZone) {
    if (genome.sticky_prior_enabled !== false) {
      if (previous !== 'UNKNOWN' && previous !== 'TRANSITION') return previous;
    }
    return genome.transition_detect_enabled ? 'TRANSITION' : 'UNKNOWN';
  }

  const {
    MOVE,
    TREND_STAY,
    TREND_ENTER,
    PULLBACK,
    REVERSAL,
    COMPRESS_ABS,
    EXPAND_ABS,
    COMPRESS_AVG_MULT,
    EXPAND_AVG_MULT,
    NEAR_ZONE_MID,
    CLEAR_BREAK_FRAC,
    PERSIST_ENTER,
    PERSIST_STAY,
    PERSIST_PULLBACK,
    MOM_BARS,
    PERSIST_WINDOW,
    RANGE_CHOP_PERSIST_MAX,
    RANGE_CHOP_TREK_SHARE_MAX,
    RANGE_CHOP_TREK_EFF_MAX,
  } = getActiveRegimeBands();

  const zone = bars.slice(-zoneBars);
  const mom = bars.slice(-MOM_BARS);
  const last = mom[mom.length - 1]!;
  const zonePrior = zone.slice(0, -1);
  const momPrior = mom.slice(0, -1);
  if (!zonePrior.length || !momPrior.length) return 'UNKNOWN';

  const velocities = mom.map(bodyPct);
  const ranges = mom.map(rangePct);
  const priorRanges = momPrior.map(rangePct);
  const avgRange = Math.max(mean(priorRanges.length ? priorRanges : ranges), 1e-9);
  const lastVel = bodyPct(last);
  const lastRange = rangePct(last);
  const persistWindow = velocities.slice(-PERSIST_WINDOW);
  const persistence = mean(
    persistWindow.map((v) => (v > MOVE ? 1 : v < -MOVE ? -1 : 0))
  );

  const inUpFamily = previous === 'TREND_UP' || previous === 'PULLBACK_UPTREND';
  const inDownFamily = previous === 'TREND_DOWN' || previous === 'PULLBACK_DOWNTREND';
  // Hysteresis: already-in-trend stays on TREND_STAY; fresh enter needs TREND_ENTER (> stay)
  const trendingUp = inUpFamily
    ? persistence > PERSIST_STAY && lastVel > TREND_STAY
    : persistence > PERSIST_ENTER && lastVel > TREND_ENTER;
  const trendingDown = inDownFamily
    ? persistence < -PERSIST_STAY && lastVel < -TREND_STAY
    : persistence < -PERSIST_ENTER && lastVel < -TREND_ENTER;
  const compressed =
    lastRange < avgRange * COMPRESS_AVG_MULT && lastRange < COMPRESS_ABS;
  const expanding =
    lastRange > avgRange * EXPAND_AVG_MULT && lastRange >= EXPAND_ABS;

  // Zone highs/lows — multi-minute structure, not last micro-candle chop
  const hi = Math.max(...zonePrior.map((b) => b.high));
  const lo = Math.min(...zonePrior.map((b) => b.low));
  const zoneMid = (hi + lo) / 2;
  const zoneWidth = Math.max(hi - lo, 1e-9);
  const inRange = last.close <= hi && last.close >= lo;
  const nearZoneMid = Math.abs(last.close - zoneMid) / zoneWidth < NEAR_ZONE_MID;
  const breakoutUp = last.close > hi;
  const breakoutDown = last.close < lo;
  /** Quiet pierce of a chop zone — not a continuation of an existing trend */
  const fromChop =
    previous === 'RANGE' ||
    previous === 'COMPRESSION' ||
    previous === 'TRANSITION' ||
    previous === 'UNKNOWN' ||
    previous === 'EXPANSION' ||
    previous === 'REVERSAL_CANDIDATE';
  const clearBreakUp =
    fromChop && breakoutUp && (last.close - hi) / zoneWidth >= CLEAR_BREAK_FRAC;
  const clearBreakDown =
    fromChop && breakoutDown && (lo - last.close) / zoneWidth >= CLEAR_BREAK_FRAC;

  // Local consolidation break (last ~10m), independent of full 30m box.
  // Gold 17:45: dump pierced 4149–4154 shelf while still "inRange" of the wider
  // 30m zone that already contained the earlier 4160→… selloff → false RANGE.
  const lbMax = genome.local_breakout_lookback_max ?? 60;
  const lbMin = genome.local_breakout_lookback_min ?? 18;
  const lbSkip = genome.local_breakout_skip_bars ?? 6;
  const lbMinStruct = genome.local_breakout_min_struct_bars ?? 12;
  const lbClearMult = genome.local_breakout_clear_frac_mult ?? 0.5;
  const localLookback = Math.min(lbMax, Math.max(lbMin, zonePrior.length - lbSkip));
  const localStruct = zonePrior.slice(0, -lbSkip).slice(-localLookback);
  let localBreakUp = false;
  let localBreakDown = false;
  if (localStruct.length >= lbMinStruct) {
    const lHi = Math.max(...localStruct.map((b) => b.high));
    const lLo = Math.min(...localStruct.map((b) => b.low));
    const lW = Math.max(lHi - lLo, 1e-9);
    const localFrac = Math.max(
      genome.local_breakout_frac_floor ?? 0.12,
      CLEAR_BREAK_FRAC * lbClearMult
    );
    localBreakUp =
      fromChop && last.close > lHi && (last.close - lHi) / lW >= localFrac;
    localBreakDown =
      fromChop && last.close < lLo && (lLo - last.close) / lW >= localFrac;
  }

  // V-flip: TREND prior, or BREAKOUT prior when genome allows (dump pierce → violent reclaim)
  const revFromBreak = genome.reversal_from_breakout_prior !== false;
  const rallyPrior =
    previous === 'TREND_UP' || (revFromBreak && previous === 'BREAKOUT_UP');
  const dumpPrior =
    previous === 'TREND_DOWN' || (revFromBreak && previous === 'BREAKOUT_DOWN');
  const reversal =
    (rallyPrior &&
      lastVel < -REVERSAL &&
      lastRange > avgRange &&
      !breakoutDown) ||
    (dumpPrior &&
      lastVel > REVERSAL &&
      lastRange > avgRange &&
      !breakoutUp);

  if (previous === 'BREAKOUT_UP' && inRange && lastVel < -MOVE) return 'FAILED_BREAKOUT_UP';
  if (previous === 'BREAKOUT_DOWN' && inRange && lastVel > MOVE) return 'FAILED_BREAKOUT_DOWN';
  // Expansion OR clear pierce out of chop — body must clear TREND_ENTER
  if ((expanding || clearBreakUp) && breakoutUp && (trendingUp || lastVel > TREND_ENTER))
    return 'BREAKOUT_UP';
  if (
    (expanding || clearBreakDown) &&
    breakoutDown &&
    (trendingDown || lastVel < -TREND_ENTER)
  )
    return 'BREAKOUT_DOWN';

  // Local shelf pierce while STILL inside the wider 30m box (Gold 17:45).
  // Without this, dump through a 10m shelf stays "RANGE" because zone.lo already
  // includes the earlier selloff. Require expanding + enter-band body.
  if (
    inRange &&
    fromChop &&
    localBreakUp &&
    expanding &&
    lastVel > TREND_ENTER
  ) {
    return 'BREAKOUT_UP';
  }
  if (
    inRange &&
    fromChop &&
    localBreakDown &&
    expanding &&
    lastVel < -TREND_ENTER
  ) {
    return 'BREAKOUT_DOWN';
  }

  // Violent in-range flip (≥ REVERSAL) before soft pullback / bare EXPANSION
  if (reversal) return 'REVERSAL_CANDIDATE';

  // Pullbacks: against-body ≥ PULLBACK (> TREND_ENTER) so soft noise ≠ pullback
  if (
    previous === 'TREND_UP' &&
    lastVel <= -PULLBACK &&
    persistence > PERSIST_PULLBACK &&
    inRange
  ) {
    return 'PULLBACK_UPTREND';
  }
  if (
    previous === 'TREND_DOWN' &&
    lastVel >= PULLBACK &&
    persistence < -PERSIST_PULLBACK &&
    inRange
  ) {
    return 'PULLBACK_DOWNTREND';
  }
  // Resume trend from pullback only on enter-band strength
  if (
    previous === 'PULLBACK_UPTREND' &&
    persistence > PERSIST_ENTER &&
    lastVel > TREND_ENTER
  )
    return 'TREND_UP';
  if (
    previous === 'PULLBACK_DOWNTREND' &&
    persistence < -PERSIST_ENTER &&
    lastVel < -TREND_ENTER
  )
    return 'TREND_DOWN';

  if (expanding) {
    if (!genome.expansion_before_trend) {
      if (trendingUp) return 'TREND_UP';
      if (trendingDown) return 'TREND_DOWN';
    }
    return 'EXPANSION';
  }

  if (trendingUp) return 'TREND_UP';
  if (trendingDown) return 'TREND_DOWN';

  // Zone trek — multi-minute directional grind (Gold HH/HL rally).
  // Quiet 10s tips stay inside the rolling hi/lo box → old code always fell
  // through to RANGE even when 30m↑15m↑5m↑ and the zone itself walked up.
  // Use early vs late thirds + path efficiency so sideways oscillation ≠ trend.
  //
  // V-recovery (dump then sharp rally): early→late NET is small while PATH is
  // huge → efficiency fails and we wrongly stayed RANGE (Capital Gold 16:05).
  // Also score the *recent leg* (late vs mid third) so the recovery counts.
  const third = Math.max(1, Math.floor(zonePrior.length / 3));
  const earlyMean = mean(zonePrior.slice(0, third).map((b) => b.close));
  const midMean = mean(zonePrior.slice(third, third * 2).map((b) => b.close));
  const lateMean = mean(zonePrior.slice(-third).map((b) => b.close));
  const zoneTrekPts = lateMean - earlyMean;
  const recentLegPts = lateMean - midMean;
  const zoneTrekRef = Math.max(Math.abs(earlyMean), Math.abs(zoneMid), 1e-9);
  const zoneTrek = zoneTrekPts / zoneTrekRef;
  const recentLeg = recentLegPts / zoneTrekRef;
  let zonePath = 0;
  for (let i = 1; i < zonePrior.length; i++) {
    zonePath += Math.abs(zonePrior[i]!.close - zonePrior[i - 1]!.close);
  }
  const trekEfficiency = zonePath > 1e-9 ? Math.abs(zoneTrekPts) / zonePath : 0;
  const trekShare = Math.abs(zoneTrekPts) / zoneWidth;
  const recentShare = Math.abs(recentLegPts) / zoneWidth;
  const trekFullMult = genome.trek_full_enter_mult ?? 4;
  const trekShareMin = genome.trek_share_min ?? 0.35;
  const trekEffMin = genome.trek_eff_min ?? 0.4;
  const trekRecentMult = genome.trek_recent_enter_mult ?? 2;
  const trekRecentShareMin = genome.trek_recent_share_min ?? 0.25;
  const fullTrekOk =
    Math.abs(zoneTrek) >= TREND_ENTER * trekFullMult &&
    trekShare >= trekShareMin &&
    trekEfficiency >= trekEffMin;
  // Recent leg: after a V, mid sits near the low and late has climbed.
  // Use a softer abs gate (×2 not ×4) — Gold recovery legs are often 3–5pt
  // inside a 10–15pt dump/rally box, which fails the full-trek ×4 floor.
  const recentLegOk =
    Math.abs(recentLeg) >= TREND_ENTER * trekRecentMult &&
    recentShare >= trekRecentShareMin;
  // Late-window efficiency: side oscillation after V has path ≫ net → not a trek.
  // Without this, mid=dump-low + late=box-mid keeps inventing TREND_UP for hours.
  let latePath = 0;
  const lateSlice = zonePrior.slice(-third);
  for (let i = 1; i < lateSlice.length; i++) {
    latePath += Math.abs(lateSlice[i]!.close - lateSlice[i - 1]!.close);
  }
  const lateNet =
    lateSlice.length >= 2
      ? lateSlice[lateSlice.length - 1]!.close - lateSlice[0]!.close
      : 0;
  const lateEff = latePath > 1e-9 ? Math.abs(lateNet) / latePath : 0;
  // Late third is chop when path ≫ net — mid→late NET after a dump is NOT a trek
  // (Capital Gold 08:00 dump → 09:00–11:19 side box still looked like TREND_UP).
  const lateChop = latePath > 1e-9 && lateEff < trekEffMin;
  const recentLegIsDirectional = recentLegOk && !lateChop;
  const trekDirPts = recentLegIsDirectional
    ? recentLegPts
    : fullTrekOk
      ? zoneTrekPts
      : 0;

  const absPersist = Math.abs(persistence);
  const chopPersist = absPersist <= RANGE_CHOP_PERSIST_MAX;
  const chopTrek =
    trekShare <= RANGE_CHOP_TREK_SHARE_MAX &&
    recentShare <= RANGE_CHOP_TREK_SHARE_MAX &&
    trekEfficiency <= RANGE_CHOP_TREK_EFF_MAX;
  const quietTip = !expanding && Math.abs(lastVel) < TREND_ENTER;
  const quietMid = nearZoneMid && quietTip;

  // Compression before late-chop RANGE — ultra-tight squeeze must not fall to RANGE
  if (compressed && inRange && nearZoneMid) return 'COMPRESSION';

  // Proven late-window chop beats soft recent-leg TREND (and sticky TREND prior).
  // Do NOT early-return on full-zone chopTrek alone — V-recovery has low trekEff
  // while the late leg is still directional (must remain TREND_UP).
  if (inRange && chopPersist && lateChop && quietTip) return 'RANGE';

  const softMovePullback = genome.soft_move_trek_pullback_shortcut !== false;
  if (
    inRange &&
    (fullTrekOk || recentLegIsDirectional) &&
    trekDirPts !== 0
  ) {
    if (trekDirPts > 0) {
      // Soft tip against the trek → pullback in uptrend (1m↓ while HTF↑)
      if (
        lastVel <= -PULLBACK ||
        (softMovePullback && lastVel < -MOVE && last.close < zoneMid)
      ) {
        return 'PULLBACK_UPTREND';
      }
      return 'TREND_UP';
    }
    if (trekDirPts < 0) {
      if (
        lastVel >= PULLBACK ||
        (softMovePullback && lastVel > MOVE && last.close > zoneMid)
      ) {
        return 'PULLBACK_DOWNTREND';
      }
      return 'TREND_DOWN';
    }
  }

  // Positive RANGE — proven chop inside the box. NOT "inRange ⇒ RANGE".
  // Violent spike/dump that still sits in a wide 30m hi/lo must NOT become fade.
  // Genome: regime_range_chop_persist_max / trek_share_max / trek_eff_max.
  // Cold-start: quiet mid + chop trek may enter RANGE even when micro-bodies
  // above MOVE nudge |persistence| slightly over the chop max (Gold 0.35pt sine).
  if (inRange && chopPersist && (chopTrek || quietMid)) return 'RANGE';
  if (inRange && quietMid && chopTrek && previous === 'UNKNOWN') return 'RANGE';

  // Sticky prior instead of inventing RANGE / dead TRANSITION
  if (genome.sticky_prior_enabled !== false) {
    if (previous !== 'UNKNOWN' && previous !== 'TRANSITION') return previous;
  }
  return genome.transition_detect_enabled ? 'TRANSITION' : 'UNKNOWN';
}

/**
 * Anti-flicker without freeze:
 * - Soft noise before dwell stays on current regime
 * - Pending candidate is NOT cleared on reject (so confirm survives dwell)
 * - After dwell, 2 agreeing bars switch; same-family / strong = 1 bar after dwell
 * - Strong (opposite family / breakout) may switch before dwell completes
 * - Same-family (TREND↔PULLBACK) no longer bypasses dwell — that caused 10s recipe flicker
 * - Post-switch gap (2×10s): no rapid chain of regimes on consecutive bars
 *   (except structure BREAKOUT/FAILED and first chop→trend)
 */
export function stabilizeRegime(
  book: {
    current: RegimeName;
    previous: RegimeName;
    bars_in_current: number;
    pending: RegimeName | null;
    pending_count: number;
    since: string;
  },
  candidate: RegimeName,
  nowIso = new Date().toISOString()
): RegimeName {
  if (candidate === book.current) {
    book.bars_in_current += 1;
    book.pending = null;
    book.pending_count = 0;
    return book.current;
  }

  // Always accumulate the pending candidate (even during dwell)
  if (book.pending === candidate) book.pending_count += 1;
  else {
    book.pending = candidate;
    book.pending_count = 1;
  }

  const sameFamily = regimeFamily(candidate) === regimeFamily(book.current);
  const strong = isStrongSwitch(book.current, candidate);
  const chopToTrend = isChopToTrend(book.current, candidate);
  const genome = getBrainGenome();
  const { MIN_DWELL_BARS, CONFIRM_BARS } = getActiveRegimeBands();
  /** ≥N×10s between flips — stops “viena svece visi režīmi” chains */
  const SWITCH_GAP_BARS = Math.max(1, genome.switch_gap_bars ?? 2);
  const dwellOk =
    book.current === 'UNKNOWN' || book.bars_in_current >= MIN_DWELL_BARS;
  // Chop→trend / same-family / strong: Genome confirm bars (not hardcoded 1)
  const sameFamilyNeed = genome.regime_same_family_confirm_bars ?? 1;
  const need = chopToTrend
    ? genome.chop_to_trend_confirm_bars ?? 1
    : sameFamily || strong
      ? sameFamilyNeed
      : CONFIRM_BARS;
  // sameFamily must still wait for dwell — only strong structure breaks skip it
  const spacingOk =
    book.current === 'UNKNOWN' ||
    book.current === 'TRANSITION' ||
    book.bars_in_current >= SWITCH_GAP_BARS ||
    isStructureFlip(candidate) ||
    chopToTrend;
  const canSwitch =
    (dwellOk || strong) && book.pending_count >= need && spacingOk;

  if (canSwitch) {
    book.previous = book.current;
    book.current = candidate;
    book.bars_in_current = 1;
    book.pending = null;
    book.pending_count = 0;
    book.since = nowIso;
    return book.current;
  }

  book.bars_in_current += 1;
  return book.current;
}

/**
 * Book storage key.
 * - Unscoped (`GOLD`) — optional market aggregate / pipeline stamp
 * - Scoped (`a12::GOLD`) — per broker account so multi-client same epic never mixes
 */
export function regimeBookKey(epic: string, accountId?: number | string | null): string {
  const e = epicKey(epic);
  if (accountId === undefined || accountId === null || accountId === '') return e;
  const n = Number(accountId);
  if (Number.isFinite(n) && n > 0) return `a${n}::${e}`;
  return `${String(accountId).trim()}::${e}`;
}

function confidenceFrom(bars: TenSecBar[], regime: RegimeName): number {
  if (regime === 'UNKNOWN' || bars.length < 2) return 0;
  const last = bars[bars.length - 1]!;
  const { MOVE, MOVE_RANGE } = getActiveRegimeBands();
  const g = getBrainGenome();
  // Scale to shared MOVE ladder — old fixed 0.08%/0.10% made strength look dead vs soft 10s move
  // Sanitizer owns moveDiv (2–10) — no consumer Math.max floor
  const moveDiv = g.regime_conf_move_div ?? 4;
  const strength = Math.min(
    1,
    Math.abs(bodyPct(last)) / (MOVE * moveDiv) + rangePct(last) / (MOVE_RANGE * moveDiv)
  );
  const base = g.regime_conf_base ?? 0.35;
  const scale = g.regime_conf_strength_scale ?? 0.5;
  const lo = g.regime_conf_min ?? 0.2;
  const hi = g.regime_conf_max ?? 0.95;
  return Math.max(lo, Math.min(hi, base + strength * scale));
}

function toSnapshot(epic: string, b: Book): RegimeSnapshot {
  return {
    epic,
    display_name: b.display_name || epic,
    current: b.current,
    previous: b.previous,
    confidence: b.confidence,
    since: b.since,
    last_update: b.last_update,
    last_mid: b.last_mid,
    bar_count: b.bars.length,
  };
}

function ensureBook(
  epic: string,
  displayName?: string,
  accountId?: number | string | null
): Book {
  const key = regimeBookKey(epic, accountId);
  let b = books.get(key);
  if (!b) {
    const now = new Date().toISOString();
    b = {
      bars: [],
      current: 'UNKNOWN',
      previous: 'UNKNOWN',
      confidence: 0,
      since: now,
      display_name: displayName || epic,
      last_mid: null,
      last_update: now,
      bars_in_current: 0,
      pending: null,
      pending_count: 0,
    };
    books.set(key, b);
  } else if (displayName) {
    b.display_name = displayName;
  }
  return b;
}

function applyClassify(epic: string, b: Book): RegimeSnapshot {
  const candidate = classifyRegime(b.bars, b.current);
  const now = new Date().toISOString();
  stabilizeRegime(b, candidate, now);
  b.confidence = confidenceFrom(b.bars, b.current);
  b.last_update = now;
  if (b.bars.length) b.last_mid = b.bars[b.bars.length - 1]!.close;
  return toSnapshot(epicKey(epic), b);
}

export function observeClosedBars(
  epic: string,
  bars: TenSecBar[],
  displayName?: string,
  accountId?: number | string | null
): RegimeSnapshot {
  const b = ensureBook(epic, displayName, accountId);
  let snap: RegimeSnapshot | null = null;
  for (const bar of bars) {
    if (!bar || !Number.isFinite(bar.close)) continue;
    const last = b.bars[b.bars.length - 1];
    // Dedupe by bucket time — flat OHLC still counts toward the 30m zone
    if (last && last.open_time_ms === bar.open_time_ms) continue;
    b.bars.push(bar);
    if (b.bars.length > MAX_BARS) b.bars.splice(0, b.bars.length - MAX_BARS);
    // Per-bar stabilize — batch classify once would skip dwell/confirm accumulation
    snap = applyClassify(epic, b);
  }
  return snap ?? toSnapshot(epicKey(epic), b);
}

/**
 * Pipeline stamp:
 * - Unscoped (market board): show pipeline regime for display
 * - Account-scoped (robot desk books): advisory pending only — NEVER switch.
 *   Robot OHLC observeClosedBars owns sticky dwell/confirm; strong flips here
 *   were wiping TREND_UP → TREND_DOWN on a single intent stamp.
 */
export function notePipelineRegime(
  epic: string,
  regime: string | null | undefined,
  displayName?: string,
  accountId?: number | string | null
): RegimeSnapshot {
  const b = ensureBook(epic, displayName, accountId);
  const next = normalizeRegime(regime);
  const now = new Date().toISOString();
  const scoped =
    accountId !== undefined && accountId !== null && String(accountId).trim() !== '';

  if (scoped) {
    // Account-scoped: display/confidence only — never touch pending_count.
    // Fanout stamps must not soft-confirm a stabilize flip on the next OHLC bar.
    if (next !== 'UNKNOWN') {
      const floor = getBrainGenome().book_confidence_floor_after_switch ?? 0.55;
      b.confidence = Math.max(b.confidence, floor);
    }
  } else if (next !== b.current) {
    b.previous = b.current;
    b.current = next;
    b.since = now;
    b.bars_in_current = 1;
    b.pending = null;
    b.pending_count = 0;
  } else {
    b.bars_in_current += 1;
  }
  b.last_update = now;
  if (!scoped && next !== 'UNKNOWN') {
    const floor = getBrainGenome().book_confidence_floor_after_switch ?? 0.55;
    b.confidence = Math.max(b.confidence, floor);
  }
  return toSnapshot(epicKey(epic), b);
}

export function currentRegime(
  epic: string | null | undefined,
  accountId?: number | string | null
): RegimeSnapshot | null {
  if (!epic) return null;
  const b = books.get(regimeBookKey(epic, accountId));
  if (!b) return null;
  return toSnapshot(epicKey(epic), b);
}

export function listRegimeSnapshots(): RegimeSnapshot[] {
  // Market board: unscoped books only (no a{id}:: prefix)
  return [...books.entries()]
    .filter(([k]) => !k.includes('::'))
    .map(([epic, b]) => toSnapshot(epic, b));
}

export function regimeCatalog() {
  return REGIME_NAMES.map((name) => ({
    name,
    kind: styleFromClassification(name) || 'NONE',
  }));
}

/** Test helper */
export function resetRegimeBook(): void {
  books.clear();
}

/** Clear one account-scoped book before replacing a thin live zone with MINUTE seed. */
export function clearRegimeBookFor(
  epic: string,
  accountId?: number | string | null
): void {
  const key = regimeBookKey(epic, accountId);
  books.delete(key);
}
