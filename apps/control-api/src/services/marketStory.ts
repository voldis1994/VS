/**
 * Human-readable 30m market story from the same 10s book the robot already has.
 *
 * Not another % threshold — reconstructs what a trader sees on a 1m chart over ~30m:
 * path (up/down/chop), swing structure (HH/HL vs LH/LL), where price sits in the zone,
 * and whether the last minutes are a bounce inside a selloff (knife) or a real turn.
 */
import { ZONE_BARS, MIN_BARS_FOR_ZONE } from './regimes.js';
import type { TenSecBar } from './tenSecondOhlc.js';

export type StoryChapter =
  | 'SEEDING'
  | 'SELLOFF'
  | 'RALLY'
  | 'BOUNCE_IN_SELL'
  | 'DIP_IN_RALLY'
  | 'RANGE_CHOP'
  | 'BREAK_UP'
  | 'BREAK_DOWN'
  | 'EXHAUST_LO'
  | 'EXHAUST_HI';

export type StorySide = 'BUY' | 'SELL' | 'BOTH' | 'NONE';

export type MinuteBar = {
  open_time_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  bars: number;
};

export type MarketStory = {
  chapter: StoryChapter;
  allow: StorySide;
  summary_lv: string;
  detail: string;
  confidence: number;
  zone_pos: number | null;
  net_pts: number;
  red_1m: number;
  green_1m: number;
  swing: 'LL_LH' | 'HH_HL' | 'MIXED' | 'UNKNOWN';
};

function aggregateTenSecToMinutes(bars: TenSecBar[]): MinuteBar[] {
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
      high: Math.max(...list.map((x) => x.high)),
      low: Math.min(...list.map((x) => x.low)),
      close: last.close,
      bars: list.length,
    });
  }
  return out;
}

function closedMinutes(bars: TenSecBar[]): MinuteBar[] {
  const mins = aggregateTenSecToMinutes(bars);
  const lastBucket = Math.floor(Date.now() / 60_000) * 60_000;
  return mins.filter((m) => m.open_time_ms < lastBucket && m.bars >= 3);
}

function storyWindow(bars: TenSecBar[]): MinuteBar[] {
  return closedMinutes(bars).slice(-30);
}

function zonePos(
  bars: TenSecBar[],
  entry?: TenSecBar | null
): { hi: number; lo: number; pos: number; band: string } | null {
  if (bars.length < MIN_BARS_FOR_ZONE) return null;
  const zone = bars.slice(-ZONE_BARS);
  if (zone.length < 2) return null;
  const entryBar = entry ?? zone[zone.length - 1]!;
  let structure = zone.filter((b) => b.open_time_ms !== entryBar.open_time_ms);
  if (structure.length < 2) structure = zone.slice(0, -1);
  if (!structure.length) return null;
  const hi = Math.max(...structure.map((b) => b.high));
  const lo = Math.min(...structure.map((b) => b.low));
  const width = Math.max(hi - lo, 1e-9);
  const pos = Math.min(1, Math.max(0, (entryBar.close - lo) / width));
  const band =
    pos <= 0.2 ? 'LO' : pos <= 0.4 ? 'MID_LO' : pos <= 0.6 ? 'MID' : pos <= 0.8 ? 'MID_HI' : 'HI';
  return { hi, lo, pos, band };
}

type Pivot = { i: number; price: number; kind: 'H' | 'L' };

function pivots(mins: MinuteBar[]): Pivot[] {
  const out: Pivot[] = [];
  for (let i = 1; i < mins.length - 1; i++) {
    const a = mins[i - 1]!;
    const b = mins[i]!;
    const c = mins[i + 1]!;
    if (b.high >= a.high && b.high >= c.high) out.push({ i, price: b.high, kind: 'H' });
    if (b.low <= a.low && b.low <= c.low) out.push({ i, price: b.low, kind: 'L' });
  }
  return out;
}

function swingLabel(mins: MinuteBar[]): MarketStory['swing'] {
  const p = pivots(mins);
  const highs = p.filter((x) => x.kind === 'H').slice(-3);
  const lows = p.filter((x) => x.kind === 'L').slice(-3);
  if (highs.length < 2 || lows.length < 2) return 'UNKNOWN';
  const hh = highs[highs.length - 1]!.price > highs[highs.length - 2]!.price;
  const lh = highs[highs.length - 1]!.price < highs[highs.length - 2]!.price;
  const hl = lows[lows.length - 1]!.price > lows[lows.length - 2]!.price;
  const ll = lows[lows.length - 1]!.price < lows[lows.length - 2]!.price;
  if (lh && ll) return 'LL_LH';
  if (hh && hl) return 'HH_HL';
  return 'MIXED';
}

function countColors(mins: MinuteBar[]): { red: number; green: number } {
  let red = 0;
  let green = 0;
  for (const m of mins) {
    if (m.close < m.open) red += 1;
    else if (m.close > m.open) green += 1;
  }
  return { red, green };
}

export function readMarketStory(
  closedBars: TenSecBar[],
  entry?: TenSecBar | null
): MarketStory {
  const empty = (chapter: StoryChapter, summary_lv: string): MarketStory => ({
    chapter,
    allow: 'BOTH',
    summary_lv,
    detail: 'insufficient 30m book',
    confidence: 0.1,
    zone_pos: null,
    net_pts: 0,
    red_1m: 0,
    green_1m: 0,
    swing: 'UNKNOWN',
  });

  if (!closedBars.length || closedBars.length < MIN_BARS_FOR_ZONE) {
    return empty('SEEDING', 'STĀSTS · vēl lasa 30m zonu…');
  }

  const zone = zonePos(closedBars, entry);
  const mins = storyWindow(closedBars);
  if (mins.length < 8) {
    return empty('SEEDING', 'STĀSTS · par maz 1m sveces stāstam…');
  }

  const first = mins[0]!;
  const last = mins[mins.length - 1]!;
  const net = last.close - first.open;
  const { red, green } = countColors(mins);
  const recent = mins.slice(-5);
  const { red: redR, green: greenR } = countColors(recent);
  const recentNet = recent[recent.length - 1]!.close - recent[0]!.open;
  const swing = swingLabel(mins);
  const pos = zone?.pos ?? 0.5;
  const hi = zone?.hi ?? Math.max(...mins.map((m) => m.high));
  const lo = zone?.lo ?? Math.min(...mins.map((m) => m.low));

  const brokeUp = last.close > hi;
  const brokeDown = last.close < lo;

  const sellStruct = swing === 'LL_LH' || (net < 0 && red >= green + 2);
  const buyStruct = swing === 'HH_HL' || (net > 0 && green >= red + 2);
  const recentSell = recentNet < 0 && redR >= 3;
  const recentBuy = recentNet > 0 && greenR >= 3;
  const bounceInSell =
    sellStruct && !brokeUp && greenR >= 1 && greenR <= 2 && redR >= 2 && recentNet >= 0;
  const dipInRally =
    buyStruct && !brokeDown && redR >= 1 && redR <= 2 && greenR >= 2 && recentNet <= 0;

  let chapter: StoryChapter;
  let allow: StorySide;
  let summary_lv: string;
  let confidence = 0.55;

  if (brokeUp && (buyStruct || recentBuy || last.close > first.open)) {
    chapter = 'BREAK_UP';
    allow = 'BUY';
    summary_lv = 'STĀSTS · 30m BREAK UP virs zonas · sekot gariem (ne fade)';
    confidence = 0.8;
  } else if (brokeDown && (sellStruct || recentSell || last.close < first.open)) {
    chapter = 'BREAK_DOWN';
    allow = 'SELL';
    summary_lv = 'STĀSTS · 30m BREAK DOWN zem zonas · sekot īsiem (nepirkt)';
    confidence = 0.8;
  } else if (bounceInSell) {
    chapter = 'BOUNCE_IN_SELL';
    allow = 'SELL';
    summary_lv = 'STĀSTS · īss atspēriens selloffā · NEPIRKT bounce · meklē SELL';
    confidence = 0.85;
  } else if (dipInRally) {
    chapter = 'DIP_IN_RALLY';
    allow = 'BUY';
    summary_lv = 'STĀSTS · īss dip rallijā · NEPĀRDOT · meklē BUY pullback';
    confidence = 0.85;
  } else if (sellStruct && (recentSell || net < 0)) {
    // At floor still a selloff — do NOT open BOTH (that re-arms bounce BUY knives)
    chapter = pos <= 0.2 ? 'EXHAUST_LO' : 'SELLOFF';
    allow = 'SELL';
    summary_lv =
      chapter === 'EXHAUST_LO'
        ? 'STĀSTS · selloff pie zonas grīdas · meklē SELL · BUY tikai failed-break / reversal'
        : 'STĀSTS · 30m selloff (LH+LL / lejup) · tikai SELL · nepirkt';
    confidence = 0.75;
  } else if (buyStruct && (recentBuy || net > 0)) {
    chapter = pos >= 0.8 ? 'EXHAUST_HI' : 'RALLY';
    allow = 'BUY';
    summary_lv =
      chapter === 'EXHAUST_HI'
        ? 'STĀSTS · rally pie zonas griestiem · meklē BUY · SELL tikai failed-break / reversal'
        : 'STĀSTS · 30m rally (HH+HL / augšup) · tikai BUY · nepārdot';
    confidence = 0.75;
  } else if (net < 0 && red >= green + 1) {
    // Soft sell path when swings unclear
    chapter = 'SELLOFF';
    allow = 'SELL';
    summary_lv = 'STĀSTS · 30m ceļš lejup · tikai SELL · nepirkt bounce';
    confidence = 0.65;
  } else if (net > 0 && green >= red + 1) {
    chapter = 'RALLY';
    allow = 'BUY';
    summary_lv = 'STĀSTS · 30m ceļš augšup · tikai BUY · nepārdot dip';
    confidence = 0.65;
  } else {
    chapter = 'RANGE_CHOP';
    allow = 'BOTH';
    summary_lv = 'STĀSTS · 30m chop zonā · fade tikai pie malām · mid = gaidi';
    confidence = 0.5;
  }

  const detail = [
    `net=${net.toFixed(2)}pt`,
    `1m R/G=${red}/${green}`,
    `recent5 R/G=${redR}/${greenR}`,
    `swing=${swing}`,
    zone ? `pos=${pos.toFixed(2)} ${zone.band}` : 'pos=—',
    `hi=${hi.toFixed(2)} lo=${lo.toFixed(2)}`,
  ].join(' · ');

  return {
    chapter,
    allow,
    summary_lv,
    detail,
    confidence,
    zone_pos: zone?.pos ?? null,
    net_pts: net,
    red_1m: red,
    green_1m: green,
    swing,
  };
}

export function storyAllowsDirection(
  story: MarketStory,
  direction: 'BUY' | 'SELL',
  regime?: string | null
): { ok: true } | { ok: false; reason: string } {
  const r = String(regime || '').toUpperCase();
  if (direction === 'BUY' && (r === 'FAILED_BREAKOUT_DOWN' || r === 'REVERSAL_CANDIDATE')) {
    return { ok: true };
  }
  if (direction === 'SELL' && (r === 'FAILED_BREAKOUT_UP' || r === 'REVERSAL_CANDIDATE')) {
    return { ok: true };
  }

  if (story.allow === 'BOTH' || story.allow === direction) return { ok: true };
  if (story.allow === 'NONE') {
    return { ok: false, reason: `${story.summary_lv} · nav puses` };
  }
  return {
    ok: false,
    reason: `${story.summary_lv} · bloķē ${direction} (stāsts=${story.chapter})`,
  };
}

export const STORY_ZONE_BARS = ZONE_BARS;
