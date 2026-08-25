import { describe, expect, it, beforeEach } from 'vitest';
import {
  REGIME_NAMES,
  TRADE_TYPE_NAMES,
  OPERATING_MODES,
  classifyRegime,
  observeClosedBars,
  resetRegimeBook,
  styleFromClassification,
  toLiveRegime,
  type RegimeName,
} from './regimes.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import { formatTradeLabel } from './tradePresentation.js';

function bar(open: number, high: number, low: number, close: number, i = 0): TenSecBar {
  return { open_time_ms: i * 10_000, open, high, low, close, ticks: 10 };
}

function run(prices: number[], previous: RegimeName = 'UNKNOWN'): RegimeName {
  const bars = prices.map((p, i) => {
    const prev = i === 0 ? p : prices[i - 1]!;
    const high = Math.max(prev, p) + 0.4;
    const low = Math.min(prev, p) - 0.4;
    return bar(prev, high, low, p, i);
  });
  return classifyRegime(bars, previous);
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
    const up = [100, 100.5, 101.1, 101.8, 102.6];
    const withDip = [...up, 102.0];
    expect(run(withDip, 'TREND_UP')).toBe('PULLBACK_UPTREND');
  });

  it('PULLBACK_DOWNTREND after TREND_DOWN with a bounce bar', () => {
    const dn = [103, 102.4, 101.7, 101.0, 100.2];
    const bounce = [...dn, 100.8];
    expect(run(bounce, 'TREND_DOWN')).toBe('PULLBACK_DOWNTREND');
  });

  it('COMPRESSION on tiny in-range bars', () => {
    const bars = [
      bar(100, 100.02, 99.98, 100.00, 0),
      bar(100.00, 100.015, 99.99, 100.005, 1),
      bar(100.005, 100.012, 99.995, 100.002, 2),
      bar(100.002, 100.01, 99.997, 100.004, 3),
    ];
    expect(classifyRegime(bars)).toBe('COMPRESSION');
  });

  it('BREAKOUT_UP when expanding close leaves the prior range', () => {
    const bars = [
      bar(100, 100.3, 99.8, 100.1, 0),
      bar(100.1, 100.35, 99.9, 100.2, 1),
      bar(100.2, 100.4, 100.0, 100.15, 2),
      bar(100.15, 102.4, 100.1, 102.2, 3),
    ];
    expect(classifyRegime(bars)).toBe('BREAKOUT_UP');
  });

  it('BREAKOUT_DOWN when expanding close leaves the prior range', () => {
    const bars = [
      bar(100, 100.3, 99.7, 99.9, 0),
      bar(99.9, 100.2, 99.6, 99.8, 1),
      bar(99.8, 100.1, 99.55, 99.85, 2),
      bar(99.85, 99.9, 97.6, 97.8, 3),
    ];
    expect(classifyRegime(bars)).toBe('BREAKOUT_DOWN');
  });

  it('FAILED_BREAKOUT_UP after a breakout fades back inside', () => {
    const prior: RegimeName = 'BREAKOUT_UP';
    const bars = [
      bar(100, 100.4, 99.7, 100.1, 0),
      bar(100.1, 100.5, 99.8, 100.2, 1),
      bar(100.2, 100.45, 99.9, 100.15, 2),
      bar(100.15, 100.3, 99.85, 99.95, 3),
    ];
    expect(classifyRegime(bars, prior)).toBe('FAILED_BREAKOUT_UP');
  });

  it('FAILED_BREAKOUT_DOWN after a breakdown fades back inside', () => {
    const bars = [
      bar(100, 100.4, 99.6, 99.9, 0),
      bar(99.9, 100.3, 99.5, 99.8, 1),
      bar(99.8, 100.2, 99.55, 99.85, 2),
      bar(99.85, 100.25, 99.7, 100.05, 3),
    ];
    expect(classifyRegime(bars, 'BREAKOUT_DOWN')).toBe('FAILED_BREAKOUT_DOWN');
  });

  it('EXPANSION on a wide bar that does not cleanly break out', () => {
    const bars = [
      bar(100, 100.8, 99.2, 100.1, 0),
      bar(100.1, 100.9, 99.3, 100.0, 1),
      bar(100.0, 101.0, 99.1, 100.2, 2),
      bar(100.2, 101.6, 98.6, 100.3, 3),
    ];
    expect(classifyRegime(bars)).toBe('EXPANSION');
  });

  it('RANGE when oscillating inside prior highs/lows', () => {
    const bars = [
      bar(100, 101.2, 98.8, 100.4, 0),
      bar(100.4, 101.0, 99.0, 99.6, 1),
      bar(99.6, 101.1, 98.9, 100.5, 2),
      bar(100.5, 100.9, 99.2, 99.8, 3),
    ];
    const r = classifyRegime(bars);
    expect(['RANGE', 'TRANSITION', 'UNKNOWN']).toContain(r);
  });

  it('TREND_DOWN on clear multi-bar selloff even when last close is inside prior 8-bar H/L', () => {
    // Stair-step selloff: each close inside recent window → old classifier said RANGE
    const prices: number[] = [];
    let p = 4646.5;
    for (let i = 0; i < 16; i++) {
      p -= 0.45; // ~7.2pt drop over ~2.5 min — like the Capital Gold chart
      prices.push(p);
    }
    const bars = prices.map((close, i) => {
      const open = i === 0 ? 4646.5 : prices[i - 1]!;
      const high = Math.max(open, close) + 0.15;
      const low = Math.min(open, close) - 0.1;
      return bar(open, high, low, close, i);
    });
    const r = classifyRegime(bars);
    expect(r).toBe('TREND_DOWN');
    expect(r).not.toBe('RANGE');
  });

  it('REVERSAL_CANDIDATE after TREND_UP with a violent opposite bar still inside range', () => {
    const bars = [
      bar(100.0, 101.0, 99.6, 100.7, 0),
      bar(100.7, 101.2, 100.3, 101.0, 1),
      bar(101.0, 101.3, 100.4, 100.9, 2),
      bar(100.9, 101.0, 99.65, 99.7, 3),
    ];
    expect(classifyRegime(bars, 'TREND_UP')).toBe('REVERSAL_CANDIDATE');
  });

  it('TRANSITION when leaving a named regime without a clean next state', () => {
    const bars = [
      bar(100.0, 100.1, 99.95, 100.02, 0),
      bar(100.02, 100.08, 99.96, 100.0, 1),
      bar(100.0, 100.04, 99.93, 99.94, 2),
    ];
    expect(classifyRegime(bars, 'TREND_UP')).toBe('TRANSITION');
  });

  it('toLiveRegime never returns UNKNOWN / COMPRESSION / TRANSITION', () => {
    expect(toLiveRegime('UNKNOWN')).toBe('EXPANSION');
    expect(toLiveRegime('COMPRESSION')).toBe('EXPANSION');
    expect(toLiveRegime('TRANSITION')).toBe('EXPANSION');
    expect(toLiveRegime('TREND_UP')).toBe('TREND_UP');
  });

  it('observeClosedBars never surfaces UNKNOWN', () => {
    const snap = observeClosedBars('X', [bar(100, 100.1, 99.9, 100)]);
    expect(snap.current).not.toBe('UNKNOWN');
    expect(snap.current).toBe('EXPANSION');
  });
});

describe('regime book + trade style', () => {
  beforeEach(() => resetRegimeBook());

  it('stores live snapshots under the epic', () => {
    const prices = [100, 100.5, 101.2, 101.9, 102.7, 103.4];
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
