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

function swing(o: number, h: number, l: number, c: number, i: number): TenSecBar {
  return { open_time_ms: i * 10_000, open: o, high: h, low: l, close: c, ticks: 10 };
}

/** Climb, swing-low demand, red retest — zone + structure BUY. */
function climbDemandPull() {
  const bars = [
    swing(4320, 4324, 4319, 4323, 0),
    swing(4323, 4327, 4322, 4326, 1),
    swing(4326, 4330, 4325, 4329, 2),
    swing(4329, 4333, 4328, 4332, 3),
    swing(4332, 4336, 4331, 4335, 4),
    swing(4335, 4339, 4334, 4338, 5),
    swing(4338, 4339, 4328, 4330, 6), // swing low / demand pivot 4328
    swing(4330, 4334, 4329.5, 4333, 7),
    swing(4333, 4333.5, 4327.5, 4329, 8), // red retest of demand
  ];
  return { bars, pull: bars[bars.length - 1]! };
}

/** Dump, swing-high supply, red reject — zone + structure SELL. */
function dumpSupplyTouch() {
  const bars = [
    swing(4380, 4382, 4378, 4379, 0),
    swing(4379, 4380, 4375, 4376, 1),
    swing(4376, 4377, 4372, 4373, 2),
    swing(4373, 4374, 4369, 4370, 3),
    swing(4370, 4371, 4366, 4367, 4),
    swing(4367, 4375, 4366, 4374, 5), // swing high / supply pivot 4375
    swing(4374, 4374.5, 4371, 4372, 6),
    swing(4372, 4375.2, 4369, 4370, 7), // red reject at supply
  ];
  return { bars, last: bars[bars.length - 1]! };
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

  it('10s TREND_UP dump → BUY only with climb structure + demand zone', () => {
    const { bars, pull } = climbDemandPull();
    const e = resolveDeskEntry({
      bar: pull,
      closedBars: bars,
      regime: 'TREND_UP',
      bias: 'UP',
      capitalMid: pull.close,
      refs: cluster(pull.close),
    });
    expect(e.direction).toBe('BUY');
    expect(e.setup).toBe('PULLBACK');
    expect(e.reason).toMatch(/ZONE/i);
  });

  it('10s TREND_UP lone dump without structure → no entry', () => {
    const e = resolveDeskEntry({
      bar: bar(4340.22, 4339.03),
      regime: 'TREND_UP',
      bias: 'UP',
      capitalMid: 4339.03,
      refs: cluster(4339.0),
    });
    expect(e.direction).toBeNull();
  });

  it('10s TREND_DOWN dump → SELL with dump structure + supply zone', () => {
    const { bars, last } = dumpSupplyTouch();
    const e = resolveDeskEntry({
      bar: last,
      closedBars: bars,
      regime: 'TREND_DOWN',
      bias: 'DOWN',
      capitalMid: last.close,
      refs: cluster(last.close),
    });
    expect(e.direction).toBe('SELL');
    expect(e.reason).toMatch(/ZONE/i);
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

  it('screenshot: PULLBACK_UPTREND + bias DOWN + dump needs down structure + supply zone', () => {
    const { bars, last } = dumpSupplyTouch();
    const e = resolveDeskEntry({
      bar: last,
      closedBars: bars,
      regime: 'PULLBACK_UPTREND',
      bias: 'DOWN',
      capitalMid: last.close,
      refs: cluster(last.close),
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

  it('C++ CONTINUATION with matching structure + zone still allowed', () => {
    const { bars, pull } = climbDemandPull();
    const e = resolveDeskEntry({
      intended: 'BUY',
      intendedSetup: 'PULLBACK',
      intendedReason: 'CALC EntryReady',
      bar: pull,
      closedBars: bars,
      regime: 'TREND_UP',
      bias: 'UP',
      capitalMid: pull.close,
      refs: cluster(pull.close),
    });
    expect(e.direction).toBe('BUY');
    expect(e.setup).toBe('PULLBACK');
  });
});
