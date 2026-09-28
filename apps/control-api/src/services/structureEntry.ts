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
import { entryStructureEnabled } from './tradeOpenPolicy.js';
import { entryLearnerChoose, type EntryFeatures } from './entryLearner.js';
import { thinkEntryLikeTrader } from './traderMind.js';

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
  const lastBucket = Math.floor(Date.now() / bucketMs) * bucketMs;
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

  // Level <2: no structure soft-blocks — mind already chose the side
  if (!entryStructureEnabled()) {
    if (regime === 'UNKNOWN') return { ok: false, reason: 'UNKNOWN · no entry' };
    return { ok: true, tag: `open · ${posTag}` };
  }

  switch (regime) {
    case 'UNKNOWN':
      return { ok: false, reason: 'UNKNOWN · no entry' };

    case 'COMPRESSION':
      return { ok: true, tag: `COMPRESSION open · ${posTag}` };

    case 'TRANSITION':
      return { ok: true, tag: `TRANSITION open · ${posTag}` };

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

export function decideEntryWithStructure(input: StructureDecideInput): StructuredEntry | null {
  const regime = normalizeRegime(input.regime);
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
  const tf5 = pickTf(input.capital_tf5_dir, higherTfDir(input.closedBars, 5));
  const tf15 = pickTf(input.capital_tf15_dir, higherTfDir(input.closedBars, 15));
  const tf30 = pickTf(input.capital_tf30_dir, higherTfDir(input.closedBars, 30));
  const m1Strong =
    m1 != null && Math.abs(bodyPct(m1)) >= MOVE * 0.5
      ? true
      : md !== 'FLAT' && md === bias;

  const body = bodyPct(input.bar);
  const barSign: -1 | 0 | 1 = body > 1e-8 ? 1 : body < -1e-8 ? -1 : 0;

  // ★ Mind first — chooses BUY/SELL/WAIT from Capital 30→15→5→1 stack
  const thought = thinkEntryLikeTrader({
    regime,
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
      regime,
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
    learned.confidence >= thought.confidence + 0.08 &&
    !learned.explored;
  // Mind leads. Learner may reinforce the same side — never knife opposite.
  let side = thought.choice;
  if (learnerReady && learned.action === thought.choice) {
    side = learned.action;
  }

  const mindDetail =
    learnerReady && learned.action === thought.choice
      ? `${thought.spoken} · LEARNER ${learned.action} n=${learned.updates}`
      : thought.spoken;

  if (side === 'WAIT') {
    return null;
  }

  // Setup is a preferred trigger — if none matches, mind still executes (PRĀTS side)
  const raw = decideEntryFrom10sRegime(input.bar, regime);
  const started = raw ? null : structureStartEntry(input.bar, regime, zone, m1, bias);
  const matched =
    raw && raw.direction === side
      ? raw
      : started && started.direction === side
        ? started
        : null;
  const candidate: RegimeEntry = matched ?? {
    direction: side,
    setup: 'PRĀTS',
    reason: `${regime} · mind ${side} · nav 10s trigger — izpildu PRĀTS`,
  };

  const gate = structureGate(candidate, regime, input.bar, zone, m1, bias);
  if (!gate.ok) return null;

  const withMind = (reason: string): StructuredEntry => ({
    ...candidate,
    reason: `${mindDetail} · ${reason}`,
    entry_features: learned.features,
    entry_mind: mindDetail,
  });

  if (!entryStructureEnabled()) {
    return withMind(
      matched
        ? `${gate.tag} · OPEN · ${story.summary_lv}`
        : `${gate.tag} · PRĀTS NOW · ${story.summary_lv}`
    );
  }

  if (matched === raw && raw) {
    return withMind(`${gate.tag} · SETUP NOW · ${story.summary_lv}`);
  }

  if (story.chapter === 'SEEDING') return null;

  const scalp = scalpStoryConfirms(story, candidate.direction, regime, input.bar);
  if (!scalp.ok) return null;
  return withMind(`${gate.tag} · ${story.summary_lv} · ${scalp.tag}`);
}

/** Test helper — MOVE kept for callers that want strong 1m body */
export function minuteDirStrong(m: MinuteBar | null | undefined): 'UP' | 'DOWN' | 'FLAT' {
  if (!m) return 'FLAT';
  const bp = bodyPct(m);
  if (bp >= MOVE) return 'UP';
  if (bp <= -MOVE) return 'DOWN';
  return minuteDir(m);
}
