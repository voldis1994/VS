import { describe, expect, it } from 'vitest';
import { isRealEntrySetup, resolveDeskEntry } from './deskEntry.js';
import type { PriceRef } from './staleQuoteGuard.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number): TenSecBar {
  return {
    open_time_ms: 0,
    open,
    high: Math.max(open, close) + 0.4,
    low: Math.min(open, close) - 0.4,
    close,
    ticks: 12,
  };
}

function cluster(mid: number): PriceRef[] {
  return [
    { label: 'Gold-API spot (public)', mid: mid - 0.2 },
    { label: 'Coinbase spot (public)', mid: mid + 0.1 },
    { label: 'Kraken spot (public)', mid: mid - 0.1 },
    { label: 'KuCoin spot (public)', mid: mid },
    { label: 'Bitstamp (public)', mid: mid + 0.2 },
  ];
}

const yahooBasis: PriceRef[] = [
  { label: 'Yahoo Finance (public)', mid: 4391.5 },
  { label: 'Aurum metals spot (public)', mid: 4393.8 },
  { label: 'Fawaz FX / XAU (public)', mid: 4402.33 },
];

describe('isRealEntrySetup', () => {
  it('allows structure setups only', () => {
    expect(isRealEntrySetup('PULLBACK')).toBe(true);
    expect(isRealEntrySetup('CONTINUATION')).toBe(true);
    expect(isRealEntrySetup('BREAKOUT')).toBe(true);
    expect(isRealEntrySetup('RANGE_REJECTION')).toBe(true);
    expect(isRealEntrySetup('LAG_LEAD')).toBe(false);
    expect(isRealEntrySetup('BIAS')).toBe(false);
    expect(isRealEntrySetup(null)).toBe(false);
  });
});

describe('resolveDeskEntry — real setups only (no chase)', () => {
  it('LAG_LEAD alone never opens (feed lead is not a setup)', () => {
    const e = resolveDeskEntry({
      capitalMid: 4338,
      refs: [...yahooBasis, ...cluster(4346)],
    });
    expect(e.direction).toBeNull();
    expect(e.reason).toMatch(/NO_REAL_SETUP|LAG_LEAD/);
  });

  it('SCAN: lag-lead opposite vs bias is blocked', () => {
    const e = resolveDeskEntry({
      bias: 'UP',
      capitalMid: 4338,
      refs: [...yahooBasis, ...cluster(4330)],
    });
    expect(e.direction).toBeNull();
  });

  it('feeds below Capital alone never opens SELL', () => {
    const e = resolveDeskEntry({
      capitalMid: 4338,
      refs: [...yahooBasis, ...cluster(4330)],
    });
    expect(e.direction).toBeNull();
  });

  it('10s TREND_UP dump → BUY (PULLBACK)', () => {
    const e = resolveDeskEntry({
      bar: bar(4340.22, 4339.03),
      regime: 'TREND_UP',
      bias: 'UP',
      capitalMid: 4339.03,
      refs: cluster(4339.0),
    });
    expect(e.direction).toBe('BUY');
    expect(e.setup).toBe('PULLBACK');
  });

  it('10s TREND_UP green climb alone → no chase CONTINUATION', () => {
    const e = resolveDeskEntry({
      bar: bar(4339.03, 4340.22),
      regime: 'TREND_UP',
      bias: 'UP',
      capitalMid: 4340.22,
      refs: cluster(4340.2),
    });
    expect(e.direction).toBeNull();
  });

  it('10s TREND_DOWN dump → SELL', () => {
    const e = resolveDeskEntry({
      bar: bar(4340.22, 4339.03),
      regime: 'TREND_DOWN',
      bias: 'DOWN',
      capitalMid: 4339.03,
      refs: cluster(4339.0),
    });
    expect(e.direction).toBe('SELL');
    expect(e.setup).toBe('PULLBACK');
  });

  it('Yahoo 50pt basis alone never creates BUY or SELL', () => {
    const e = resolveDeskEntry({
      capitalMid: 4338.31,
      refs: yahooBasis,
    });
    expect(e.direction).toBeNull();
  });

  it('LAG_LEAD with matching green RANGE candle still blocked (not a real setup)', () => {
    const bullish = bar(4346.0, 4346.6);
    const e = resolveDeskEntry({
      bar: bullish,
      regime: 'RANGE',
      bias: 'UP',
      capitalMid: 4338,
      refs: [...yahooBasis, ...cluster(4346)],
    });
    expect(e.direction).toBeNull();
  });

  it('screenshot: PULLBACK_UPTREND + bias DOWN + dump 10s → SELL', () => {
    const e = resolveDeskEntry({
      bar: {
        open_time_ms: 0,
        open: 4354.67,
        high: 4354.67,
        low: 4354.13,
        close: 4354.13,
        ticks: 8,
      },
      regime: 'PULLBACK_UPTREND',
      bias: 'DOWN',
      capitalMid: 4356.46,
      refs: cluster(4354.13),
    });
    expect(e.direction).toBe('SELL');
  });

  it('RANGE + doji does not invent BUY/SELL', () => {
    const doji = bar(4354.5, 4354.5);
    const e = resolveDeskEntry({
      bar: doji,
      regime: 'RANGE',
      bias: 'UP',
      capitalMid: 4354.4,
      refs: cluster(4354.4),
    });
    expect(e.direction).toBeNull();
  });

  it('dump then climb in RANGE does not flip side every candle', () => {
    const dump = resolveDeskEntry({
      bar: bar(4354.67, 4354.13),
      regime: 'RANGE',
      bias: 'FLAT',
      capitalMid: 4354.4,
      refs: cluster(4354.4),
    });
    const climb = resolveDeskEntry({
      bar: bar(4354.13, 4354.67),
      regime: 'RANGE',
      bias: 'FLAT',
      capitalMid: 4354.4,
      refs: cluster(4354.4),
    });
    expect(dump.direction).toBeNull();
    expect(climb.direction).toBeNull();
  });

  it('BIAS last-resort path is gone — TREND alone + green is not enough', () => {
    const e = resolveDeskEntry({
      bar: bar(4350, 4351),
      regime: 'TREND_UP',
      bias: 'FLAT',
      capitalMid: 4351,
      refs: cluster(4351),
    });
    expect(e.direction).toBeNull();
  });

  it('when intended comes from C++ calc, adverse stale blocks entry (no LAG flip)', () => {
    const e = resolveDeskEntry({
      intended: 'BUY',
      intendedSetup: 'CONTINUATION',
      intendedReason: 'CALC EntryReady',
      capitalMid: 100,
      refs: [
        { label: 'Gold-API spot (public)', mid: 99.8 },
        { label: 'Coinbase spot (public)', mid: 99.8 },
        { label: 'Kraken spot (public)', mid: 99.8 },
      ],
    });
    expect(e.direction).toBeNull();
  });

  it('when C++ intended a with-trend direction against bias, concept gate blocks', () => {
    const e = resolveDeskEntry({
      intended: 'BUY',
      intendedSetup: 'PULLBACK',
      intendedReason: 'CALC EntryReady',
      bias: 'DOWN',
      regime: 'TREND_DOWN',
      capitalMid: 100,
      refs: [
        { label: 'Gold-API spot (public)', mid: 100 },
        { label: 'Coinbase spot (public)', mid: 100.05 },
        { label: 'Kraken spot (public)', mid: 99.95 },
      ],
    });
    expect(e.direction).toBeNull();
    expect(e.reason).toMatch(/CONCEPT_BLOCK|REGIME_BLOCK/);
  });

  it('blocks BUY on TREND_DOWN from 10s green bounce', () => {
    const e = resolveDeskEntry({
      bar: bar(2492, 2493.5),
      closedBars: [bar(2494, 2492), bar(2492, 2491)],
      regime: 'TREND_DOWN',
      bias: 'DOWN',
      capitalMid: 2493.5,
      refs: [
        { label: 'Gold-API spot (public)', mid: 2493.5 },
        { label: 'Coinbase spot (public)', mid: 2493.5 },
        { label: 'Kraken spot (public)', mid: 2493.5 },
      ],
    });
    expect(e.direction).not.toBe('BUY');
  });

  it('blocks C++ vein BUY when regime is TREND_DOWN', () => {
    const e = resolveDeskEntry({
      intended: 'BUY',
      intendedSetup: 'CONTINUATION',
      intendedReason: 'CALC vein long · flow+',
      bar: bar(2492, 2493),
      regime: 'TREND_DOWN',
      bias: 'DOWN',
      capitalMid: 2493,
      refs: [
        { label: 'Gold-API spot (public)', mid: 2493 },
        { label: 'Coinbase spot (public)', mid: 2493 },
        { label: 'Kraken spot (public)', mid: 2493 },
      ],
    });
    expect(e.direction).toBeNull();
    expect(e.reason).toMatch(/REGIME_BLOCK|CONCEPT_BLOCK|CALC_BLOCK/);
  });

  it('blocks C++ SELL when impulse ended with green bounce 10s', () => {
    const e = resolveDeskEntry({
      intended: 'SELL',
      intendedSetup: 'CONTINUATION',
      intendedReason: 'CALC EntryReady follow dump',
      bar: bar(2492, 2494),
      closedBars: [bar(2496, 2493), bar(2493, 2492)],
      bias: 'DOWN',
      regime: 'TREND_DOWN',
      capitalMid: 2494,
      refs: [
        { label: 'Gold-API spot (public)', mid: 2494 },
        { label: 'Coinbase spot (public)', mid: 2494 },
        { label: 'Kraken spot (public)', mid: 2494 },
      ],
    });
    expect(e.direction).toBeNull();
    expect(e.reason).toMatch(/CALC_BLOCK.*impulse ended/i);
  });

  it('C++ CONTINUATION with matching structure still allowed', () => {
    const e = resolveDeskEntry({
      intended: 'BUY',
      intendedSetup: 'PULLBACK',
      intendedReason: 'CALC EntryReady',
      bar: bar(4340.22, 4339.03),
      regime: 'TREND_UP',
      bias: 'UP',
      capitalMid: 4339.03,
      refs: cluster(4339.0),
    });
    expect(e.direction).toBe('BUY');
    expect(e.setup).toBe('PULLBACK');
  });
});
