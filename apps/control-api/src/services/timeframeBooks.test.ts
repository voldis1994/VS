/**
 * Multi-TF historical books, boundaries, look-ahead, seed readiness.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateAligned,
  alignBucketMs,
  buildHtfContextFromBooks,
  closedBarsOnly,
  emptyMultiTfState,
  evaluateMultiTfReady,
  evaluateTfBook,
  mergeUniqueBars,
  TF_MS,
  TF_MIN_CLOSED,
  type TfBar,
} from './timeframeBooks.js';
import { capitalCandlesToTfBars } from './seedMultiTf.js';
import { aggregateTenSecToFiveMin } from './fiveMinuteBrain.js';
import { allowEntryFromDataQuality } from './dataQuality.js';
import { decideEntryFrom10sRegime } from './entryFromRegime.js';
import { buildBoStateFromOpen, loadBoState, saveBoState, resetTradeRecoveryStore } from './tradeRecovery.js';
import type { CapitalPriceCandle } from './capitalCom.js';

function mkBar(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  opts?: Partial<TfBar>
): TfBar {
  return {
    open_time_ms: t,
    open: o,
    high: h,
    low: l,
    close: c,
    ticks: 1,
    provenance: 'REAL',
    forming: false,
    ...opts,
  };
}

describe('timeframe boundaries', () => {
  it('aligns to clock buckets', () => {
    expect(alignBucketMs(1_700_000_123, TF_MS['5m'])).toBe(Math.floor(1_700_000_123 / 300_000) * 300_000);
    expect(alignBucketMs(1_700_000_000, TF_MS['1H']) % TF_MS['1H']).toBe(0);
  });

  it('aggregateAligned uses 5m clock boundaries not raw slice count', () => {
    const now = Date.UTC(2024, 0, 2, 12, 0, 0);
    const bars: TfBar[] = [];
    // 12 minutes of 1m bars aligned — complete 5m buckets only
    for (let i = 0; i < 12; i++) {
      const t = now - (12 - i) * 60_000;
      const aligned = alignBucketMs(t, TF_MS['1m']);
      bars.push(mkBar(aligned, 100 + i, 101 + i, 99 + i, 100.5 + i));
    }
    const five = aggregateAligned(bars, '1m', '5m', now);
    expect(five.length).toBeGreaterThanOrEqual(1);
    for (const b of five) {
      expect(b.open_time_ms % TF_MS['5m']).toBe(0);
      expect(b.open_time_ms + TF_MS['5m']).toBeLessThanOrEqual(now);
    }
  });

  it('does not compress gapped 1m into fake 5m', () => {
    const now = Date.UTC(2024, 0, 2, 12, 0, 0);
    const bucket = now - 300_000;
    const bars = [0, 1, 2, 4].map((i) => mkBar(bucket + i * 60_000, 100, 101, 99, 100));
    expect(aggregateAligned(bars, '1m', '5m', now)).toHaveLength(0);
  });

  it('excludes forming higher-TF bucket (look-ahead prevention)', () => {
    const now = Date.UTC(2024, 0, 2, 12, 3, 0); // mid 5m bucket 12:00-12:05
    const bucket = alignBucketMs(now, TF_MS['5m']);
    const bars: TfBar[] = [];
    for (let i = 0; i < 3; i++) {
      bars.push(mkBar(bucket + i * 60_000, 100, 101, 99, 100.5));
    }
    const five = aggregateAligned(bars, '1m', '5m', now);
    expect(five.find((b) => b.open_time_ms === bucket)).toBeUndefined();
  });
});

describe('closed vs forming + duplicates/gaps', () => {
  it('closedBarsOnly drops forming candle', () => {
    const now = 1_000_000;
    const bars = [
      mkBar(now - 300_000, 1, 2, 0.5, 1.5),
      mkBar(now - 10_000, 1.5, 2, 1, 1.8, { forming: true }),
    ];
    const closed = closedBarsOnly(bars, now, '5m');
    expect(closed.every((b) => !b.forming)).toBe(true);
    expect(closed.length).toBe(1);
  });

  it('evaluateTfBook not ready with gaps/duplicates/short history', () => {
    const short = [mkBar(0, 1, 2, 0.5, 1.5), mkBar(300_000, 1.5, 2, 1, 1.8)];
    const book = evaluateTfBook('5m', short, 'CAPITAL_NATIVE', 10_000_000);
    expect(book.ready).toBe(false);
    expect(book.bars.length).toBeLessThan(TF_MIN_CLOSED['5m']);
  });

  it('mergeUniqueBars prefers REAL over SYNTHETIC', () => {
    const a = [mkBar(0, 1, 2, 0.5, 1, { provenance: 'SYNTHETIC' })];
    const b = [mkBar(0, 1, 2.2, 0.4, 1.1, { provenance: 'REAL' })];
    const m = mergeUniqueBars(a, b);
    expect(m).toHaveLength(1);
    expect(m[0]!.provenance).toBe('REAL');
    expect(m[0]!.high).toBe(2.2);
  });
});

describe('historical → LIVE readiness gate', () => {
  it('ENTRY blocked until all TF books ready', () => {
    let state = emptyMultiTfState();
    expect(evaluateMultiTfReady(state).ready).toBe(false);

    const fill = (tf: '1m' | '5m' | '15m' | '1H' | '4H', n: number, step: number) => {
      const bars: TfBar[] = [];
      const now = Date.now();
      for (let i = 0; i < n; i++) {
        const t = alignBucketMs(now - (n - i) * step, step);
        bars.push(mkBar(t, 100 + i * 0.01, 100.2 + i * 0.01, 99.8 + i * 0.01, 100.1 + i * 0.01));
      }
      state.books[tf] = evaluateTfBook(tf, bars, 'CAPITAL_NATIVE', now);
    };
    fill('1m', 40, TF_MS['1m']);
    fill('5m', 50, TF_MS['5m']);
    fill('15m', 40, TF_MS['15m']);
    fill('1H', 30, TF_MS['1H']);
    fill('4H', 25, TF_MS['4H']);
    state = evaluateMultiTfReady(state);
    expect(state.ready).toBe(true);

    const live = {
      open_time_ms: Date.now(),
      open: 100,
      high: 100.2,
      low: 99.9,
      close: 100.1,
      ticks: 3,
      provenance: 'REAL' as const,
    };
    // Without multiTfReady flag false → null
    expect(
      decideEntryFrom10sRegime(live, 'TREND_UP', [live], { multiTfReady: false })
    ).toBeNull();
  });

  it('capitalCandlesToTfBars marks forming by open_time', () => {
    const now = Date.now();
    const candles: CapitalPriceCandle[] = [
      {
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        open_time_ms: alignBucketMs(now - 600_000, TF_MS['5m']),
      },
      {
        open: 1.5,
        high: 2,
        low: 1,
        close: 1.8,
        open_time_ms: alignBucketMs(now, TF_MS['5m']),
      },
    ];
    const bars = capitalCandlesToTfBars(candles, '5m');
    expect(bars.some((b) => b.forming)).toBe(true);
    expect(bars.some((b) => !b.forming)).toBe(true);
  });

  it('HTF context from books not 10s zone', () => {
    const state = emptyMultiTfState();
    const now = Date.now();
    // Alternating zigzag (not a flat monotonic ramp) so pivotLeft/Right=1 fractal
    // detection inside buildHtfContextFromBooks actually finds HH/HL → trend UP.
    const fillUp = (tf: '4H' | '1H' | '15m', n: number) => {
      const bars: TfBar[] = [];
      for (let i = 0; i < n; i++) {
        const trend = 100 + i * 1.2;
        const t = alignBucketMs(now - (n - i) * TF_MS[tf], TF_MS[tf]);
        if (i % 2 === 0) {
          bars.push(mkBar(t, trend - 0.2, trend + 0.1, trend - 1.5, trend));
        } else {
          bars.push(mkBar(t, trend, trend + 1.5, trend - 0.1, trend + 0.3));
        }
      }
      state.books[tf] = evaluateTfBook(tf, bars, 'CAPITAL_NATIVE', now);
    };
    // buildHtfContextFromBooks requires 4H + 1H + 15m ALL ready — fill every book.
    fillUp('4H', 25);
    fillUp('1H', 30);
    fillUp('15m', 40);
    expect(state.books['4H'].ready).toBe(true);
    expect(state.books['1H'].ready).toBe(true);
    expect(state.books['15m'].ready).toBe(true);
    const htf = buildHtfContextFromBooks(state, 130);
    expect(htf.trend).toBe('UP');
    expect(htf.detail).toMatch(/HTF/);
  });
});

describe('stale + 10s aggregate look-ahead', () => {
  it('stale quote blocked by fetch age', () => {
    const now = Date.now();
    expect(
      allowEntryFromDataQuality(
        { mid: 100, fetch_ms: now - 60_000, source_ms: now - 60_000 },
        { nowMs: now }
      ).ok
    ).toBe(false);
  });

  it('10s→5m aggregate skips current forming bucket and requires full coverage', () => {
    const now = Date.UTC(2024, 5, 1, 10, 2, 30);
    const bucket = alignBucketMs(now, TF_MS['5m']);
    const tens = [];
    for (let i = 0; i < 30; i++) {
      tens.push({
        open_time_ms: bucket - 300_000 + i * 10_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        ticks: 2,
        provenance: 'REAL' as const,
      });
    }
    // forming bucket bars (incomplete + look-ahead)
    for (let i = 0; i < 10; i++) {
      tens.push({
        open_time_ms: bucket + i * 10_000,
        open: 200,
        high: 201,
        low: 199,
        close: 200.5,
        ticks: 2,
        provenance: 'REAL' as const,
      });
    }
    const five = aggregateTenSecToFiveMin(tens, 30, now);
    expect(five.every((b) => b.open_time_ms !== bucket)).toBe(true);
    expect(five.every((b) => b.close < 150)).toBe(true); // no look-ahead into 200s
    expect(five.length).toBeGreaterThanOrEqual(1);
  });
});

describe('BO close_phase persist + recovery', () => {
  it('preserves CLOSE_UNCERTAIN on save', () => {
    resetTradeRecoveryStore();
    const st = buildBoStateFromOpen({
      deal_id: 'D1',
      side: 'BUY',
      entry_price: 100,
      close_phase: 'CLOSE_UNCERTAIN',
      epic: 'X',
      account_id: 1,
      robot_id: '1:X',
      mfe: 1,
    });
    saveBoState(st);
    expect(loadBoState('1:X')?.close_phase).toBe('CLOSE_UNCERTAIN');
  });
});
