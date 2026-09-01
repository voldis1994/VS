import { describe, expect, it, beforeEach } from 'vitest';
import {
  REGIME_NAMES,
  TRADE_TYPE_NAMES,
  OPERATING_MODES,
  classifyRegime,
  classifyRegimeDetailed,
  normalizeRegime,
  observeClosedBars,
  resetRegimeBook,
  styleFromClassification,
  type RegimeName,
} from './regimes.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import { formatTradeLabel } from './tradePresentation.js';

function bar(open: number, high: number, low: number, close: number, i = 0): TenSecBar {
  return { open_time_ms: i * 10_000, open, high, low, close, ticks: 10 };
}

function withWarmup(tail: TenSecBar[], warm = 140): TenSecBar[] {
  const start = tail[0]?.open ?? 100;
  const out: TenSecBar[] = [];
  let p = start - 0.5;
  for (let i = 0; i < warm; i++) {
    const c = p + Math.sin(i / 7) * 0.02;
    out.push(bar(p, c + 0.05, c - 0.05, c, i));
    p = c;
  }
  const base = out.length;
  for (let j = 0; j < tail.length; j++) {
    out.push({ ...tail[j]!, open_time_ms: (base + j) * 10_000 });
  }
  return out;
}

function trendBars(start: number, step: number, count: number): TenSecBar[] {
  const bars: TenSecBar[] = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    const c = p + step;
    bars.push(bar(p, Math.max(p, c) + 0.3, Math.min(p, c) - 0.3, c, i));
    p = c;
  }
  return bars;
}

function run(prices: number[], previous: RegimeName = 'RANGE'): RegimeName {
  const bars = prices.map((p, i) => {
    const prev = i === 0 ? p : prices[i - 1]!;
    return bar(prev, Math.max(prev, p) + 0.4, Math.min(prev, p) - 0.4, p, i);
  });
  return classifyRegime(withWarmup(bars), previous);
}

describe('operating regime names', () => {
  it('exposes real regimes only — no UNKNOWN / TRANSITION', () => {
    expect(REGIME_NAMES).not.toContain('UNKNOWN');
    expect(REGIME_NAMES).not.toContain('TRANSITION');
  });

  it('collapses dead labels to RANGE', () => {
    expect(normalizeRegime('UNKNOWN')).toBe('RANGE');
    expect(normalizeRegime('TRANSITION')).toBe('RANGE');
    expect(normalizeRegime(null)).toBe('RANGE');
  });

  it('exposes all four operating modes and four trade-type names', () => {
    expect([...OPERATING_MODES]).toEqual(['REPLAY', 'PAPER', 'DEMO', 'LIVE']);
    expect([...TRADE_TYPE_NAMES]).toEqual(['BUY LONG', 'SELL LONG', 'BUY SCALP', 'SELL SCALP']);
  });
});

describe('classifyRegime via signal engine', () => {
  it('RANGE with too few bars (never UNKNOWN)', () => {
    expect(classifyRegime([bar(100, 100.1, 99.9, 100)])).toBe('RANGE');
  });

  it('TREND_UP on a persistent rally', () => {
    const r = run([100, 100.4, 100.9, 101.5, 102.2, 103.0, 103.8, 104.6, 105.5, 106.5, 107.5, 108.5]);
    expect(r).toMatch(/TREND_UP|PULLBACK_UPTREND|BREAKOUT_UP/);
  });

  it('TREND_DOWN on a persistent selloff', () => {
    const r = run([103, 102.4, 101.8, 101.1, 100.4, 99.6, 98.8, 98.0, 97.1, 96.2, 95.2, 94.2]);
    expect(r).toMatch(/TREND_DOWN|PULLBACK_DOWNTREND|BREAKOUT_DOWN/);
  });

  it('never emits TRANSITION — uses a real state instead', () => {
    const bars = withWarmup(trendBars(100, 0.01, 8));
    const r = classifyRegime(bars, 'TREND_UP');
    expect(r).not.toBe('TRANSITION' as RegimeName);
    expect(r).not.toBe('UNKNOWN' as RegimeName);
    expect(REGIME_NAMES).toContain(r);
  });

  it('classifyRegimeDetailed attaches signal output', () => {
    const bars = withWarmup(trendBars(100, 0.4, 35));
    const d = classifyRegimeDetailed(bars);
    expect(d.brain).not.toBeNull();
    expect(d.brain.ready).toBe(true);
    expect(d.confidence).toBeGreaterThan(0);
  });
});

describe('regime hysteresis', () => {
  beforeEach(() => resetRegimeBook());

  it('does not flip on a single disagreeing bar', () => {
    const up = withWarmup(trendBars(100, 0.45, 40));
    expect(observeClosedBars('GOLD', up, 'Gold', 'bot1').current).toMatch(
      /TREND_UP|PULLBACK_UPTREND|BREAKOUT_UP/
    );

    const dip = bar(143, 143.5, 142.9, 143.0, up.length);
    const afterOne = observeClosedBars('GOLD', [dip], 'Gold', 'bot1');
    expect(afterOne.current).toMatch(/TREND_UP|PULLBACK_UPTREND|BREAKOUT_UP|EXPANSION/);
  });

  it('ignores re-polls with the same bars (no tick flicker)', () => {
    const bars = withWarmup(trendBars(100, 0.45, 40));
    const a = observeClosedBars('SILVER', bars, 'Silver', 'bot2');
    const b = observeClosedBars('SILVER', bars, 'Silver', 'bot2');
    expect(b.current).toBe(a.current);
    expect(b.since).toBe(a.since);
  });
});

describe('regime book + trade style', () => {
  beforeEach(() => resetRegimeBook());

  it('stores live snapshots with signal payload', () => {
    const bars = withWarmup(trendBars(100, 0.45, 40));
    const snap = observeClosedBars('GOLD', bars, 'Gold');
    expect(snap.display_name).toBe('Gold');
    expect(REGIME_NAMES).toContain(snap.current);
    expect(snap.brain).not.toBeNull();
  });

  it('maps trend regimes to LONG and breakout/range to SCALP', () => {
    expect(styleFromClassification('TREND_UP')).toBe('LONG');
    expect(styleFromClassification('PULLBACK_DOWNTREND')).toBe('LONG');
    expect(styleFromClassification('BREAKOUT_UP')).toBe('SCALP');
    expect(styleFromClassification('COMPRESSION')).toBe('SCALP');
    expect(styleFromClassification('UNKNOWN')).toBe('SCALP');
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
