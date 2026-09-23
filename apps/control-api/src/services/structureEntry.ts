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
import { ENTRY_DIP, ENTRY_RALLY, MOVE } from './regimeBands.js';
import {
  MIN_BARS_FOR_ZONE,
  ZONE_BARS,
  normalizeRegime,
  type RegimeName,
} from './regimes.js';
import { bodyPct, isMoving10s, type TenSecBar } from './tenSecondOhlc.js';
import { readMarketStory, scalpStoryConfirms } from './marketStory.js';

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
  regime: string | null | undefined;
  closedBars: TenSecBar[];
};

/** Lower / upper half — realistic for Gold 30m zones */
const HALF_LO = 0.5;
const HALF_HI = 0.5;
/** Only reject with-trend chase in the extreme 15% of the zone */
const EXTREME_HI = 0.85;
const EXTREME_LO = 0.15;
/**
 * Structure-start: prefer nearer half, but allow mid so a fresh 10s leg
 * is not starved until price is already mid-zone.
 */
const START_LO = 0.65;
const START_HI = 0.35;
/** Against-bias turn is OK near the edge (start of move), not mid-chop bounce */
const TURN_LO = 0.45;
const TURN_HI = 0.55;

function bandOf(pos: number): ZoneBand {
  if (pos <= 0.2) return 'LO';
  if (pos <= 0.4) return 'MID_LO';
  if (pos <= 0.6) return 'MID';
  if (pos <= 0.8) return 'MID_HI';
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
  if (!bars.length || bars.length < MIN_BARS_FOR_ZONE) return null;
  const zone = bars.slice(-ZONE_BARS);
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
 * Last closed 1m from 10s.
 * Prefer complete minutes; accept ≥3×10s (30s) so live books are not starved.
 * Drop only the wall-clock forming minute.
 */
export function lastClosed1mFromTenSec(bars: TenSecBar[]): MinuteBar | null {
  const mins = aggregateTenSecToMinutes(bars);
  if (!mins.length) return null;
  const lastBucket = Math.floor(Date.now() / 60_000) * 60_000;
  const closed = mins.filter((m) => m.open_time_ms < lastBucket && m.bars >= 3);
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
  lookback = 5
): 'UP' | 'DOWN' | 'FLAT' {
  const mins = aggregateTenSecToMinutes(bars);
  if (!mins.length) return 'FLAT';
  const lastBucket = Math.floor(Date.now() / 60_000) * 60_000;
  const closed = mins.filter((m) => m.open_time_ms < lastBucket && m.bars >= 3);
  const window = closed.slice(-Math.max(3, lookback));
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
  const minPath = Math.max(3, midPx * 0.0007);
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

/** Counter-trend entries that may ignore 1m bias (structured fade / reversal). */
function allowsAgainstBias(regime: RegimeName, direction: 'BUY' | 'SELL'): boolean {
  if (direction === 'BUY' && regime === 'FAILED_BREAKOUT_DOWN') return true;
  if (direction === 'SELL' && regime === 'FAILED_BREAKOUT_UP') return true;
  if (regime === 'REVERSAL_CANDIDATE') return true;
  return false;
}

function against1mBias(
  direction: 'BUY' | 'SELL',
  bias: 'UP' | 'DOWN' | 'FLAT',
  regime: RegimeName,
  zone: ZoneGeometry | null
): string | null {
  if (bias === 'FLAT' || allowsAgainstBias(regime, direction)) return null;
  // Turn start: BUY from LO half while prior 1ms are still red = start of rally
  if (direction === 'BUY' && bias === 'DOWN') {
    if (zone && zone.pos <= TURN_LO) return null;
    return `BUY vs 1m bias DOWN (${regime}) · bounce into selloff`;
  }
  // Turn start: SELL from HI half while prior 1ms are still green = start of drop
  if (direction === 'SELL' && bias === 'UP') {
    if (zone && zone.pos >= TURN_HI) return null;
    return `SELL vs 1m bias UP (${regime}) · fade into rally`;
  }
  return null;
}

function rally(bar: TenSecBar): boolean {
  return bodyPct(bar) >= ENTRY_RALLY;
}

function dip(bar: TenSecBar): boolean {
  return bodyPct(bar) <= ENTRY_DIP;
}

function tag(zone: ZoneGeometry, md: string, bias?: string): string {
  const b = bias && bias !== 'FLAT' ? ` · bias=${bias}` : '';
  return `zona ${zone.band} pos=${zone.pos.toFixed(2)} · 1m=${md}${b}`;
}

/**
 * Structure-start for regimes that can begin a 1m leg from the zone half.
 * Does NOT require TREND_ENTER on 10s — only MOVING + 1m color agreement.
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
      // Never start long mid-bounce into a selloff (knife) — LO-edge turn is OK
      // COMPRESSION / TRANSITION / UNKNOWN — no structure-start (wait-only)
      if (bias === 'DOWN' && !allowsAgainstBias(regime, 'BUY') && zone.pos > TURN_LO) {
        break;
      }
      // 10s rally starts the leg — do NOT wait for last closed 1m to flip green
      // (that delay is why entries open mid-move)
      if (zone.pos <= START_LO && rally(bar)) {
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
      if (bias === 'UP' && !allowsAgainstBias(regime, 'SELL') && zone.pos < TURN_HI) {
        break;
      }
      if (zone.pos >= START_HI && dip(bar)) {
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

  const against = against1mBias(sig.direction, bias, regime, zone);
  if (against) {
    return { ok: false, reason: against };
  }

  switch (regime) {
    case 'UNKNOWN':
      return { ok: false, reason: 'UNKNOWN · no entry' };

    case 'COMPRESSION':
      // Wait for expansion/breakout — micro fade in thin range is noise, not a setup
      return { ok: false, reason: `COMPRESSION wait-only · ${posTag}` };

    case 'TRANSITION':
      // Unclear next regime — never arm from structure path
      return { ok: false, reason: `TRANSITION wait-only · ${posTag}` };

    case 'RANGE':
      // Fade only in the correct half (not mid-wrong-way)
      if (sig.direction === 'BUY' && zone.pos > HALF_LO) {
        return { ok: false, reason: `RANGE BUY not in lower half (${posTag})` };
      }
      if (sig.direction === 'SELL' && zone.pos < HALF_HI) {
        return { ok: false, reason: `RANGE SELL not in upper half (${posTag})` };
      }
      return { ok: true, tag: `RANGE half-OK · ${posTag}` };

    case 'TREND_UP':
      // Dip-buy: allow anywhere except extreme HI chase without a real dip context
      if (sig.direction !== 'BUY') {
        return { ok: false, reason: `TREND_UP only BUY (${posTag})` };
      }
      if (zone.pos >= EXTREME_HI && md === 'UP' && sig.setup !== 'PULLBACK') {
        return { ok: false, reason: `TREND_UP chase HI (${posTag})` };
      }
      return { ok: true, tag: `TREND_UP OK · ${posTag}` };

    case 'TREND_DOWN':
      if (sig.direction !== 'SELL') {
        return { ok: false, reason: `TREND_DOWN only SELL (${posTag})` };
      }
      if (zone.pos <= EXTREME_LO && md === 'DOWN' && sig.setup !== 'PULLBACK') {
        return { ok: false, reason: `TREND_DOWN chase LO (${posTag})` };
      }
      return { ok: true, tag: `TREND_DOWN OK · ${posTag}` };

    case 'PULLBACK_UPTREND':
      // Resume long — mid-zone is normal; only block extreme HI melt-up
      if (sig.direction !== 'BUY') {
        return { ok: false, reason: `PULLBACK_UPTREND only BUY (${posTag})` };
      }
      if (zone.pos >= EXTREME_HI && !rally(bar)) {
        return { ok: false, reason: `PULLBACK_UPTREND late HI (${posTag})` };
      }
      return { ok: true, tag: `PULLBACK_UPTREND OK · ${posTag}` };

    case 'PULLBACK_DOWNTREND':
      if (sig.direction !== 'SELL') {
        return { ok: false, reason: `PULLBACK_DOWNTREND only SELL (${posTag})` };
      }
      if (zone.pos <= EXTREME_LO && !dip(bar)) {
        return { ok: false, reason: `PULLBACK_DOWNTREND late LO (${posTag})` };
      }
      return { ok: true, tag: `PULLBACK_DOWNTREND OK · ${posTag}` };

    case 'BREAKOUT_UP':
      // Must actually pierce / sit on the hi — mid-zone 0.55 was a fake breakout
      if (sig.direction !== 'BUY') {
        return { ok: false, reason: `BREAKOUT_UP only BUY (${posTag})` };
      }
      if (bar.close >= zone.hi || zone.pos >= 0.92) {
        return { ok: true, tag: `BREAKOUT_UP pierce · ${posTag}` };
      }
      return { ok: false, reason: `BREAKOUT_UP not at/through hi (${posTag})` };

    case 'BREAKOUT_DOWN':
      if (sig.direction !== 'SELL') {
        return { ok: false, reason: `BREAKOUT_DOWN only SELL (${posTag})` };
      }
      if (bar.close <= zone.lo || zone.pos <= 0.08) {
        return { ok: true, tag: `BREAKOUT_DOWN pierce · ${posTag}` };
      }
      return { ok: false, reason: `BREAKOUT_DOWN not at/through lo (${posTag})` };

    case 'EXPANSION':
      // Follow impulse from the start of the leg — not only after mid-zone
      if (sig.direction === 'BUY') {
        if (rally(bar) || bar.close >= zone.hi) {
          if (zone.pos >= 0.2 || bar.close >= zone.hi) {
            return { ok: true, tag: `EXPANSION BUY · ${posTag}` };
          }
        }
        return { ok: false, reason: `EXPANSION BUY weak / wrong half (${posTag})` };
      }
      if (sig.direction === 'SELL') {
        if (dip(bar) || bar.close <= zone.lo) {
          if (zone.pos <= 0.8 || bar.close <= zone.lo) {
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
      if (zone.pos < 0.35) {
        return { ok: false, reason: `FAILED_BREAKOUT_UP too far from hi (${posTag})` };
      }
      return { ok: true, tag: `FAILED_BREAKOUT_UP OK · ${posTag}` };

    case 'FAILED_BREAKOUT_DOWN':
      if (sig.direction !== 'BUY') {
        return { ok: false, reason: `FAILED_BREAKOUT_DOWN only BUY (${posTag})` };
      }
      if (zone.pos > 0.65) {
        return { ok: false, reason: `FAILED_BREAKOUT_DOWN too far from lo (${posTag})` };
      }
      return { ok: true, tag: `FAILED_BREAKOUT_DOWN OK · ${posTag}` };

    case 'REVERSAL_CANDIDATE':
      // Violent bar — allow; only block buying extreme HI / selling extreme LO with-trend
      if (sig.direction === 'BUY' && zone.pos >= EXTREME_HI && md === 'UP') {
        return { ok: false, reason: `REVERSAL BUY chase HI (${posTag})` };
      }
      if (sig.direction === 'SELL' && zone.pos <= EXTREME_LO && md === 'DOWN') {
        return { ok: false, reason: `REVERSAL SELL chase LO (${posTag})` };
      }
      return { ok: true, tag: `REVERSAL OK · ${posTag}` };

    default:
      return { ok: true, tag: posTag };
  }
}

export function decideEntryWithStructure(input: StructureDecideInput): RegimeEntry | null {
  const regime = normalizeRegime(input.regime);
  if (regime === 'UNKNOWN') return null;

  const zone = zoneGeometry(input.closedBars, input.bar);
  const m1 = lastClosed1mFromTenSec(input.closedBars);
  const bias = minuteTrendBias(input.closedBars);
  const story = readMarketStory(input.closedBars, input.bar);
  const raw = decideEntryFrom10sRegime(input.bar, regime);
  const started = raw ? null : structureStartEntry(input.bar, regime, zone, m1, bias);
  const candidate = raw ?? started;
  if (!candidate) return null;

  const gate = structureGate(candidate, regime, input.bar, zone, m1, bias);
  if (!gate.ok) return null;

  // Full 30m story ready → soft 1m/10s scalp (trigger bar starts the leg)
  if (story.chapter !== 'SEEDING') {
    const scalp = scalpStoryConfirms(story, candidate.direction, regime, input.bar);
    if (!scalp.ok) return null;
    return {
      ...candidate,
      reason: `${candidate.reason} · ${gate.tag} · ${story.summary_lv} · ${scalp.tag}`,
    };
  }

  return {
    ...candidate,
    reason: `${candidate.reason} · ${gate.tag} · ${story.summary_lv}`,
  };
}

/** Test helper — MOVE kept for callers that want strong 1m body */
export function minuteDirStrong(m: MinuteBar | null | undefined): 'UP' | 'DOWN' | 'FLAT' {
  if (!m) return 'FLAT';
  const bp = bodyPct(m);
  if (bp >= MOVE) return 'UP';
  if (bp <= -MOVE) return 'DOWN';
  return minuteDir(m);
}
