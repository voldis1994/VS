/**
 * Structure entry — make 10s OHLC decisions correspond to the 1m chart.
 *
 * Zone (≈30m of 10s bars) + last closed 1m (aggregated from the same 10s book)
 * distinguish chase (mid/far zone, with-trend candle) from real setup
 * (bounce/reject at zone edge, or breakout pierce, confirmed by 1m).
 */
import { decideEntryFrom10sRegime, type RegimeEntry } from './entryFromRegime.js';
import { ENTRY_DIP, ENTRY_RALLY, MOVE } from './regimeBands.js';
import { MIN_BARS_FOR_ZONE, ZONE_BARS, normalizeRegime, type RegimeName } from './regimes.js';
import {
  bodyPct,
  isMoving10s,
  type TenSecBar,
} from './tenSecondOhlc.js';

/** 0 at zone lo → 1 at zone hi */
export type ZoneBand = 'LO' | 'MID_LO' | 'MID' | 'MID_HI' | 'HI';

export type ZoneGeometry = {
  hi: number;
  lo: number;
  mid: number;
  width: number;
  /** close position in [lo,hi], clamped 0..1 */
  pos: number;
  band: ZoneBand;
};

export type MinuteBar = {
  open_time_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** How many 10s bars contributed (6 = full minute) */
  bars: number;
};

export type StructureDecideInput = {
  bar: TenSecBar;
  regime: string | null | undefined;
  /** Robot closed 10s book (same series as classifyRegime) */
  closedBars: TenSecBar[];
};

const LO_MAX = 0.42;
const HI_MIN = 0.58;
/** Chase into extreme — reject with-trend non-breakout */
const CHASE_HI = 0.72;
const CHASE_LO = 0.28;

function bandOf(pos: number): ZoneBand {
  if (pos <= 0.2) return 'LO';
  if (pos <= 0.4) return 'MID_LO';
  if (pos <= 0.6) return 'MID';
  if (pos <= 0.8) return 'MID_HI';
  return 'HI';
}

/** 30m structure from closed 10s bars (same window as classifyRegime). */
export function zoneGeometry(bars: TenSecBar[]): ZoneGeometry | null {
  if (!bars.length || bars.length < MIN_BARS_FOR_ZONE) return null;
  const zone = bars.slice(-ZONE_BARS);
  if (zone.length < 2) return null;
  const prior = zone.slice(0, -1);
  const last = zone[zone.length - 1]!;
  const hi = Math.max(...prior.map((b) => b.high));
  const lo = Math.min(...prior.map((b) => b.low));
  const width = Math.max(hi - lo, 1e-9);
  const pos = Math.min(1, Math.max(0, (last.close - lo) / width));
  return { hi, lo, mid: (hi + lo) / 2, width, pos, band: bandOf(pos) };
}

/**
 * Aggregate 10s → 1m OHLC (aligned to minute buckets).
 * Incomplete trailing minute (still forming / partial seed) is omitted from "closed".
 */
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

/** Last fully closed 1m built from 10s (prefer complete 6×10s; else ≥4). */
export function lastClosed1mFromTenSec(bars: TenSecBar[]): MinuteBar | null {
  const mins = aggregateTenSecToMinutes(bars);
  if (!mins.length) return null;
  const lastBucket = Math.floor(Date.now() / 60_000) * 60_000;
  // Drop forming minute (same wall bucket) and incomplete trailing seed
  const closed = mins.filter((m) => {
    if (m.open_time_ms >= lastBucket) return false;
    return m.bars >= 4;
  });
  return closed.length ? closed[closed.length - 1]! : null;
}

export function minuteDir(m: MinuteBar | null | undefined): 'UP' | 'DOWN' | 'FLAT' {
  if (!m) return 'FLAT';
  const bp = bodyPct(m);
  if (bp >= MOVE) return 'UP';
  if (bp <= -MOVE) return 'DOWN';
  if (m.close > m.open) return 'UP';
  if (m.close < m.open) return 'DOWN';
  return 'FLAT';
}

function rally(bar: TenSecBar): boolean {
  return bodyPct(bar) >= ENTRY_RALLY;
}

function dip(bar: TenSecBar): boolean {
  return bodyPct(bar) <= ENTRY_DIP;
}

/**
 * Real 1m-aligned start from zone edge (not mid-zone chase).
 * Catches slow 1m legs that never print a TREND_ENTER 10s body.
 */
export function structureStartEntry(
  bar: TenSecBar,
  regime: RegimeName,
  zone: ZoneGeometry | null,
  m1: MinuteBar | null
): RegimeEntry | null {
  if (!zone || !isMoving10s(bar)) return null;
  const md = minuteDir(m1);
  const candle = `10s O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} · 1m=${md} · zona ${zone.band} pos=${zone.pos.toFixed(2)}`;

  const upFamily =
    regime === 'TREND_UP' ||
    regime === 'PULLBACK_UPTREND' ||
    regime === 'EXPANSION' ||
    regime === 'BREAKOUT_UP' ||
    regime === 'RANGE';
  const downFamily =
    regime === 'TREND_DOWN' ||
    regime === 'PULLBACK_DOWNTREND' ||
    regime === 'EXPANSION' ||
    regime === 'BREAKOUT_DOWN' ||
    regime === 'RANGE';

  // From zone LO / lower band: 1m UP + 10s rally = structure long (1m chart leg)
  if (upFamily && zone.pos <= LO_MAX && md === 'UP' && rally(bar)) {
    return {
      direction: 'BUY',
      setup: 'CONTINUATION',
      reason: `${regime} structure LO→1m UP · ${candle}`,
    };
  }
  // From zone HI / upper band: 1m DOWN + 10s dip = structure short
  if (downFamily && zone.pos >= HI_MIN && md === 'DOWN' && dip(bar)) {
    return {
      direction: 'SELL',
      setup: 'CONTINUATION',
      reason: `${regime} structure HI→1m DOWN · ${candle}`,
    };
  }
  return null;
}

export type StructureGateResult =
  | { ok: true; tag: string }
  | { ok: false; reason: string };

/**
 * Reject chase: with-trend 10s signal far from structure edge / against 1m.
 * Keep breakouts that already pierced the zone.
 */
export function structureGate(
  sig: RegimeEntry,
  regime: RegimeName,
  bar: TenSecBar,
  zone: ZoneGeometry | null,
  m1: MinuteBar | null
): StructureGateResult {
  if (!zone) {
    return { ok: true, tag: 'zona thin · raw 10s' };
  }
  const md = minuteDir(m1);
  const posTag = `zona ${zone.band} pos=${zone.pos.toFixed(2)} · 1m=${md}`;

  // Fade only at the correct edge
  if (sig.setup === 'FADE') {
    if (sig.direction === 'BUY' && zone.pos > LO_MAX) {
      return { ok: false, reason: `FADE BUY chase · not at LO (${posTag})` };
    }
    if (sig.direction === 'SELL' && zone.pos < HI_MIN) {
      return { ok: false, reason: `FADE SELL chase · not at HI (${posTag})` };
    }
    return { ok: true, tag: `structure fade · ${posTag}` };
  }

  // Breakout must still be at/through the edge on this 10s close
  if (sig.setup === 'BREAKOUT') {
    if (sig.direction === 'BUY' && bar.close < zone.hi && zone.pos < 0.9) {
      return { ok: false, reason: `BREAKOUT BUY not at hi (${posTag})` };
    }
    if (sig.direction === 'SELL' && bar.close > zone.lo && zone.pos > 0.1) {
      return { ok: false, reason: `BREAKOUT SELL not at lo (${posTag})` };
    }
    // 1m should not violently fight the pierce
    if (sig.direction === 'BUY' && md === 'DOWN') {
      return { ok: false, reason: `BREAKOUT BUY vs 1m DOWN (${posTag})` };
    }
    if (sig.direction === 'SELL' && md === 'UP') {
      return { ok: false, reason: `BREAKOUT SELL vs 1m UP (${posTag})` };
    }
    return { ok: true, tag: `structure breakout · ${posTag}` };
  }

  // Pullback / continuation / reversal — block mid-zone with-trend chase
  if (sig.direction === 'BUY') {
    if (zone.pos >= CHASE_HI && md === 'UP' && sig.setup !== 'REVERSAL') {
      return { ok: false, reason: `BUY chase into HI (${posTag})` };
    }
    // Pullback BUY wants dip near support, not dip already at highs
    if (sig.setup === 'PULLBACK' && zone.pos >= HI_MIN && md !== 'DOWN') {
      return { ok: false, reason: `PULLBACK BUY not at support (${posTag})` };
    }
    return { ok: true, tag: `structure long · ${posTag}` };
  }

  if (sig.direction === 'SELL') {
    if (zone.pos <= CHASE_LO && md === 'DOWN' && sig.setup !== 'REVERSAL') {
      return { ok: false, reason: `SELL chase into LO (${posTag})` };
    }
    if (sig.setup === 'PULLBACK' && zone.pos <= LO_MAX && md !== 'UP') {
      return { ok: false, reason: `PULLBACK SELL not at resistance (${posTag})` };
    }
    return { ok: true, tag: `structure short · ${posTag}` };
  }

  return { ok: true, tag: posTag };
}

/**
 * Live entry: 10s regime recipe + 1m/zone structure.
 * Prefer raw 10s signal when present; else structure-start from zone edge.
 */
export function decideEntryWithStructure(input: StructureDecideInput): RegimeEntry | null {
  const regime = normalizeRegime(input.regime);
  if (regime === 'UNKNOWN') return null;

  const zone = zoneGeometry(input.closedBars);
  const m1 = lastClosed1mFromTenSec(input.closedBars);
  const raw = decideEntryFrom10sRegime(input.bar, regime);
  const started = raw ? null : structureStartEntry(input.bar, regime, zone, m1);
  const candidate = raw ?? started;
  if (!candidate) return null;

  const gate = structureGate(candidate, regime, input.bar, zone, m1);
  if (!gate.ok) return null;

  return {
    ...candidate,
    reason: `${candidate.reason} · ${gate.tag}`,
  };
}
