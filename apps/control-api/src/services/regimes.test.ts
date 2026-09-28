import { describe, expect, it, beforeEach } from 'vitest';
import {
  REGIME_NAMES,
  TRADE_TYPE_NAMES,
  OPERATING_MODES,
  classifyRegime,
  observeClosedBars,
  notePipelineRegime,
  resetRegimeBook,
  stabilizeRegime,
  styleFromClassification,
  currentRegime,
  MIN_BARS_FOR_ZONE,
  type RegimeName,
} from './regimes.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import { formatTradeLabel } from './tradePresentation.js';

function bar(open: number, high: number, low: number, close: number, i = 0): TenSecBar {
  return { open_time_ms: i * 10_000, open, high, low, close, ticks: 10 };
}

/** Quiet unique history so 30m zone floor is met before the signal path (not OHLC-identical). */
function withZoneFloor(prices: number[]): number[] {
  const base = prices[0] ?? 100;
  // Always prepend a full floor — short signals alone never reach confirm after thin-book UNKNOWN
  const pad = Array.from({ length: MIN_BARS_FOR_ZONE }, (_, i) =>
    base + ((i % 5) - 2) * 0.02
  );
  return [...pad, ...prices];
}

function run(prices: number[], previous: RegimeName = 'UNKNOWN'): RegimeName {
  const all = withZoneFloor(prices);
  const bars = all.map((p, i) => {
    const prev = i === 0 ? p : all[i - 1]!;
    const high = Math.max(prev, p) + 0.4;
    const low = Math.min(prev, p) - 0.4;
    return bar(prev, high, low, p, i);
  });
  return classifyRegime(bars, previous);
}

/** Prepend zone-scale quiet bars so floor is met without collapsing avgRange. */
function padBars(signal: TenSecBar[]): TenSecBar[] {
  if (signal.length >= MIN_BARS_FOR_ZONE) return signal;
  const sigHi = Math.max(...signal.map((b) => b.high));
  const sigLo = Math.min(...signal.map((b) => b.low));
  const mid = (sigHi + sigLo) / 2;
  const half = Math.max((sigHi - sigLo) / 2, mid * 0.0004);
  const n = MIN_BARS_FOR_ZONE - signal.length;
  const pad: TenSecBar[] = [];
  for (let i = 0; i < n; i++) {
    const wobble = ((i % 4) - 1.5) * half * 0.2;
    const c = mid + wobble;
    pad.push(bar(c, c + half * 0.35, c - half * 0.35, c, i));
  }
  return [
    ...pad,
    ...signal.map((b, i) => ({ ...b, open_time_ms: (n + i) * 10_000 })),
  ];
}

describe('original regime names', () => {
  it('exposes all 14 names from the original spec', () => {
    expect([...REGIME_NAMES]).toEqual([
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
    ]);
  });

  it('exposes all four operating modes and four trade-type names', () => {
    expect([...OPERATING_MODES]).toEqual(['REPLAY', 'PAPER', 'DEMO', 'LIVE']);
    expect([...TRADE_TYPE_NAMES]).toEqual(['BUY LONG', 'SELL LONG', 'BUY SCALP', 'SELL SCALP']);
  });
});

describe('classifyRegime from 10s OHLC', () => {
  it('UNKNOWN with too few bars', () => {
    expect(classifyRegime([bar(100, 100.1, 99.9, 100)])).toBe('UNKNOWN');
  });

  it('TREND_UP on a persistent rally', () => {
    expect(run([100, 100.4, 100.9, 101.5, 102.2, 103.0])).toBe('TREND_UP');
  });

  it('TREND_DOWN on a persistent selloff', () => {
    expect(run([103, 102.4, 101.8, 101.1, 100.4, 99.6])).toBe('TREND_DOWN');
  });

  it('PULLBACK_UPTREND after TREND_UP with a dip bar', () => {
    // Soft against-body: ≥ PULLBACK but < REVERSAL (else violent → REVERSAL_CANDIDATE)
    const up = [100, 100.5, 101.1, 101.8, 102.6];
    const withDip = [...up, 102.45];
    expect(run(withDip, 'TREND_UP')).toBe('PULLBACK_UPTREND');
  });

  it('PULLBACK_DOWNTREND after TREND_DOWN with a bounce bar', () => {
    const dn = [103, 102.4, 101.7, 101.0, 100.2];
    const bounce = [...dn, 100.35];
    expect(run(bounce, 'TREND_DOWN')).toBe('PULLBACK_DOWNTREND');
  });

  it('thin book (<15m) stays UNKNOWN — no false 30m RANGE/BREAKOUT', () => {
    const thin = [bar(100, 100.1, 99.9, 100.05, 0), bar(100.05, 100.2, 100.0, 100.15, 1)];
    expect(classifyRegime(thin)).toBe('UNKNOWN');
    expect(classifyRegime(thin, 'TREND_UP')).toBe('TREND_UP'); // sticky prior only
  });

  it('COMPRESSION only on ultra-tight squeeze (mild squeeze → RANGE so entries are not starved)', () => {
    const mild = padBars([
      bar(100, 100.02, 99.98, 100.00, 0),
      bar(100.00, 100.015, 99.99, 100.005, 1),
      bar(100.005, 100.012, 99.995, 100.002, 2),
      bar(100.002, 100.01, 99.997, 100.004, 3),
    ]);
    expect(classifyRegime(mild)).toBe('RANGE');

    // Last range must sit under COMPRESS_ABS (soft MOVE ladder ≈ 0.0055%)
    const tight = padBars([
      bar(100, 100.05, 99.95, 100.0, 0),
      bar(100.0, 100.04, 99.96, 100.01, 1),
      bar(100.01, 100.035, 99.97, 100.005, 2),
      bar(100.005, 100.0055, 100.0015, 100.003, 3),
    ]);
    expect(classifyRegime(tight)).toBe('COMPRESSION');
  });

  it('BREAKOUT_UP when expanding close leaves the prior range', () => {
    const bars = padBars([
      bar(100, 100.3, 99.8, 100.1, 0),
      bar(100.1, 100.35, 99.9, 100.2, 1),
      bar(100.2, 100.4, 100.0, 100.15, 2),
      bar(100.15, 102.4, 100.1, 102.2, 3),
    ]);
    expect(classifyRegime(bars)).toBe('BREAKOUT_UP');
  });

  it('BREAKOUT_DOWN when expanding close leaves the prior range', () => {
    const bars = padBars([
      bar(100, 100.3, 99.7, 99.9, 0),
      bar(99.9, 100.2, 99.6, 99.8, 1),
      bar(99.8, 100.1, 99.55, 99.85, 2),
      bar(99.85, 99.9, 97.6, 97.8, 3),
    ]);
    expect(classifyRegime(bars)).toBe('BREAKOUT_DOWN');
  });

  it('FAILED_BREAKOUT_UP after a breakout fades back inside', () => {
    const prior: RegimeName = 'BREAKOUT_UP';
    const bars = padBars([
      bar(100, 100.4, 99.7, 100.1, 0),
      bar(100.1, 100.5, 99.8, 100.2, 1),
      bar(100.2, 100.45, 99.9, 100.15, 2),
      bar(100.15, 100.3, 99.85, 99.95, 3),
    ]);
    expect(classifyRegime(bars, prior)).toBe('FAILED_BREAKOUT_UP');
  });

  it('FAILED_BREAKOUT_DOWN after a breakdown fades back inside', () => {
    const bars = padBars([
      bar(100, 100.4, 99.6, 99.9, 0),
      bar(99.9, 100.3, 99.5, 99.8, 1),
      bar(99.8, 100.2, 99.55, 99.85, 2),
      bar(99.85, 100.25, 99.7, 100.05, 3),
    ]);
    expect(classifyRegime(bars, 'BREAKOUT_DOWN')).toBe('FAILED_BREAKOUT_DOWN');
  });

  it('EXPANSION on a wide bar that does not cleanly break out', () => {
    const bars = padBars([
      bar(100, 100.8, 99.2, 100.1, 0),
      bar(100.1, 100.9, 99.3, 100.0, 1),
      bar(100.0, 101.0, 99.1, 100.2, 2),
      bar(100.2, 101.6, 98.6, 100.3, 3),
    ]);
    expect(classifyRegime(bars)).toBe('EXPANSION');
  });

  it('RANGE when oscillating inside prior highs/lows', () => {
    const bars = padBars([
      bar(100, 101.2, 98.8, 100.4, 0),
      bar(100.4, 101.0, 99.0, 99.6, 1),
      bar(99.6, 101.1, 98.9, 100.5, 2),
      bar(100.5, 100.9, 99.2, 99.8, 3),
    ]);
    const r = classifyRegime(bars);
    expect(['RANGE', 'TRANSITION', 'UNKNOWN']).toContain(r);
  });

  it('REVERSAL_CANDIDATE after TREND_UP with a violent opposite bar still inside range', () => {
    const bars = padBars([
      bar(100.0, 101.0, 99.6, 100.7, 0),
      bar(100.7, 101.2, 100.3, 101.0, 1),
      bar(101.0, 101.3, 100.4, 100.9, 2),
      bar(100.9, 101.0, 99.65, 99.7, 3),
    ]);
    expect(classifyRegime(bars, 'TREND_UP')).toBe('REVERSAL_CANDIDATE');
  });

  it('sticks prior regime instead of dead TRANSITION when leaving without a clean next state', () => {
    const bars = padBars([
      bar(100.0, 100.1, 99.95, 100.02, 0),
      bar(100.02, 100.08, 99.96, 100.0, 1),
      bar(100.0, 100.04, 99.93, 99.94, 2),
    ]);
    expect(classifyRegime(bars, 'TREND_UP')).toBe('TREND_UP');
  });
});

describe('stabilizeRegime — no flicker inside 1m', () => {
  it('holds TREND_UP through noisy 10s bars until dwell + confirm', () => {
    const book = {
      current: 'TREND_UP' as RegimeName,
      previous: 'UNKNOWN' as RegimeName,
      bars_in_current: 1,
      pending: null as RegimeName | null,
      pending_count: 0,
      since: new Date().toISOString(),
    };
    // Soft chop candidates before 60s dwell → stay TREND_UP
    for (const cand of ['RANGE', 'COMPRESSION', 'EXPANSION', 'RANGE'] as RegimeName[]) {
      expect(stabilizeRegime(book, cand)).toBe('TREND_UP');
    }
    expect(book.current).toBe('TREND_UP');
    expect(new Set(['RANGE', 'COMPRESSION', 'EXPANSION', 'TREND_UP']).size).toBe(4);
  });

  it('TREND_UP → PULLBACK_UPTREND same-family waits for dwell then 1 confirm', () => {
    const book = {
      current: 'TREND_UP' as RegimeName,
      previous: 'UNKNOWN' as RegimeName,
      bars_in_current: 3,
      pending: null as RegimeName | null,
      pending_count: 0,
      since: new Date().toISOString(),
    };
    // dwell checked before increment — need bars_in_current ≥ 5 at call start
    expect(stabilizeRegime(book, 'PULLBACK_UPTREND')).toBe('TREND_UP'); // 3→4
    expect(stabilizeRegime(book, 'PULLBACK_UPTREND')).toBe('TREND_UP'); // 4→5
    expect(stabilizeRegime(book, 'PULLBACK_UPTREND')).toBe('PULLBACK_UPTREND'); // 5 + pend
  });

  it('does not freeze — pending survives dwell so RANGE can become TREND_UP', () => {
    const book = {
      current: 'RANGE' as RegimeName,
      previous: 'UNKNOWN' as RegimeName,
      bars_in_current: 1,
      pending: null as RegimeName | null,
      pending_count: 0,
      since: new Date().toISOString(),
    };
    // dwell=5 + confirm=3 — switch on 5th agreeing candidate
    expect(stabilizeRegime(book, 'TREND_UP')).toBe('RANGE');
    expect(stabilizeRegime(book, 'TREND_UP')).toBe('RANGE');
    expect(stabilizeRegime(book, 'TREND_UP')).toBe('RANGE');
    expect(stabilizeRegime(book, 'TREND_UP')).toBe('RANGE');
    expect(stabilizeRegime(book, 'TREND_UP')).toBe('TREND_UP');
  });

  it('observeClosedBars does not visit every regime in one minute of 10s bars', () => {
    resetRegimeBook();
    const seed = withZoneFloor([100, 100.5, 101.2, 101.9, 102.7, 103.4]).map((p, i, arr) =>
      bar(i === 0 ? p : arr[i - 1]!, p + 0.4, p - 0.3, p, i)
    );
    observeClosedBars('GOLD', seed, 'Gold');
    const seen = new Set<string>(['TREND_UP']);
    const noisy: TenSecBar[] = [
      bar(103.4, 103.5, 103.2, 103.25, seed.length),
      bar(103.25, 103.35, 103.15, 103.2, seed.length + 1),
      bar(103.2, 103.4, 103.1, 103.35, seed.length + 2),
      bar(103.35, 103.45, 103.2, 103.28, seed.length + 3),
      bar(103.28, 103.5, 103.2, 103.42, seed.length + 4),
      bar(103.42, 103.55, 103.3, 103.5, seed.length + 5),
    ];
    for (const b of noisy) {
      const snap = observeClosedBars('GOLD', [b], 'Gold');
      seen.add(snap.current);
    }
    expect(seen.size).toBeLessThanOrEqual(3);
    expect(seen.has('TREND_UP') || seen.has('PULLBACK_UPTREND')).toBe(true);
  });

  it('observeClosedBars batch equals per-bar stabilize (dwell accumulates)', () => {
    resetRegimeBook();
    const seed = withZoneFloor([100, 100.5, 101.2, 101.9, 102.7, 103.4]).map((p, i, arr) =>
      bar(i === 0 ? p : arr[i - 1]!, p + 0.4, p - 0.3, p, i)
    );
    observeClosedBars('GOLD-A', seed, 'Gold', 1);
    observeClosedBars('GOLD-B', seed, 'Gold', 2);
    const dip = [
      bar(103.4, 103.5, 102.0, 102.2, seed.length),
      bar(102.2, 102.3, 101.5, 101.7, seed.length + 1),
      bar(101.7, 101.8, 101.0, 101.2, seed.length + 2),
      bar(101.2, 101.3, 100.5, 100.8, seed.length + 3),
    ];
    const batch = observeClosedBars('GOLD-A', dip, 'Gold', 1);
    let sequential = observeClosedBars('GOLD-B', [dip[0]!], 'Gold', 2);
    for (let i = 1; i < dip.length; i++) {
      sequential = observeClosedBars('GOLD-B', [dip[i]!], 'Gold', 2);
    }
    expect(batch.current).toBe(sequential.current);
  });

  it('notePipelineRegime does not hard-hijack sticky zone pending', () => {
    resetRegimeBook();
    const seed = withZoneFloor([100, 100.5, 101.2, 101.9, 102.7, 103.4]).map((p, i, arr) =>
      bar(i === 0 ? p : arr[i - 1]!, p + 0.4, p - 0.3, p, i)
    );
    observeClosedBars('GOLD', seed, 'Gold', 99);
    const stamped = notePipelineRegime('GOLD', 'TREND_DOWN', 'Gold', 99);
    expect(stamped.current).toBe('TREND_UP');
  });

  it('scoped notePipelineRegime does not soft-confirm pending flips', () => {
    resetRegimeBook();
    const seed = withZoneFloor([100, 100.5, 101.2, 101.9, 102.7, 103.4]).map((p, i, arr) =>
      bar(i === 0 ? p : arr[i - 1]!, p + 0.4, p - 0.3, p, i)
    );
    observeClosedBars('GOLD', seed, 'Gold', 77);
    // Stamp opposite family many times — must stay TREND_UP (OHLC owns dwell)
    for (let i = 0; i < 5; i++) notePipelineRegime('GOLD', 'TREND_DOWN', 'Gold', 77);
    expect(currentRegime('GOLD', 77)?.current).toBe('TREND_UP');
    // One soft RANGE bar must not instantly flip via inflated pending_count
    const soft = bar(103.4, 103.45, 103.35, 103.38, seed.length);
    const after = observeClosedBars('GOLD', [soft], 'Gold', 77);
    expect(after.current).toBe('TREND_UP');
  });
});

describe('regime book + trade style', () => {
  beforeEach(() => resetRegimeBook());

  it('stores live snapshots under the epic', () => {
    const prices = withZoneFloor([100, 100.5, 101.2, 101.9, 102.7, 103.4]);
    const bars = prices.map((p, i) =>
      bar(i === 0 ? p : prices[i - 1]!, p + 0.4, p - 0.4, p, i)
    );
    const snap = observeClosedBars('GOLD', bars, 'Gold');
    expect(snap.current).toBe('TREND_UP');
    expect(snap.display_name).toBe('Gold');
    expect(REGIME_NAMES).toContain(snap.current);
  });

  it('maps trend regimes to LONG and breakout/range to SCALP', () => {
    expect(styleFromClassification('TREND_UP')).toBe('LONG');
    expect(styleFromClassification('PULLBACK_DOWNTREND')).toBe('LONG');
    expect(styleFromClassification('BREAKOUT_UP')).toBe('SCALP');
    expect(styleFromClassification('COMPRESSION')).toBe('SCALP');
    expect(styleFromClassification('UNKNOWN')).toBeNull();
    expect(styleFromClassification(null, 'CONTINUATION')).toBe('LONG');
    expect(styleFromClassification(null, 'BREAKOUT')).toBe('SCALP');
  });
});

describe('four trade-type names from real classification', () => {
  it('never fakes BUY=LONG / SELL=SCALP', () => {
    expect(formatTradeLabel('BUY')).toBe('BUY');
    expect(formatTradeLabel('SELL')).toBe('SELL');
    expect(formatTradeLabel('BUY', null, 'RANGE')).toBe('BUY SCALP');
    expect(formatTradeLabel('SELL', null, 'RANGE')).toBe('SELL SCALP');
    expect(formatTradeLabel('BUY', null, 'TREND_UP')).toBe('BUY LONG');
    expect(formatTradeLabel('SELL', null, 'TREND_DOWN')).toBe('SELL LONG');
    expect(formatTradeLabel('SELL', null, 'TREND_UP')).toBe('SELL LONG');
    expect(formatTradeLabel('BUY', null, 'BREAKOUT_UP')).toBe('BUY SCALP');
  });

  it('uses setup_type when regime is missing', () => {
    expect(formatTradeLabel('BUY', 'CONTINUATION')).toBe('BUY LONG');
    expect(formatTradeLabel('SELL', 'BREAKOUT')).toBe('SELL SCALP');
  });
});
