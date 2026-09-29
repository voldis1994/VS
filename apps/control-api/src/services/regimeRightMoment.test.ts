/**
 * End-to-end: at each market moment, classify + stabilize + story + playbook
 * must agree on the right regime — no dwell lag, no fake EXHAUST→TREND on thin chop.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  classifyRegime,
  stabilizeRegime,
  MIN_BARS_FOR_ZONE,
  type RegimeName,
} from './regimes.js';
import { pickEntryPlaybook, setupAllowedOnLane } from './entryPlaybook.js';
import { readMarketStory } from './marketStory.js';
import { decideEntryWithStructure } from './structureEntry.js';
import { _setTradeOpenAtStartForTests } from './tradeOpenPolicy.js';
import type { TenSecBar } from './tenSecondOhlc.js';

_setTradeOpenAtStartForTests(false);

function bar(o: number, h: number, l: number, c: number, i: number): TenSecBar {
  return {
    open_time_ms: 1_700_000_000_000 + i * 10_000,
    open: o,
    high: h,
    low: l,
    close: c,
    ticks: 8,
  };
}

function quiet(c: number, i: number, wobble = 0.15): TenSecBar {
  return bar(c, c + wobble, c - wobble, c + ((i % 3) - 1) * 0.04, i);
}

function liveFrom(bars: TenSecBar[], prev: RegimeName, barsInCurrent = 90): RegimeName {
  const raw = classifyRegime(bars, prev);
  const book = {
    current: prev,
    previous: 'UNKNOWN' as RegimeName,
    bars_in_current: barsInCurrent,
    pending: null as RegimeName | null,
    pending_count: 0,
    since: new Date().toISOString(),
  };
  return stabilizeRegime(book, raw);
}

describe('regime at the right market moment', () => {
  beforeEach(() => {
    _setTradeOpenAtStartForTests(false);
  });

  it('A: local sell-break of shelf → BREAKOUT_DOWN + BREAKOUT lane (no RANGE fade)', () => {
    const bars: TenSecBar[] = [];
    const n = MIN_BARS_FOR_ZONE + 80;
    for (let i = 0; i < n; i++) {
      let c: number;
      if (i < 40) c = 4160 - (i / 39) * 10;
      else if (i < n - 8) c = 4151.5 + ((i % 5) - 2) * 0.35;
      else c = 4148.5 - (i - (n - 8)) * 0.4;
      bars.push(quiet(c, i, 0.2));
    }
    const tip = bars[bars.length - 1]!.close;
    bars.push(bar(tip + 0.4, tip + 0.5, tip - 3.5, tip - 3.2, n));

    const live = liveFrom(bars, 'RANGE');
    expect(live).toBe('BREAKOUT_DOWN');
    const story = readMarketStory(bars, bars[bars.length - 1]!);
    expect(story.chapter).toBe('BREAK_DOWN');
    const pb = pickEntryPlaybook({
      liveRegime: live,
      story,
      htf: { tf30: 'DOWN', tf15: 'DOWN', tf5: 'DOWN', m1: 'DOWN' },
    });
    expect(pb.lane).toBe('BREAKOUT');
    expect(setupAllowedOnLane(pb.lane, 'FADE')).toBe(false);
  });

  it('B: first green bounce after dump → WAIT (no RANGE SELL / no knife BUY)', () => {
    const bars: TenSecBar[] = [];
    const n = MIN_BARS_FOR_ZONE + 60;
    for (let i = 0; i < n; i++) {
      bars.push(quiet(4160 - (i / (n - 1)) * 14, i));
    }
    const tip = bars[bars.length - 1]!.close;
    bars.push(bar(tip, tip + 1.2, tip - 0.1, tip + 1.0, n));

    const live = liveFrom(bars, 'BREAKOUT_DOWN');
    const last = bars[bars.length - 1]!;
    const sig = decideEntryWithStructure({
      bar: last,
      regime: live,
      closedBars: bars,
      capital_m1_dir: 'FLAT',
      capital_tf5_dir: 'DOWN',
      capital_tf15_dir: 'DOWN',
      capital_tf30_dir: 'DOWN',
    });
    expect(sig).toBeNull();
  });

  it('C: true mid-zone thin chop → RANGE story + RANGE_FADE (never fake EXHAUST→TREND)', () => {
    const bars: TenSecBar[] = [];
    const n = MIN_BARS_FOR_ZONE + 40;
    for (let i = 0; i < n; i++) {
      bars.push(quiet(4150 + Math.sin(i / 4) * 1.5, i, 0.25));
    }
    const tip = bars[bars.length - 1]!.close;
    bars.push(bar(tip, tip + 0.35, tip - 0.1, tip + 0.28, n));

    const live = liveFrom(bars, 'RANGE');
    expect(live).toBe('RANGE');
    const story = readMarketStory(bars, bars[bars.length - 1]!);
    expect(story.chapter).toBe('RANGE_CHOP');
    expect(story.allow).toBe('NONE');
    const pb = pickEntryPlaybook({
      liveRegime: live,
      story,
      htf: { tf30: 'FLAT', tf15: 'FLAT', tf5: 'FLAT', m1: 'FLAT' },
    });
    expect(pb.lane).toBe('RANGE_FADE');
    expect(pb.regime).toBe('RANGE');
    expect(setupAllowedOnLane(pb.lane, 'FADE')).toBe(true);
  });

  it('D: quiet grind UP from RANGE → live TREND_UP immediately (strong switch, no dwell lag)', () => {
    const bars: TenSecBar[] = [];
    const n = MIN_BARS_FOR_ZONE + 50;
    for (let i = 0; i < n; i++) {
      bars.push(quiet(4150 + (i / (n - 1)) * 18, i, 0.2));
    }
    // Short dwell would previously leave live=RANGE while classify=TREND_UP
    const live = liveFrom(bars, 'RANGE', 2);
    expect(live).toBe('TREND_UP');
    const pb = pickEntryPlaybook({
      liveRegime: live,
      story: readMarketStory(bars, bars[bars.length - 1]!),
      htf: { tf30: 'UP', tf15: 'UP', tf5: 'UP', m1: 'UP' },
    });
    expect(pb.lane).toBe('TREND_PULLBACK');
    expect(pb.regime).toBe('TREND_UP');
    expect(setupAllowedOnLane(pb.lane, 'FADE')).toBe(false);
  });

  it('E: bounce then 1m DOWN resume → TREND_DOWN playbook (not RANGE fade)', () => {
    const bars: TenSecBar[] = [];
    const n = MIN_BARS_FOR_ZONE + 60;
    for (let i = 0; i < n; i++) {
      bars.push(quiet(4160 - (i / (n - 1)) * 12, i));
    }
    let t = bars[bars.length - 1]!.close;
    bars.push(bar(t, t + 1.5, t - 0.1, t + 1.2, n));
    t = bars[bars.length - 1]!.close;
    bars.push(bar(t, t + 0.1, t - 1.8, t - 1.5, n + 1));

    const live = liveFrom(bars, 'TREND_DOWN');
    expect(live).toBe('TREND_DOWN');
    const pb = pickEntryPlaybook({
      liveRegime: live,
      story: readMarketStory(bars, bars[bars.length - 1]!),
      htf: { tf30: 'DOWN', tf15: 'DOWN', tf5: 'DOWN', m1: 'DOWN' },
    });
    expect(pb.lane).toBe('TREND_PULLBACK');
    expect(setupAllowedOnLane(pb.lane, 'FADE')).toBe(false);
  });

  it('F: BREAKOUT candidate skips dwell even with short bars_in_current', () => {
    const bars: TenSecBar[] = [];
    const n = MIN_BARS_FOR_ZONE + 80;
    for (let i = 0; i < n; i++) {
      let c: number;
      if (i < 40) c = 4160 - (i / 39) * 10;
      else if (i < n - 8) c = 4151.5 + ((i % 5) - 2) * 0.35;
      else c = 4148.5 - (i - (n - 8)) * 0.4;
      bars.push(quiet(c, i, 0.2));
    }
    const tip = bars[bars.length - 1]!.close;
    bars.push(bar(tip + 0.4, tip + 0.5, tip - 3.5, tip - 3.2, n));
    expect(liveFrom(bars, 'RANGE', 5)).toBe('BREAKOUT_DOWN');
  });
});
