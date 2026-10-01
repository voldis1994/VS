/**
 * Structure entry — 10s trigger aligned to 1m chart + 30m zone.
 *
 * Design goals (executable on live Gold):
 * - Zone hi/lo from the 10s book; **pos from the entry 10s close** (not a stale book tip).
 * - 1m = aggregate of the same 10s bars (what you see on Capital 1m).
 * - Soft gates: block only clear chase / wrong-edge fades — never AND-stack
 *   conditions that almost never fire together on quiet 10s Gold.
 * - Explicit rule per regime (all 14).
 */
import { decideEntryFrom10sRegime, type RegimeEntry } from './entryFromRegime.js';
import { getActiveRegimeBands } from './regimeBands.js';
import {
  getMinBarsForZone,
  getZoneBars,
  normalizeRegime,
  type RegimeName,
} from './regimes.js';
import { bodyPct, isMoving10s, type TenSecBar } from './tenSecondOhlc.js';
import { readMarketStory, scalpStoryConfirms } from './marketStory.js';
import { entryStructureEnabled } from './tradeOpenPolicy.js';
import { entryLearnerChoose, type EntryFeatures } from './entryLearner.js';
import { thinkEntryLikeTrader } from './traderMind.js';
import type { MarketStory } from './marketStory.js';
import {
  pickEntryPlaybook,
  setupAllowedOnLane,
  type EffectiveRegimeHtf,
  type TfBiasDir,
} from './entryPlaybook.js';
import { getBrainGenome } from '../brainSelfImprove/brainGenome.js';

export type { EffectiveRegimeHtf, TfBiasDir } from './entryPlaybook.js';
export { capitalHtfBias, pickEntryPlaybook, setupAllowedOnLane } from './entryPlaybook.js';

/**
 * Canonical entry thesis regime — one playbook result for UI / entry / exit / learn.
 * Factory one-market: thesis follows live classify (+ BREAK pierce / sticky demote).
 */
export function effectiveEntryRegime(
  regime: RegimeName | string | null | undefined,
  story: Pick<MarketStory, 'allow' | 'chapter'> | null | undefined,
  htf?: EffectiveRegimeHtf | null
): RegimeName {
  return pickEntryPlaybook({ liveRegime: regime, story, htf }).regime;
}

const LIVE_CHOP = new Set<RegimeName>(['RANGE', 'COMPRESSION', 'TRANSITION']);

/**
 * Tip-chase knife — genome owns scope + thresholds (exhaust_* / entry_tip_* / struct_extreme_*).
 * Independent of L0 — thesis safety. BREAKOUT lane still may pierce.
 */
export function tipChaseBlocksEntry(input: {
  /** Raw classify (not thesis) — false-RANGE promote tip knife */
  liveRegime: RegimeName;
  lane: string;
  chapter: string;
  side: 'BUY' | 'SELL';
  zpos: number | null | undefined;
  barSign: -1 | 0 | 1;
}): boolean {
  const g = getBrainGenome();
  const ch = String(input.chapter || '').toUpperCase();
  const { extremeHi, extremeLo } = structKnobs();
  const tipHi = g.exhaust_pos_hi || 0.8;
  const tipLo = g.exhaust_pos_lo || 0.2;
  const exhaustTipBlock = g.exhaust_tip_chase_block !== false;
  const lane = input.lane;
  const live = input.liveRegime;
  const tipChaseTrend = g.entry_tip_chase_trend_pullback !== false;
  const applies =
    lane === 'RANGE_FADE' ||
    (tipChaseTrend && lane === 'TREND_PULLBACK') ||
    (LIVE_CHOP.has(live) && lane === 'LIVE');
  if (!applies) return false;
  if (lane === 'RANGE_FADE' && (ch === 'BREAK_UP' || ch === 'BREAK_DOWN')) return true;
  if (exhaustTipBlock) {
    if (ch === 'EXHAUST_HI' && input.side === 'BUY') return true;
    if (ch === 'EXHAUST_LO' && input.side === 'SELL') return true;
    if (ch === 'EXHAUST_HI' && input.side === 'SELL' && input.barSign > 0) return true;
    if (ch === 'EXHAUST_LO' && input.side === 'BUY' && input.barSign < 0) return true;
  }
  const zpos = input.zpos;
  if (ch === 'RALLY' && input.side === 'BUY' && zpos != null && zpos >= tipHi) return true;
  if (ch === 'SELLOFF' && input.side === 'SELL' && zpos != null && zpos <= tipLo) return true;
  if (
    zpos != null &&
    ((input.side === 'SELL' && zpos >= extremeHi && input.barSign > 0) ||
      (input.side === 'BUY' && zpos <= extremeLo && input.barSign < 0))
  ) {
    return true;
  }
  // Finished-move tip (BUY@HI / SELL@LO) — genome entry_tip_block_finished_move
  if (
    g.entry_tip_block_finished_move !== false &&
    zpos != null &&
    ((input.side === 'BUY' && zpos >= tipHi) || (input.side === 'SELL' && zpos <= tipLo))
  ) {
    return true;
  }
  if (
    lane === 'RANGE_FADE' &&
    (ch === 'RANGE_CHOP' || ch === 'MIXED' || !ch) &&
    zpos != null &&
    ((input.side === 'BUY' && zpos >= extremeHi && input.barSign > 0) ||
      (input.side === 'SELL' && zpos <= extremeLo && input.barSign < 0))
  ) {
    return true;
  }
  return false;
}

/**
 * Post-impulse tip block — do not arm when the recent leg already ran to the tip
 * (Capital Gold: dump then V → BUY at highs = "tirgo kad kustība beigusies").
 * Genome: entry_block_post_impulse_tip / entry_post_impulse_share_min.
 * BREAKOUT lane exempt (pierce owns); Peak/HardInv untouched.
 */
export function postImpulseTipBlocksEntry(input: {
  closedBars: TenSecBar[];
  side: 'BUY' | 'SELL';
  zpos: number | null | undefined;
  lane: string;
  barSign: -1 | 0 | 1;
}): boolean {
  const g = getBrainGenome();
  if (g.entry_block_post_impulse_tip === false) return false;
  const exempt = g.entry_post_impulse_exempt_lanes?.length
    ? g.entry_post_impulse_exempt_lanes
    : ['BREAKOUT', 'REVERSAL'];
  if (exempt.includes(input.lane)) return false;
  const zpos = input.zpos;
  if (zpos == null || !input.closedBars.length) return false;

  const tipHi = g.exhaust_pos_hi || 0.8;
  const tipLo = g.exhaust_pos_lo || 0.2;
  const shareMin = g.entry_post_impulse_share_min || 0.22;
  const minBars = g.entry_post_impulse_min_bars || 12;
  const zoneBars = getZoneBars();
  const zone = input.closedBars.slice(-zoneBars);
  const zonePrior = zone.length >= 3 ? zone.slice(0, -1) : zone;
  if (zonePrior.length < minBars) return false;

  const hi = Math.max(...zonePrior.map((b) => b.high));
  const lo = Math.min(...zonePrior.map((b) => b.low));
  const zoneWidth = Math.max(hi - lo, 1e-9);
  const third = Math.max(1, Math.floor(zonePrior.length / 3));
  // Endpoints (not means) — V-recovery mid≈late mean would miss the finished leg
  const midEnd = zonePrior[Math.min(third * 2, zonePrior.length) - 1]!.close;
  const lateEnd = zonePrior[zonePrior.length - 1]!.close;
  const recentLegPts = lateEnd - midEnd;
  const recentShare = Math.abs(recentLegPts) / zoneWidth;
  if (recentShare < shareMin) return false;

  // Late path efficiency — side oscillation after V still has mid→late NET
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
  const lateChop = latePath > 1e-9 && lateEff < (g.trek_eff_min || 0.4);

  // Up-leg into HI tip → block BUY (chase finished rally / V top)
  if (recentLegPts > 0 && zpos >= tipHi && input.side === 'BUY') return true;
  // Down-leg into LO tip → block SELL (chase finished dump)
  if (recentLegPts < 0 && zpos <= tipLo && input.side === 'SELL') return true;
  // Same tip, fade without reject bar (still printing with the finished leg)
  if (
    recentLegPts > 0 &&
    zpos >= tipHi &&
    input.side === 'SELL' &&
    input.barSign > 0 &&
    !lateChop
  ) {
    return true;
  }
  if (
    recentLegPts < 0 &&
    zpos <= tipLo &&
    input.side === 'BUY' &&
    input.barSign < 0 &&
    !lateChop
  ) {
    return true;
  }
  return false;
}

export type ZoneBand = 'LO' | 'MID_LO' | 'MID' | 'MID_HI' | 'HI';

export type ZoneGeometry = {
  hi: number;
  lo: number;
  mid: number;
  width: number;
  /** entry close in [lo,hi], clamped 0..1 (can be outside → 0 or 1) */
  pos: number;
  band: ZoneBand;
};

export type MinuteBar = {
  open_time_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  bars: number;
};

export type StructureDecideInput = {
  bar: TenSecBar;
  /**
   * Entry authority regime (thesis / Soft OFF / playbook).
   * One-market desk passes the same thesis Soft OFF already used.
   */
  regime: string | null | undefined;
  /**
   * Raw classify for tip-chase (false-RANGE promote knife).
   * Defaults to `regime` when omitted.
   */
  classify_live?: string | null;
  closedBars: TenSecBar[];
  /** Optional — entry mind uses last Soft/manual to choose next side */
  last_closed_side?: 'BUY' | 'SELL' | null;
  last_close_was_loss?: boolean;
  client_id?: number | null;
  /**
   * Live Capital.com closed 1m direction when available — preferred over
   * 10s-book aggregate (same chart the human watches).
   */
  capital_m1_dir?: 'UP' | 'DOWN' | 'FLAT' | null;
  /** Capital closed 5m / 15m / 30m — preferred over 10s-book buckets */
  capital_tf5_dir?: 'UP' | 'DOWN' | 'FLAT' | null;
  capital_tf15_dir?: 'UP' | 'DOWN' | 'FLAT' | null;
  capital_tf30_dir?: 'UP' | 'DOWN' | 'FLAT' | null;
};

export type StructuredEntry = RegimeEntry & {
  entry_features?: EntryFeatures;
  entry_mind?: string;
};

/** Lower / upper half — realistic for Gold 30m zones (factory = genome struct_half_*) */
export const HALF_LO = 0.5;
export const HALF_HI = 0.5;
/** Only reject with-trend chase in the extreme 15% of the zone */
export const EXTREME_HI = 0.85;
export const EXTREME_LO = 0.15;
/**
 * Structure-start: prefer nearer half, but allow mid so a fresh 10s leg
 * is not starved until price is already mid-zone.
 */
export const START_LO = 0.65;
export const START_HI = 0.35;
/** BREAKOUT pierce zone pos (factory = genome breakout_pierce_*) */
export const BREAKOUT_PIERCE_HI = 0.92;
export const BREAKOUT_PIERCE_LO = 0.08;
/** FAILED_BREAK reclaim band (factory = genome failed_break_reclaim_*) */
export const FAILED_BREAK_RECLAIM_LO = 0.35;
export const FAILED_BREAK_RECLAIM_HI = 0.65;
/** COMPRESSION entry band (factory = genome compression_entry_* = half 0.5) */
export const COMPRESSION_ENTRY_LO = 0.5;
export const COMPRESSION_ENTRY_HI = 0.5;
/** Trek min-path as frac (7bp ≡ 0.0007) — factory = genome minute_trend_bias_trek_min_path_bp */
export const TREK_MIN_PATH_FRAC = 0.0007;

function structKnobs() {
  const g = getBrainGenome();
  return {
    halfLo: g.struct_half_lo || HALF_LO,
    halfHi: g.struct_half_hi || HALF_HI,
    extremeHi: g.struct_extreme_hi || EXTREME_HI,
    extremeLo: g.struct_extreme_lo || EXTREME_LO,
    startLo: g.struct_start_lo || START_LO,
    startHi: g.struct_start_hi || START_HI,
    pierceHi: g.breakout_pierce_pos_hi || BREAKOUT_PIERCE_HI,
    pierceLo: g.breakout_pierce_pos_lo || BREAKOUT_PIERCE_LO,
    failLo: g.failed_break_reclaim_pos_lo || FAILED_BREAK_RECLAIM_LO,
    failHi: g.failed_break_reclaim_pos_hi || FAILED_BREAK_RECLAIM_HI,
    compressLo: g.compression_entry_pos_lo || COMPRESSION_ENTRY_LO,
    compressHi: g.compression_entry_pos_hi || COMPRESSION_ENTRY_HI,
  };
}

function bandOf(pos: number): ZoneBand {
  const g = getBrainGenome();
  const lo = g.zone_band_cut_lo || 0.2;
  const midLo = g.zone_band_cut_mid_lo || 0.4;
  const midHi = g.zone_band_cut_mid_hi || 0.6;
  const hi = g.zone_band_cut_hi || 0.8;
  if (pos <= lo) return 'LO';
  if (pos <= midLo) return 'MID_LO';
  if (pos <= midHi) return 'MID';
  if (pos <= hi) return 'MID_HI';
  return 'HI';
}

/**
 * Zone hi/lo from book priors; position from **entry** close.
 * If entry is in the book, exclude that bar from hi/lo (same idea as classifyRegime).
 */
export function zoneGeometry(
  bars: TenSecBar[],
  entry?: TenSecBar | null
): ZoneGeometry | null {
  const minBars = getMinBarsForZone();
  const zoneBars = getZoneBars();
  if (!bars.length || bars.length < minBars) return null;
  const zone = bars.slice(-zoneBars);
  if (zone.length < 2) return null;

  const entryBar = entry ?? zone[zone.length - 1]!;
  let structureBars = zone.filter((b) => b.open_time_ms !== entryBar.open_time_ms);
  if (structureBars.length < 2) structureBars = zone.slice(0, -1);
  if (!structureBars.length) return null;

  const hi = Math.max(...structureBars.map((b) => b.high));
  const lo = Math.min(...structureBars.map((b) => b.low));
  const width = Math.max(hi - lo, 1e-9);
  const pos = Math.min(1, Math.max(0, (entryBar.close - lo) / width));
  return { hi, lo, mid: (hi + lo) / 2, width, pos, band: bandOf(pos) };
}

export function aggregateTenSecToMinutes(bars: TenSecBar[]): MinuteBar[] {
  if (!bars.length) return [];
  const map = new Map<number, TenSecBar[]>();
  for (const b of bars) {
    if (!Number.isFinite(b.open_time_ms)) continue;
    const bucket = Math.floor(b.open_time_ms / 60_000) * 60_000;
    let list = map.get(bucket);
    if (!list) {
      list = [];
      map.set(bucket, list);
    }
    list.push(b);
  }
  const keys = [...map.keys()].sort((a, b) => a - b);
  const out: MinuteBar[] = [];
  for (const k of keys) {
    const list = map.get(k)!;
    list.sort((a, b) => a.open_time_ms - b.open_time_ms);
    const first = list[0]!;
    const last = list[list.length - 1]!;
    out.push({
      open_time_ms: k,
      open: first.open,
      high: Math.max(...list.map((b) => b.high)),
      low: Math.min(...list.map((b) => b.low)),
      close: last.close,
      bars: list.length,
    });
  }
  return out;
}

/**
 * Forming bucket = max(tape last bar, wall clock).
 * - Live / past-only books: wall clock drops the current forming minute.
 * - Synthetic/future tape (tests/replay): tape leads so selloff minutes are not dropped.
 */
function tapeBucketMs(bars: TenSecBar[], bucketMs: number): number {
  let max = 0;
  for (const b of bars) {
    if (Number.isFinite(b.open_time_ms) && b.open_time_ms > max) max = b.open_time_ms;
  }
  const tape = max > 0 ? Math.floor(max / bucketMs) * bucketMs : 0;
  const wall = Math.floor(Date.now() / bucketMs) * bucketMs;
  return Math.max(tape, wall);
}

/**
 * Last closed 1m from 10s.
 * Prefer complete minutes; accept ≥3×10s (30s) so live books are not starved.
 * Drop only the forming minute on the tape (last bar's minute).
 */
export function lastClosed1mFromTenSec(bars: TenSecBar[]): MinuteBar | null {
  const mins = aggregateTenSecToMinutes(bars);
  if (!mins.length) return null;
  const lastBucket = tapeBucketMs(bars, 60_000);
  const minBars = Math.max(1, getBrainGenome().m1_aggregate_min_bars || 3);
  const closed = mins.filter((m) => m.open_time_ms < lastBucket && m.bars >= minBars);
  return closed.length ? closed[closed.length - 1]! : null;
}

/** Soft 1m direction — close vs open (matches what you see on 1m candle color). */
export function minuteDir(m: MinuteBar | null | undefined): 'UP' | 'DOWN' | 'FLAT' {
  if (!m) return 'FLAT';
  if (m.close > m.open) return 'UP';
  if (m.close < m.open) return 'DOWN';
  return 'FLAT';
}

/**
 * Multi-1m bias from the same 10s book — blocks bounce-BUY into a selloff
 * (e.g. Gold 08:15 long while 1m has been red since ~08:00).
 *
 * Use **trek** (hi−lo), not open→close net — V-bounce selloffs often have net≈0
 * while trek is several points (same bug class as marketStory "troksnis").
 */
export function minuteTrendBias(
  bars: TenSecBar[],
  lookback?: number
): 'UP' | 'DOWN' | 'FLAT' {
  const g = getBrainGenome();
  const lb = lookback ?? g.minute_trend_bias_lookback ?? 5;
  const mins = aggregateTenSecToMinutes(bars);
  if (!mins.length) return 'FLAT';
  const lastBucket = tapeBucketMs(bars, 60_000);
  const minBars = Math.max(1, g.m1_aggregate_min_bars || 3);
  const closed = mins.filter((m) => m.open_time_ms < lastBucket && m.bars >= minBars);
  const window = closed.slice(-Math.max(3, lb));
  if (window.length < 3) return 'FLAT';

  let up = 0;
  let down = 0;
  for (const m of window) {
    if (m.close > m.open) up += 1;
    else if (m.close < m.open) down += 1;
  }
  const first = window[0]!;
  const last = window[window.length - 1]!;
  const net = last.close - first.open;
  const trek =
    Math.max(...window.map((m) => m.high)) - Math.min(...window.map((m) => m.low));
  const midPx = Math.abs(last.close) || 1;
  const trekFrac =
    Math.max(0.1, g.minute_trend_bias_trek_min_path_bp || 7) * 1e-4 || TREK_MIN_PATH_FRAC;
  const trekAbs = getBrainGenome().trek_min_path_abs_pts || 3;
  const minPath = Math.max(trekAbs, midPx * trekFrac);
  if (trek < minPath) return 'FLAT';

  // Color majority + real trek wins even when net≈0 (dump→bounce)
  if (down >= 3 && (net < 0 || down > up)) return 'DOWN';
  if (up >= 3 && (net > 0 || up > down)) return 'UP';
  if (down > up) return 'DOWN';
  if (up > down) return 'UP';
  // Tie colors: fall back to net only if it agrees with trek direction from mid
  const midTrek = (Math.max(...window.map((m) => m.high)) + Math.min(...window.map((m) => m.low))) / 2;
  if (net < 0 && last.close <= midTrek) return 'DOWN';
  if (net > 0 && last.close >= midTrek) return 'UP';
  return 'FLAT';
}

/**
 * Higher-TF direction from the same 10s book (5m / 15m / 30m).
 * Close vs open of the last completed bucket — easy chart read for the mind.
 */
export function higherTfDir(
  bars: TenSecBar[],
  minutes: 5 | 15 | 30
): 'UP' | 'DOWN' | 'FLAT' {
  if (!bars.length) return 'FLAT';
  const bucketMs = minutes * 60_000;
  const map = new Map<number, TenSecBar[]>();
  for (const b of bars) {
    if (!Number.isFinite(b.open_time_ms)) continue;
    const k = Math.floor(b.open_time_ms / bucketMs) * bucketMs;
    let list = map.get(k);
    if (!list) {
      list = [];
      map.set(k, list);
    }
    list.push(b);
  }
  const keys = [...map.keys()].sort((a, b) => a - b);
  const lastBucket = tapeBucketMs(bars, bucketMs);
  const closedKeys = keys.filter((k) => k < lastBucket);
  if (!closedKeys.length) return 'FLAT';
  const k = closedKeys[closedKeys.length - 1]!;
  const list = map.get(k)!;
  if (list.length < Math.max(2, Math.floor((minutes * 6) / 3))) return 'FLAT';
  list.sort((a, b) => a.open_time_ms - b.open_time_ms);
  const open = list[0]!.open;
  const close = list[list.length - 1]!.close;
  if (close > open) return 'UP';
  if (close < open) return 'DOWN';
  return 'FLAT';
}

function rally(bar: TenSecBar): boolean {
  return bodyPct(bar) >= getActiveRegimeBands().ENTRY_RALLY;
}

function dip(bar: TenSecBar): boolean {
  return bodyPct(bar) <= getActiveRegimeBands().ENTRY_DIP;
}

function tag(zone: ZoneGeometry, md: string, bias?: string): string {
  const b = bias && bias !== 'FLAT' ? ` · bias=${bias}` : '';
  return `zona ${zone.band} pos=${zone.pos.toFixed(2)} · 1m=${md}${b}`;
}

/**
 * Structure-start for regimes that can begin a 1m leg from the zone half.
 * Does NOT require TREND_ENTER on 10s — only MOVING + zone half.
 * Side bias knives live in the entry mind (multi-TF), not here.
 */
export function structureStartEntry(
  bar: TenSecBar,
  regime: RegimeName,
  zone: ZoneGeometry | null,
  m1: MinuteBar | null,
  bias: 'UP' | 'DOWN' | 'FLAT' = 'FLAT'
): RegimeEntry | null {
  if (!zone || !isMoving10s(bar)) return null;
  const md = minuteDir(m1);
  const candle = `10s O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} · ${tag(zone, md, bias)}`;
  const { startLo, startHi } = structKnobs();

  switch (regime) {
    case 'UNKNOWN':
      return null;

    case 'TREND_UP':
    case 'PULLBACK_UPTREND':
    case 'EXPANSION':
    case 'BREAKOUT_UP':
    case 'FAILED_BREAKOUT_DOWN':
    case 'RANGE':
    case 'REVERSAL_CANDIDATE':
      if (zone.pos <= startLo && rally(bar)) {
        return {
          direction: 'BUY',
          setup: 'CONTINUATION',
          reason: `${regime} structure start LO-half · ${candle}`,
        };
      }
      break;
    default:
      break;
  }

  switch (regime) {
    case 'TREND_DOWN':
    case 'PULLBACK_DOWNTREND':
    case 'EXPANSION':
    case 'BREAKOUT_DOWN':
    case 'FAILED_BREAKOUT_UP':
    case 'RANGE':
    case 'REVERSAL_CANDIDATE':
      if (zone.pos >= startHi && dip(bar)) {
        return {
          direction: 'SELL',
          setup: 'CONTINUATION',
          reason: `${regime} structure start HI-half · ${candle}`,
        };
      }
      break;
    default:
      break;
  }

  return null;
}

export type StructureGateResult =
  | { ok: true; tag: string }
  | { ok: false; reason: string };

/**
 * Per-regime structure gate — soft, executable.
 * Unknown / thin zone → pass raw 10s (do not starve).
 * 1m / multi-TF side choice lives in the entry mind — not knife lists here.
 */
export function structureGate(
  sig: RegimeEntry,
  regime: RegimeName,
  bar: TenSecBar,
  zone: ZoneGeometry | null,
  m1: MinuteBar | null,
  bias: 'UP' | 'DOWN' | 'FLAT' = 'FLAT'
): StructureGateResult {
  if (!zone) {
    return { ok: true, tag: 'zona thin · raw 10s' };
  }
  const md = minuteDir(m1);
  const posTag = tag(zone, md, bias);
  const {
    halfLo,
    halfHi,
    extremeHi,
    extremeLo,
    pierceHi,
    pierceLo,
    failLo,
    failHi,
    compressLo,
    compressHi,
  } = structKnobs();
  const g = getBrainGenome();
  const bandLo = g.zone_band_cut_lo || 0.2;
  const bandHi = g.zone_band_cut_hi || 0.8;

  // Level <2: no structure soft-blocks — mind already chose the side
  if (!entryStructureEnabled()) {
    if (regime === 'UNKNOWN') return { ok: false, reason: 'UNKNOWN · no entry' };
    return { ok: true, tag: `open · ${posTag}` };
  }

  switch (regime) {
    case 'UNKNOWN':
      return { ok: false, reason: 'UNKNOWN · no entry' };

    case 'COMPRESSION': {
      // COMPRESSION entry band from genome compression_entry_* (factory = half)
      if (sig.direction === 'BUY' && zone.pos > compressLo) {
        return { ok: false, reason: `${regime} BUY not in lower half (${posTag})` };
      }
      if (sig.direction === 'SELL' && zone.pos < compressHi) {
        return { ok: false, reason: `${regime} SELL not in upper half (${posTag})` };
      }
      if (sig.direction === 'SELL' && zone.pos >= extremeHi && rally(bar)) {
        return { ok: false, reason: `${regime} SELL tip-chase HI (${posTag})` };
      }
      if (sig.direction === 'BUY' && zone.pos <= extremeLo && dip(bar)) {
        return { ok: false, reason: `${regime} BUY tip-chase LO (${posTag})` };
      }
      if (sig.direction === 'BUY' && zone.pos >= extremeHi && rally(bar)) {
        return { ok: false, reason: `${regime} BUY tip-chase HI (${posTag})` };
      }
      if (sig.direction === 'SELL' && zone.pos <= extremeLo && dip(bar)) {
        return { ok: false, reason: `${regime} SELL tip-chase LO (${posTag})` };
      }
      return { ok: true, tag: `${regime} half-OK · ${posTag}` };
    }

    case 'TRANSITION':
    case 'RANGE': {
      // Fade only in the correct half — never tip-chase (breakout / fake-break lookalike)
      if (sig.direction === 'BUY' && zone.pos > halfLo) {
        return { ok: false, reason: `${regime} BUY not in lower half (${posTag})` };
      }
      if (sig.direction === 'SELL' && zone.pos < halfHi) {
        return { ok: false, reason: `${regime} SELL not in upper half (${posTag})` };
      }
      // Extreme tip + WITH the move = breakout / fake-break lookalike (not fade reject)
      // SELL into HI green = selling the tip; BUY into LO red = buying the tip
      if (sig.direction === 'SELL' && zone.pos >= extremeHi && rally(bar)) {
        return { ok: false, reason: `${regime} SELL tip-chase HI (${posTag})` };
      }
      if (sig.direction === 'BUY' && zone.pos <= extremeLo && dip(bar)) {
        return { ok: false, reason: `${regime} BUY tip-chase LO (${posTag})` };
      }
      // Wrong-side knife at extreme still blocked
      if (sig.direction === 'BUY' && zone.pos >= extremeHi && rally(bar)) {
        return { ok: false, reason: `${regime} BUY tip-chase HI (${posTag})` };
      }
      if (sig.direction === 'SELL' && zone.pos <= extremeLo && dip(bar)) {
        return { ok: false, reason: `${regime} SELL tip-chase LO (${posTag})` };
      }
      return { ok: true, tag: `${regime} half-OK · ${posTag}` };
    }

    case 'TREND_UP':
      // Dip-buy — tip reject gated by genome entry_trend_tip_require_reject
      if (sig.direction !== 'BUY') {
        return { ok: false, reason: `TREND_UP only BUY (${posTag})` };
      }
      if (
        getBrainGenome().entry_trend_tip_require_reject !== false &&
        zone.pos >= extremeHi &&
        !dip(bar)
      ) {
        return { ok: false, reason: `TREND_UP chase HI tip (${posTag})` };
      }
      return { ok: true, tag: `TREND_UP OK · ${posTag}` };

    case 'TREND_DOWN':
      if (sig.direction !== 'SELL') {
        return { ok: false, reason: `TREND_DOWN only SELL (${posTag})` };
      }
      if (
        getBrainGenome().entry_trend_tip_require_reject !== false &&
        zone.pos <= extremeLo &&
        !rally(bar)
      ) {
        return { ok: false, reason: `TREND_DOWN chase LO tip (${posTag})` };
      }
      return { ok: true, tag: `TREND_DOWN OK · ${posTag}` };

    case 'PULLBACK_UPTREND':
      // Resume long on dip — tip reject gated by genome entry_trend_tip_require_reject
      if (sig.direction !== 'BUY') {
        return { ok: false, reason: `PULLBACK_UPTREND only BUY (${posTag})` };
      }
      if (
        getBrainGenome().entry_trend_tip_require_reject !== false &&
        zone.pos >= extremeHi &&
        !dip(bar)
      ) {
        return { ok: false, reason: `PULLBACK_UPTREND chase HI tip (${posTag})` };
      }
      return { ok: true, tag: `PULLBACK_UPTREND OK · ${posTag}` };

    case 'PULLBACK_DOWNTREND':
      if (sig.direction !== 'SELL') {
        return { ok: false, reason: `PULLBACK_DOWNTREND only SELL (${posTag})` };
      }
      if (
        getBrainGenome().entry_trend_tip_require_reject !== false &&
        zone.pos <= extremeLo &&
        !rally(bar)
      ) {
        return { ok: false, reason: `PULLBACK_DOWNTREND chase LO tip (${posTag})` };
      }
      return { ok: true, tag: `PULLBACK_DOWNTREND OK · ${posTag}` };

    case 'BREAKOUT_UP':
      // Must actually pierce / sit on the hi — mid-zone 0.55 was a fake breakout
      if (sig.direction !== 'BUY') {
        return { ok: false, reason: `BREAKOUT_UP only BUY (${posTag})` };
      }
      if (bar.close >= zone.hi || zone.pos >= pierceHi) {
        return { ok: true, tag: `BREAKOUT_UP pierce · ${posTag}` };
      }
      return { ok: false, reason: `BREAKOUT_UP not at/through hi (${posTag})` };

    case 'BREAKOUT_DOWN':
      if (sig.direction !== 'SELL') {
        return { ok: false, reason: `BREAKOUT_DOWN only SELL (${posTag})` };
      }
      if (bar.close <= zone.lo || zone.pos <= pierceLo) {
        return { ok: true, tag: `BREAKOUT_DOWN pierce · ${posTag}` };
      }
      return { ok: false, reason: `BREAKOUT_DOWN not at/through lo (${posTag})` };

    case 'EXPANSION':
      // Follow impulse from the start of the leg — not only after mid-zone
      if (sig.direction === 'BUY') {
        if (rally(bar) || bar.close >= zone.hi) {
          if (zone.pos >= bandLo || bar.close >= zone.hi) {
            return { ok: true, tag: `EXPANSION BUY · ${posTag}` };
          }
        }
        return { ok: false, reason: `EXPANSION BUY weak / wrong half (${posTag})` };
      }
      if (sig.direction === 'SELL') {
        if (dip(bar) || bar.close <= zone.lo) {
          if (zone.pos <= bandHi || bar.close <= zone.lo) {
            return { ok: true, tag: `EXPANSION SELL · ${posTag}` };
          }
        }
        return { ok: false, reason: `EXPANSION SELL weak / wrong half (${posTag})` };
      }
      return { ok: false, reason: `EXPANSION direction mismatch (${posTag})` };

    case 'FAILED_BREAKOUT_UP':
      // Fade short after failed up — upper half is correct (not LO)
      if (sig.direction !== 'SELL') {
        return { ok: false, reason: `FAILED_BREAKOUT_UP only SELL (${posTag})` };
      }
      if (zone.pos < failLo) {
        return { ok: false, reason: `FAILED_BREAKOUT_UP too far from hi (${posTag})` };
      }
      return { ok: true, tag: `FAILED_BREAKOUT_UP OK · ${posTag}` };

    case 'FAILED_BREAKOUT_DOWN':
      if (sig.direction !== 'BUY') {
        return { ok: false, reason: `FAILED_BREAKOUT_DOWN only BUY (${posTag})` };
      }
      if (zone.pos > failHi) {
        return { ok: false, reason: `FAILED_BREAKOUT_DOWN too far from lo (${posTag})` };
      }
      return { ok: true, tag: `FAILED_BREAKOUT_DOWN OK · ${posTag}` };

    case 'REVERSAL_CANDIDATE':
      // Violent bar — allow; only block buying extreme HI / selling extreme LO with-trend
      if (sig.direction === 'BUY' && zone.pos >= extremeHi && md === 'UP') {
        return { ok: false, reason: `REVERSAL BUY chase HI (${posTag})` };
      }
      if (sig.direction === 'SELL' && zone.pos <= extremeLo && md === 'DOWN') {
        return { ok: false, reason: `REVERSAL SELL chase LO (${posTag})` };
      }
      return { ok: true, tag: `REVERSAL OK · ${posTag}` };

    default:
      return { ok: true, tag: posTag };
  }
}

export function decideEntryWithStructure(input: StructureDecideInput): StructuredEntry | null {
  const regime = normalizeRegime(input.regime);
  const classifyLive = normalizeRegime(
    input.classify_live != null ? input.classify_live : input.regime
  );
  // One-market: UNKNOWN thesis waits — no HTF invent side
  if (regime === 'UNKNOWN') return null;

  const zone = zoneGeometry(input.closedBars, input.bar);
  const m1 = lastClosed1mFromTenSec(input.closedBars);
  const bias = minuteTrendBias(input.closedBars);
  const story = readMarketStory(input.closedBars, input.bar);

  // Prefer Capital candles (what the human sees) over 10s-book aggregates
  const bookMd = minuteDir(m1);
  const md =
    input.capital_m1_dir === 'UP' ||
    input.capital_m1_dir === 'DOWN' ||
    input.capital_m1_dir === 'FLAT'
      ? input.capital_m1_dir
      : bookMd;
  const pickTf = (
    capital: 'UP' | 'DOWN' | 'FLAT' | null | undefined,
    book: 'UP' | 'DOWN' | 'FLAT'
  ): 'UP' | 'DOWN' | 'FLAT' =>
    capital === 'UP' || capital === 'DOWN' || capital === 'FLAT' ? capital : book;
  // Capital HTF only for promote — never promote off 10s-book buckets alone
  const hasCapitalHtf =
    input.capital_tf5_dir != null ||
    input.capital_tf15_dir != null ||
    input.capital_tf30_dir != null ||
    input.capital_m1_dir != null;
  const tf5 = pickTf(input.capital_tf5_dir, higherTfDir(input.closedBars, 5));
  const tf15 = pickTf(input.capital_tf15_dir, higherTfDir(input.closedBars, 15));
  const tf30 = pickTf(input.capital_tf30_dir, higherTfDir(input.closedBars, 30));
  const htfSnap = hasCapitalHtf
    ? {
        tf30: input.capital_tf30_dir ?? null,
        tf15: input.capital_tf15_dir ?? null,
        tf5: input.capital_tf5_dir ?? null,
        m1: input.capital_m1_dir ?? null,
      }
    : null;
  // Thesis in = playbook out (idempotent when desk already passed effectiveEntryRegime)
  const playbook = pickEntryPlaybook({
    liveRegime: regime,
    story,
    htf: htfSnap,
  });
  const gateRegime = playbook.regime;
  const m1StrongMult = getBrainGenome().entry_m1_strong_move_mult || 0.5;
  const m1Strong =
    m1 != null && Math.abs(bodyPct(m1)) >= getActiveRegimeBands().MOVE * m1StrongMult
      ? true
      : md !== 'FLAT' && md === bias;

  const body = bodyPct(input.bar);
  const barSign: -1 | 0 | 1 = body > 1e-8 ? 1 : body < -1e-8 ? -1 : 0;

  // ★ Mind first — chooses BUY/SELL/WAIT from Capital 30→15→5→1 stack
  // Use promoted regime so false RANGE does not starve regimeLong/regimeShort bias
  const thought = thinkEntryLikeTrader({
    regime: gateRegime,
    chapter: story.chapter,
    allow: story.allow,
    story_conf: story.confidence,
    story_summary: story.summary_lv,
    red_1m: story.red_1m,
    green_1m: story.green_1m,
    zone_pos: zone?.pos ?? story.zone_pos,
    bar_body_sign: barSign,
    last_closed_side: input.last_closed_side ?? null,
    last_close_was_loss: Boolean(input.last_close_was_loss),
    m1_dir: md,
    m1_strong: m1Strong,
    bias,
    tf5_dir: tf5,
    tf15_dir: tf15,
    tf30_dir: tf30,
  });

  // Learner advises once it has enough closes (same pattern as manage brain)
  const learned = entryLearnerChoose(
    {
      regime: gateRegime,
      story,
      bar: input.bar,
      zone_pos: zone?.pos ?? story.zone_pos,
      last_closed_side: input.last_closed_side ?? null,
      last_close_was_loss: Boolean(input.last_close_was_loss),
      moving: isMoving10s(input.bar),
      m1_dir: md,
      m1_strong: m1Strong,
      bias,
    },
    input.client_id
  );
  const learnerReady =
    learned.updates >= 20 &&
    learned.confidence >=
      thought.confidence +
        (getBrainGenome().entry_learner_override_margin || 0.08) &&
    !learned.explored;
  // Setup is a preferred trigger — lane filters wrong setups (no RANGE FADE on BREAKOUT)
  const rawAll = decideEntryFrom10sRegime(input.bar, gateRegime);
  const raw =
    rawAll && setupAllowedOnLane(playbook.lane, rawAll.setup) ? rawAll : null;

  // Mind leads. Learner may reinforce the same side — never knife opposite.
  // Exception: raw 10s setup on LIVE/TREND lanes may lead when mind WAIT on thin
  // story (SEEDING / allow NONE) — setup → trade now (no scalp GAIDI hunt).
  let side = thought.choice;
  if (learnerReady && learned.action === thought.choice) {
    side = learned.action;
  }
  const chEarly = String(story.chapter || '').toUpperCase();
  const rawFillsThinStory =
    side === 'WAIT' &&
    raw != null &&
    playbook.lane !== 'RANGE_FADE' &&
    chEarly !== 'BOUNCE_IN_SELL' &&
    chEarly !== 'DIP_IN_RALLY' &&
    (chEarly === 'SEEDING' || story.allow === 'NONE' || story.allow === 'BOTH');
  if (rawFillsThinStory) {
    side = raw!.direction;
  }

  const mindDetail =
    learnerReady && learned.action === thought.choice
      ? `${thought.spoken} · LEARNER ${learned.action} n=${learned.updates}`
      : thought.spoken;

  if (side === 'WAIT') {
    return null;
  }

  // Belt-and-suspenders: story allow veto (mind already enforces; structure must too)
  if (story.allow === 'BUY' && side === 'SELL') return null;
  if (story.allow === 'SELL' && side === 'BUY') return null;
  // allow NONE: block mind-invented sides; raw SETUP NOW on non-RANGE lanes may proceed
  if (story.allow === 'NONE' && !rawFillsThinStory) return null;

  // Tip-chase knife — uses raw classify (not thesis) so false-RANGE promote still knifes tip
  const ch = chEarly;
  const zpos = zone?.pos ?? story.zone_pos;
  if (
    tipChaseBlocksEntry({
      liveRegime: classifyLive,
      lane: playbook.lane,
      chapter: ch,
      side,
      zpos,
      barSign,
    })
  ) {
    return null;
  }
  // Post-impulse tip — dump/V already ran to the edge; do not arm "kustība beigusies"
  if (
    postImpulseTipBlocksEntry({
      closedBars: input.closedBars,
      side,
      zpos,
      lane: playbook.lane,
      barSign,
    })
  ) {
    return null;
  }

  const startedAll = raw ? null : structureStartEntry(input.bar, gateRegime, zone, m1, bias);
  const started =
    startedAll && setupAllowedOnLane(playbook.lane, startedAll.setup) ? startedAll : null;
  const matched =
    raw && raw.direction === side
      ? raw
      : started && started.direction === side
        ? started
        : null;
  // Genome entry_require_regime_setup: no mind CONTINUATION invent without 10s/structure recipe
  const requireSetup = getBrainGenome().entry_require_regime_setup !== false;
  if (!matched && requireSetup) return null;
  const candidate: RegimeEntry = matched ?? {
    direction: side,
    setup: 'CONTINUATION',
    reason: `${playbook.why_lv} · mind ${side} · nav 10s trigger — izpildu PRĀTS`,
  };
  if (!setupAllowedOnLane(playbook.lane, candidate.setup)) return null;

  const gate = structureGate(candidate, gateRegime, input.bar, zone, m1, bias);
  if (!gate.ok) return null;

  const withMind = (reason: string): StructuredEntry => ({
    ...candidate,
    reason: `${mindDetail} · ${reason}`,
    entry_features: learned.features,
    entry_mind: mindDetail,
  });

  if (!entryStructureEnabled()) {
    // L0 OPEN still tags raw 10s setup as SETUP NOW (desk: setup → trade, no scalp hunt)
    if (matched === raw && raw) {
      return withMind(`${gate.tag} · ${playbook.lane} · SETUP NOW · ${story.summary_lv}`);
    }
    return withMind(
      matched
        ? `${gate.tag} · OPEN · ${story.summary_lv}`
        : `${gate.tag} · PRĀTS NOW · ${story.summary_lv}`
    );
  }

  // SETUP NOW must NOT skip scalp on RANGE FADE / post-dump bounce — that was the
  // Gold 17:45 "RANGE SELL" on the first green after a sell breakout (too early;
  // could still be bias change). FAILED_BREAKOUT / TREND / BREAKOUT raw may fire now.
  const setupNeedsConfirm =
    !raw ||
    (raw.setup === 'FADE' && playbook.lane === 'RANGE_FADE') ||
    story.chapter === 'BOUNCE_IN_SELL' ||
    story.chapter === 'DIP_IN_RALLY' ||
    story.chapter === 'EXHAUST_LO' ||
    story.chapter === 'EXHAUST_HI' ||
    gateRegime === 'RANGE' ||
    gateRegime === 'COMPRESSION' ||
    gateRegime === 'TRANSITION';
  if (matched === raw && raw && !setupNeedsConfirm) {
    return withMind(`${gate.tag} · ${playbook.lane} · SETUP NOW · ${story.summary_lv}`);
  }
  // Thin story + raw on LIVE lane: still SETUP NOW (e241eaac — stop scalp GAIDI hunts)
  if (rawFillsThinStory && matched === raw && raw) {
    return withMind(`${gate.tag} · ${playbook.lane} · SETUP NOW · ${story.summary_lv}`);
  }

  if (story.chapter === 'SEEDING') return null;

  // Promoted regime so TREND/PULLBACK scalp paths fire — not RANGE fade starve
  const scalp = scalpStoryConfirms(story, candidate.direction, gateRegime, input.bar);
  if (!scalp.ok) return null;
  return withMind(`${gate.tag} · ${playbook.lane} · ${story.summary_lv} · ${scalp.tag}`);
}

/** Test helper — live genome MOVE for strong 1m body */
export function minuteDirStrong(m: MinuteBar | null | undefined): 'UP' | 'DOWN' | 'FLAT' {
  if (!m) return 'FLAT';
  const bp = bodyPct(m);
  const move = getActiveRegimeBands().MOVE;
  if (bp >= move) return 'UP';
  if (bp <= -move) return 'DOWN';
  return minuteDir(m);
}
