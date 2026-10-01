/**
 * PROOF audit — regime at the right market moment (full stack).
 *
 * Asserts REAL execution of classify → stabilize → story → playbook → entry.
 * Comments alone cannot make these green.
 *
 * Covers merged contracts from:
 * - #647 range-must-not-block-trend / range-only-when-range
 * - #650 no-range-sell-into-selloff
 * - #651 split-entry-playbook-brains
 * - #652 regime-right-moment (dwell + trekFirm + EXHAUST≠fake TREND)
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  classifyRegime,
  stabilizeRegime,
  MIN_BARS_FOR_ZONE,
  type RegimeName,
} from './regimes.js';
import {
  pickEntryPlaybook,
  setupAllowedOnLane,
  capitalHtfBias,
  type EffectiveRegimeHtf,
} from './entryPlaybook.js';
import { readMarketStory, STORY_MIN_PATH_PCT } from './marketStory.js';
import {
  decideEntryWithStructure,
  effectiveEntryRegime,
} from './structureEntry.js';
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

function liveFrom(bars: TenSecBar[], prev: RegimeName, barsInCurrent = 90): {
  raw: RegimeName;
  live: RegimeName;
} {
  const raw = classifyRegime(bars, prev);
  const book = {
    current: prev,
    previous: 'UNKNOWN' as RegimeName,
    bars_in_current: barsInCurrent,
    pending: null as RegimeName | null,
    pending_count: 0,
    since: new Date().toISOString(),
  };
  const live = stabilizeRegime(book, raw);
  return { raw, live };
}

function shelfSellBreak(): TenSecBar[] {
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
  return bars;
}

function thinChop(): TenSecBar[] {
  const bars: TenSecBar[] = [];
  const n = MIN_BARS_FOR_ZONE + 40;
  for (let i = 0; i < n; i++) {
    bars.push(quiet(4150 + Math.sin(i / 4) * 1.5, i, 0.25));
  }
  const tip = bars[bars.length - 1]!.close;
  bars.push(bar(tip, tip + 0.35, tip - 0.1, tip + 0.28, n));
  return bars;
}

function grindUp(): TenSecBar[] {
  const bars: TenSecBar[] = [];
  const n = MIN_BARS_FOR_ZONE + 50;
  for (let i = 0; i < n; i++) {
    bars.push(quiet(4150 + (i / (n - 1)) * 18, i, 0.2));
  }
  return bars;
}

function dumpThenBounce(): TenSecBar[] {
  const bars: TenSecBar[] = [];
  const n = MIN_BARS_FOR_ZONE + 60;
  for (let i = 0; i < n; i++) {
    bars.push(quiet(4160 - (i / (n - 1)) * 14, i));
  }
  const tip = bars[bars.length - 1]!.close;
  bars.push(bar(tip, tip + 1.2, tip - 0.1, tip + 1.0, n));
  return bars;
}

function dumpBounceResume(): TenSecBar[] {
  const bars = dumpThenBounce();
  let t = bars[bars.length - 1]!.close;
  const i = bars.length;
  bars.push(bar(t, t + 0.1, t - 1.8, t - 1.5, i));
  return bars;
}

const HTF_DOWN: EffectiveRegimeHtf = {
  tf30: 'DOWN',
  tf15: 'DOWN',
  tf5: 'DOWN',
  m1: 'DOWN',
};
const HTF_UP: EffectiveRegimeHtf = {
  tf30: 'UP',
  tf15: 'UP',
  tf5: 'UP',
  m1: 'UP',
};
const HTF_FLAT: EffectiveRegimeHtf = {
  tf30: 'FLAT',
  tf15: 'FLAT',
  tf5: 'FLAT',
  m1: 'FLAT',
};

describe('PROOF AUDIT: regime at the right market moment — full stack', () => {
  beforeEach(() => {
    _setTradeOpenAtStartForTests(false);
  });

  // ─── 1. Classify + stabilize (right moment) ───────────────────────────

  describe('1 · classify + stabilize at the right moment', () => {
    it('sell-break shelf → raw+live BREAKOUT_DOWN (strong switch, no dwell)', () => {
      const bars = shelfSellBreak();
      const { raw, live } = liveFrom(bars, 'RANGE', 5);
      expect(raw).toBe('BREAKOUT_DOWN');
      expect(live).toBe('BREAKOUT_DOWN');
    });

    it('quiet grind UP → live TREND_UP even with short dwell (chop→trend strong)', () => {
      const bars = grindUp();
      const { raw, live } = liveFrom(bars, 'RANGE', 2);
      expect(raw).toBe('TREND_UP');
      expect(live).toBe('TREND_UP');
    });

    it('thin mid-zone sine → live RANGE (not TREND)', () => {
      const { live } = liveFrom(thinChop(), 'RANGE');
      expect(live).toBe('RANGE');
    });

    it('COMPRESSION → TREND_DOWN is also strong switch', () => {
      const book = {
        current: 'COMPRESSION' as RegimeName,
        previous: 'UNKNOWN' as RegimeName,
        bars_in_current: 1,
        pending: null as RegimeName | null,
        pending_count: 0,
        since: new Date().toISOString(),
      };
      expect(stabilizeRegime(book, 'TREND_DOWN')).toBe('TREND_DOWN');
    });
  });

  // ─── 2. Market story (trekFirm — no fake EXHAUST) ─────────────────────

  describe('2 · market story trekFirm', () => {
    it('thin chop trek < trekFirm → RANGE_CHOP allow=NONE (never EXHAUST/RALLY)', () => {
      const bars = thinChop();
      const last = bars[bars.length - 1]!;
      const story = readMarketStory(bars, last);
      const trekMatch = /trek=([\d.]+)pt/.exec(story.detail);
      const trek = trekMatch ? Number(trekMatch[1]) : NaN;
      const minPath = Math.max(3, Math.abs(last.close) * STORY_MIN_PATH_PCT);
      expect(trek).toBeLessThan(minPath * 1.5);
      expect(story.chapter).toBe('RANGE_CHOP');
      expect(story.allow).toBe('NONE');
    });

    it('real sell-break story is BREAK_DOWN SELL (not RANGE_CHOP)', () => {
      const bars = shelfSellBreak();
      const story = readMarketStory(bars, bars[bars.length - 1]!);
      expect(story.chapter).toBe('BREAK_DOWN');
      expect(story.allow).toBe('SELL');
    });
  });

  // ─── 3. Playbook brains (who looks at what) ───────────────────────────

  describe('3 · playbook lanes — who looks at what', () => {
    it('BREAKOUT owns sell-break — FADE blocked', () => {
      const bars = shelfSellBreak();
      const { live } = liveFrom(bars, 'RANGE');
      const story = readMarketStory(bars, bars[bars.length - 1]!);
      const pb = pickEntryPlaybook({ liveRegime: live, story, htf: HTF_DOWN });
      expect(pb.lane).toBe('BREAKOUT');
      expect(pb.regime).toBe('BREAKOUT_DOWN');
      expect(setupAllowedOnLane(pb.lane, 'FADE')).toBe(false);
      expect(setupAllowedOnLane(pb.lane, 'BREAKOUT')).toBe(true);
    });

    it('Capital HTF DOWN on live chop stays RANGE_FADE (SIDE before HTF)', () => {
      const pb = pickEntryPlaybook({
        liveRegime: 'RANGE',
        story: { allow: 'NONE', chapter: 'RANGE_CHOP' },
        htf: HTF_DOWN,
      });
      expect(pb.lane).toBe('RANGE_FADE');
      expect(pb.regime).toBe('RANGE');
      expect(setupAllowedOnLane(pb.lane, 'FADE')).toBe(true);
      expect(capitalHtfBias(HTF_DOWN)).toBe('DOWN');
    });

    it('RANGE_FADE only when HTF flat + chop story', () => {
      const pb = pickEntryPlaybook({
        liveRegime: 'RANGE',
        story: { allow: 'NONE', chapter: 'RANGE_CHOP' },
        htf: HTF_FLAT,
      });
      expect(pb.lane).toBe('RANGE_FADE');
      expect(pb.regime).toBe('RANGE');
      expect(setupAllowedOnLane(pb.lane, 'FADE')).toBe(true);
    });

    it('EXHAUST_HI + flat HTF → RANGE_FADE (not fake TREND_UP)', () => {
      const pb = pickEntryPlaybook({
        liveRegime: 'RANGE',
        story: { allow: 'BUY', chapter: 'EXHAUST_HI' },
        htf: HTF_FLAT,
      });
      expect(pb.lane).toBe('RANGE_FADE');
      expect(pb.regime).toBe('RANGE');
    });

    it('live TREND never demoted by chop story or opposing HTF', () => {
      expect(
        pickEntryPlaybook({
          liveRegime: 'TREND_UP',
          story: { allow: 'NONE', chapter: 'RANGE_CHOP' },
          htf: HTF_DOWN,
        }).regime
      ).toBe('TREND_UP');
    });

    it('effectiveEntryRegime delegates to playbook (same contracts)', () => {
      expect(
        effectiveEntryRegime('RANGE', { allow: 'NONE', chapter: 'RANGE_CHOP' }, HTF_UP)
      ).toBe('RANGE');
      expect(
        effectiveEntryRegime('RANGE', { allow: 'BUY', chapter: 'EXHAUST_HI' }, HTF_FLAT)
      ).toBe('RANGE');
      expect(
        effectiveEntryRegime('RANGE', { allow: 'SELL', chapter: 'BREAK_DOWN' })
      ).toBe('BREAKOUT_DOWN');
    });
  });

  // ─── 4. Entry decisions at each market moment ─────────────────────────

  describe('4 · entry at each market moment', () => {
    it('A sell-break + HTF DOWN → SELL BREAKOUT (not RANGE fade)', () => {
      const bars = shelfSellBreak();
      const { live } = liveFrom(bars, 'RANGE');
      const last = bars[bars.length - 1]!;
      const sig = decideEntryWithStructure({
        bar: last,
        regime: live,
        closedBars: bars,
        capital_m1_dir: 'DOWN',
        capital_tf5_dir: 'DOWN',
        capital_tf15_dir: 'DOWN',
        capital_tf30_dir: 'DOWN',
      });
      expect(sig).not.toBeNull();
      expect(sig!.direction).toBe('SELL');
      expect(sig!.setup).toBe('BREAKOUT');
      expect(sig!.reason).not.toMatch(/FADE/i);
    });

    it('B first green bounce after dump → WAIT (no knife)', () => {
      const bars = dumpThenBounce();
      const { live } = liveFrom(bars, 'BREAKOUT_DOWN');
      const sig = decideEntryWithStructure({
        bar: bars[bars.length - 1]!,
        regime: live,
        closedBars: bars,
        capital_m1_dir: 'FLAT',
        capital_tf5_dir: 'DOWN',
        capital_tf15_dir: 'DOWN',
        capital_tf30_dir: 'DOWN',
      });
      expect(sig).toBeNull();
    });

    it('C thin chop + flat HTF → WAIT / no TREND chase', () => {
      const bars = thinChop();
      const { live } = liveFrom(bars, 'RANGE');
      expect(live).toBe('RANGE');
      const story = readMarketStory(bars, bars[bars.length - 1]!);
      expect(story.chapter).toBe('RANGE_CHOP');
      const pb = pickEntryPlaybook({ liveRegime: live, story, htf: HTF_FLAT });
      expect(pb.lane).toBe('RANGE_FADE');
      const sig = decideEntryWithStructure({
        bar: bars[bars.length - 1]!,
        regime: live,
        closedBars: bars,
        capital_m1_dir: 'FLAT',
        capital_tf5_dir: 'FLAT',
        capital_tf15_dir: 'FLAT',
        capital_tf30_dir: 'FLAT',
      });
      // Mid-zone chop must not open a directional TREND/BREAKOUT
      if (sig) {
        expect(sig.setup).not.toBe('BREAKOUT');
        expect(sig.setup).not.toBe('CONTINUATION');
      }
    });

    it('D grind UP playbook is TREND_PULLBACK (FADE blocked)', () => {
      const bars = grindUp();
      const { live } = liveFrom(bars, 'RANGE', 2);
      expect(live).toBe('TREND_UP');
      const pb = pickEntryPlaybook({
        liveRegime: live,
        story: readMarketStory(bars, bars[bars.length - 1]!),
        htf: HTF_UP,
      });
      expect(pb.lane).toBe('TREND_PULLBACK');
      expect(setupAllowedOnLane(pb.lane, 'FADE')).toBe(false);
    });

    it('E bounce then 1m DOWN resume → TREND_DOWN lane (not RANGE fade)', () => {
      const bars = dumpBounceResume();
      const { live } = liveFrom(bars, 'TREND_DOWN');
      expect(live).toBe('TREND_DOWN');
      const pb = pickEntryPlaybook({
        liveRegime: live,
        story: readMarketStory(bars, bars[bars.length - 1]!),
        htf: HTF_DOWN,
      });
      expect(pb.lane).toBe('TREND_PULLBACK');
      expect(setupAllowedOnLane(pb.lane, 'FADE')).toBe(false);
    });
  });

  // ─── 5. Contract matrix (static — no bars) ────────────────────────────

  describe('5 · playbook contract matrix', () => {
    const cases: Array<{
      name: string;
      live: RegimeName;
      chapter: string;
      allow: 'BUY' | 'SELL' | 'BOTH' | 'NONE';
      htf: EffectiveRegimeHtf;
      lane: string;
      regime: RegimeName;
      fadeOk: boolean;
    }> = [
      {
        name: 'BREAK_DOWN story even if live RANGE',
        live: 'RANGE',
        chapter: 'BREAK_DOWN',
        allow: 'SELL',
        htf: HTF_FLAT,
        lane: 'BREAKOUT',
        regime: 'BREAKOUT_DOWN',
        fadeOk: false,
      },
      {
        name: 'BREAK_UP story even if live RANGE',
        live: 'RANGE',
        chapter: 'BREAK_UP',
        allow: 'BUY',
        htf: HTF_FLAT,
        lane: 'BREAKOUT',
        regime: 'BREAKOUT_UP',
        fadeOk: false,
      },
      {
        name: 'HTF UP + chop → RANGE_FADE (SIDE before HTF)',
        live: 'RANGE',
        chapter: 'RANGE_CHOP',
        allow: 'NONE',
        htf: HTF_UP,
        lane: 'RANGE_FADE',
        regime: 'RANGE',
        fadeOk: true,
      },
      {
        name: 'BOUNCE_IN_SELL → PULLBACK_DOWNTREND',
        live: 'RANGE',
        chapter: 'BOUNCE_IN_SELL',
        allow: 'SELL',
        htf: HTF_FLAT,
        lane: 'TREND_PULLBACK',
        regime: 'PULLBACK_DOWNTREND',
        fadeOk: false,
      },
      {
        name: 'DIP_IN_RALLY → PULLBACK_UPTREND',
        live: 'RANGE',
        chapter: 'DIP_IN_RALLY',
        allow: 'BUY',
        htf: HTF_FLAT,
        lane: 'TREND_PULLBACK',
        regime: 'PULLBACK_UPTREND',
        fadeOk: false,
      },
      {
        name: 'true chop only → RANGE_FADE',
        live: 'RANGE',
        chapter: 'RANGE_CHOP',
        allow: 'NONE',
        htf: HTF_FLAT,
        lane: 'RANGE_FADE',
        regime: 'RANGE',
        fadeOk: true,
      },
      {
        name: 'EXHAUST_LO + flat → RANGE_FADE',
        live: 'COMPRESSION',
        chapter: 'EXHAUST_LO',
        allow: 'SELL',
        htf: HTF_FLAT,
        lane: 'RANGE_FADE',
        regime: 'COMPRESSION',
        fadeOk: true,
      },
      {
        name: 'REVERSAL live stays REVERSAL',
        live: 'REVERSAL_CANDIDATE',
        chapter: 'RANGE_CHOP',
        allow: 'NONE',
        htf: HTF_UP,
        lane: 'REVERSAL',
        regime: 'REVERSAL_CANDIDATE',
        fadeOk: false,
      },
    ];

    for (const c of cases) {
      it(c.name, () => {
        const pb = pickEntryPlaybook({
          liveRegime: c.live,
          story: { allow: c.allow, chapter: c.chapter },
          htf: c.htf,
        });
        expect(pb.lane).toBe(c.lane);
        expect(pb.regime).toBe(c.regime);
        expect(setupAllowedOnLane(pb.lane, 'FADE')).toBe(c.fadeOk);
      });
    }
  });
});
