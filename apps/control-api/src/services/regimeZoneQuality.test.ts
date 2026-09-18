/**
 * Zone + regime quality probe — synthetic Gold ~2000 10s paths.
 * Scores whether structure zone (≈30m) and stabilize produce usable market state.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  classifyRegime,
  observeClosedBars,
  resetRegimeBook,
  stabilizeRegime,
  MIN_BARS_FOR_ZONE,
  type RegimeName,
} from './regimes.js';
import {
  COMPRESS_ABS,
  EXPAND_ABS,
  MOVE,
  MOVE_RANGE,
  PULLBACK,
  TREND_ENTER,
  TREND_STAY,
} from './regimeBands.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import { bodyPct, expandMinutesToTen, rangePct } from './tenSecondOhlc.js';

function bar(open: number, high: number, low: number, close: number, i = 0): TenSecBar {
  return { open_time_ms: i * 10_000, open, high, low, close, ticks: 10 };
}

/** Walk closes into OHLC with small wicks — Gold-like. */
function path(closes: number[], startI = 0): TenSecBar[] {
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1]!;
    const hi = Math.max(prev, c) + 0.15;
    const lo = Math.min(prev, c) - 0.15;
    return bar(prev, hi, lo, c, startI + i);
  });
}

function withFloor(signal: number[]): number[] {
  const base = signal[0] ?? 2650;
  // Full floor then signal — observe needs bars after thin-book gate for dwell/confirm
  const pad = Array.from({ length: MIN_BARS_FOR_ZONE }, (_, i) =>
    base + ((i % 5) - 2) * 0.04
  );
  return [...pad, ...signal];
}

function feed(epic: string, bars: TenSecBar[], accountId = 1): RegimeName[] {
  const seen: RegimeName[] = [];
  for (const b of bars) {
    const snap = observeClosedBars(epic, [b], 'Gold', accountId);
    seen.push(snap.current);
  }
  return seen;
}

describe('zone + regime quality probe (Gold ~2000)', () => {
  beforeEach(() => resetRegimeBook());

  it('ZONE (~30m / 180 bars): RANGE holds inside structure; breakout needs pierce + expansion', () => {
    // Flat chop inside 2648–2652 for ~30m of 10s bars
    const base = 2650;
    const chop: number[] = [];
    for (let i = 0; i < 190; i++) {
      chop.push(base + ((i % 4) - 1.5) * 0.35);
    }
    const hist = path(chop);
    let last: RegimeName = 'UNKNOWN';
    for (const b of hist) {
      last = observeClosedBars('GOLD', [b], 'Gold', 1).current;
    }
    expect(['RANGE', 'COMPRESSION', 'TREND_UP', 'TREND_DOWN']).toContain(last);
    // Quiet mid-zone should not be BREAKOUT
    expect(last).not.toMatch(/BREAKOUT/);

    // Explosive pierce above zone high
    const lastClose = chop[chop.length - 1]!;
    const boom = path(
      [lastClose, lastClose + 1.2, lastClose + 2.8, lastClose + 4.5],
      hist.length
    );
    const after = feed('GOLD', boom, 1);
    const end = after[after.length - 1]!;
    // Should leave pure RANGE — expansion / breakout / trend up family
    expect(['BREAKOUT_UP', 'EXPANSION', 'TREND_UP', 'PULLBACK_UPTREND']).toContain(end);
  });

  it('persistent rally → TREND_UP (stabilized), not 10s flicker through catalog', () => {
    // Floor + steps ≥ TREND_ENTER so enter-band fires after zone warmup
    const closes = withFloor([
      2640, 2641.1, 2642.3, 2643.5, 2644.8, 2646.1, 2647.4, 2648.8, 2650.2, 2651.6,
    ]);
    const seq = feed('GOLD', path(closes), 2);
    const unique = new Set(seq);
    expect(unique.size).toBeLessThanOrEqual(4);
    expect(seq[seq.length - 1]).toBe('TREND_UP');
    const afterTrend = seq.slice(seq.indexOf('TREND_UP'));
    expect(afterTrend.some((r) => r === 'TREND_DOWN' || r === 'BREAKOUT_DOWN')).toBe(false);
  });

  it('MINUTE expand fills ~30m zone seed (6×10s per minute)', () => {
    const mins = Array.from({ length: 30 }, (_, i) => ({
      open: 2650 + i * 0.1,
      high: 2650 + i * 0.1 + 0.2,
      low: 2650 + i * 0.1 - 0.1,
      close: 2650 + i * 0.1 + 0.05,
    }));
    const bars = expandMinutesToTen(mins, 1_700_000_000_000);
    expect(bars.length).toBe(180);
    expect(bars.length).toBeGreaterThanOrEqual(MIN_BARS_FOR_ZONE);
  });

  it('pullback inside uptrend zone stays out of DOWN family', () => {
    const up = withFloor([2640, 2641, 2642, 2643, 2644, 2645, 2646, 2647]);
    feed('GOLD', path(up), 3);
    const dip = path(
      [2647, 2646.2, 2645.5, 2645.2, 2645.0, 2645.4, 2646.4, 2647.2],
      up.length
    );
    const seq = feed('GOLD', dip, 3);
    expect(seq.some((r) => r === 'TREND_DOWN' || r === 'BREAKOUT_DOWN')).toBe(false);
    expect(seq[seq.length - 1]).toMatch(
      /TREND_UP|PULLBACK_UPTREND|RANGE|COMPRESSION|EXPANSION/
    );
  });

  it('quality scorecard: majority of intended scenarios land in expected family', () => {
    type Case = { name: string; closes: number[]; expectFamily: RegExp };
    const cases: Case[] = [
      {
        name: 'rally',
        closes: withFloor([2600, 2601, 2602.2, 2603.5, 2604.8, 2606, 2607.2, 2608.5]),
        expectFamily: /TREND_UP|BREAKOUT_UP|EXPANSION|PULLBACK_UPTREND/,
      },
      {
        name: 'selloff',
        closes: withFloor([2608, 2607, 2605.8, 2604.5, 2603.2, 2602, 2600.8, 2599.5]),
        expectFamily: /TREND_DOWN|BREAKOUT_DOWN|EXPANSION|PULLBACK_DOWNTREND/,
      },
      {
        name: 'range',
        closes: withFloor([
          2650, 2650.4, 2649.7, 2650.3, 2649.8, 2650.2, 2649.9, 2650.1, 2650.0, 2650.15,
        ]),
        expectFamily: /RANGE|COMPRESSION/,
      },
    ];
    let hit = 0;
    for (const c of cases) {
      resetRegimeBook();
      const seq = feed(`G-${c.name}`, path(c.closes), hit + 10);
      const end = seq[seq.length - 1]!;
      if (c.expectFamily.test(end)) hit += 1;
    }
    expect(hit).toBeGreaterThanOrEqual(2);
  });

  it('dwell+confirm: soft CHOP noise does not flip every bar', () => {
    const seed = path([2650, 2650.4, 2650.9, 2651.3, 2651.8, 2652.2]);
    feed('GOLD', seed, 4);
    // Tiny alternating noise ~1m
    const noise = path(
      [2652.2, 2652.05, 2652.25, 2652.1, 2652.3, 2652.15],
      seed.length
    );
    const seq = feed('GOLD', noise, 4);
    const flips = seq.filter((r, i) => i > 0 && r !== seq[i - 1]).length;
    expect(flips).toBeLessThanOrEqual(2);
  });

  it('same-family TREND↔PULLBACK waits for dwell (no 10s recipe flicker)', () => {
    const book = {
      current: 'TREND_UP' as RegimeName,
      previous: 'UNKNOWN' as RegimeName,
      bars_in_current: 2, // before dwell
      pending: null as RegimeName | null,
      pending_count: 0,
      since: new Date().toISOString(),
    };
    expect(stabilizeRegime(book, 'PULLBACK_UPTREND')).toBe('TREND_UP');
    expect(book.pending).toBe('PULLBACK_UPTREND');
  });

  it('quiet structural pierce out of chop → BREAKOUT_UP (not sticky RANGE)', () => {
    const closes: number[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) closes.push(2650 + (i % 3) * 0.15);
    const bars = path(closes);
    const zonePrior = bars.slice(0, -1);
    const hi = Math.max(...zonePrior.map((b) => b.high));
    const lo = Math.min(...zonePrior.map((b) => b.low));
    const width = Math.max(hi - lo, 1e-9);
    // Clear ≥25% zone pierce + body ≥ TREND_ENTER
    const pierce = hi + Math.max(width * 0.3, 2650 * TREND_ENTER * 1.2);
    const open = hi - 0.02;
    const last = bar(open, pierce + 0.05, open - 0.02, pierce, bars.length);
    const raw = classifyRegime([...bars.slice(0, -1), last], 'RANGE');
    expect(raw).toBe('BREAKOUT_UP');
  });

  it('raw classify uses zone hi/lo (not last micro-candle only)', () => {
    // Build a clear zone then one quiet bar mid-zone
    const closes: number[] = [];
    for (let i = 0; i < MIN_BARS_FOR_ZONE; i++) closes.push(2650 + Math.sin(i) * 0.8);
    const bars = path(closes);
    const last = bars[bars.length - 1]!;
    const zonePrior = bars.slice(-180, -1);
    const hi = Math.max(...zonePrior.map((b) => b.high));
    const lo = Math.min(...zonePrior.map((b) => b.low));
    expect(last.close).toBeGreaterThanOrEqual(lo);
    expect(last.close).toBeLessThanOrEqual(hi);
    const raw = classifyRegime(bars, 'RANGE');
    expect(['RANGE', 'COMPRESSION', 'TREND_UP', 'TREND_DOWN', 'EXPANSION']).toContain(raw);
    expect(raw).not.toMatch(/^BREAKOUT_/);
  });

  it('ultra-tight mid-zone → COMPRESSION; mild quiet → RANGE (no starve)', () => {
    const wideCloses = withFloor([2650, 2651, 2650.2, 2651.1, 2650.4, 2650.9, 2650.5, 2650.8]);
    const wide = path(wideCloses);
    // Last bar extremely tight near mid
    const tight = bar(2650.6, 2650.62, 2650.58, 2650.6, wide.length);
    const raw = classifyRegime([...wide, tight], 'RANGE');
    expect(['COMPRESSION', 'RANGE']).toContain(raw);
  });

  it('body/range scales: Gold quiet bar stays below MOVE', () => {
    const quiet = bar(2650, 2650.08, 2649.95, 2650.05);
    expect(Math.abs(bodyPct(quiet))).toBeLessThan(MOVE);
    expect(rangePct(quiet)).toBeLessThan(MOVE_RANGE);
  });

  it('percent bands have gaps — shared ladder compress < move < enter < expand', () => {
    expect(COMPRESS_ABS).toBeLessThan(MOVE);
    expect(EXPAND_ABS).toBeGreaterThan(TREND_ENTER);
    expect(PULLBACK).toBeGreaterThan(TREND_ENTER);
    expect(TREND_STAY).toBeGreaterThan(MOVE);
  });
});
