import { describe, expect, it } from 'vitest';
import { resolveDeskEntry } from './deskEntry.js';
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

describe('resolveDeskEntry — BUY and SELL both fire', () => {
  it('SCAN: feeds already above Capital → BUY', () => {
    const e = resolveDeskEntry({
      capitalMid: 4338,
      refs: [...yahooBasis, ...cluster(4346)],
    });
    expect(e.direction).toBe('BUY');
    expect(e.setup).toBe('LAG_LEAD');
    expect(e.reason).toMatch(/LAG CAPITAL · BUY/);
  });

  it('SCAN: feeds already below Capital → SELL', () => {
    const e = resolveDeskEntry({
      capitalMid: 4338,
      refs: [...yahooBasis, ...cluster(4330)],
    });
    expect(e.direction).toBe('SELL');
    expect(e.setup).toBe('LAG_LEAD');
    expect(e.reason).toMatch(/LAG CAPITAL · SELL/);
  });

  it('10s TREND_UP dump → BUY (dip)', () => {
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

  it('10s TREND_DOWN dump → SELL', () => {
    const e = resolveDeskEntry({
      bar: bar(4340.22, 4339.03),
      regime: 'TREND_DOWN',
      bias: 'DOWN',
      capitalMid: 4339.03,
      refs: cluster(4339.0),
    });
    expect(e.direction).toBe('SELL');
  });

  it('FLIP: 10s BUY into a dumped cluster → SELL', () => {
    const e = resolveDeskEntry({
      bar: bar(4354, 4350),
      regime: 'TREND_UP',
      bias: 'UP',
      capitalMid: 4354,
      refs: cluster(4346),
    });
    expect(e.direction).toBe('SELL');
    expect(e.setup).toBe('LAG_LEAD');
    expect(e.reason).toMatch(/SELL/);
  });

  it('FLIP: 10s SELL into a rallied cluster → BUY', () => {
    const e = resolveDeskEntry({
      bar: bar(4346, 4342),
      regime: 'TREND_DOWN',
      bias: 'DOWN',
      capitalMid: 4342,
      refs: cluster(4350),
    });
    expect(e.direction).toBe('BUY');
    expect(e.setup).toBe('LAG_LEAD');
    expect(e.reason).toMatch(/BUY/);
  });

  it('Yahoo 50pt basis alone never creates BUY or SELL', () => {
    const e = resolveDeskEntry({
      capitalMid: 4338.31,
      refs: yahooBasis,
    });
    expect(e.direction).toBeNull();
  });

  it('live 02:07 board cluster vs Capital → SELL (not Yahoo BUY)', () => {
    const e = resolveDeskEntry({
      capitalMid: 4338.31,
      refs: [
        ...yahooBasis,
        { label: 'Gold-API spot (public)', mid: 4337.6 },
        { label: 'Coinbase spot (public)', mid: 4334.98 },
        { label: 'Kraken spot (public)', mid: 4333.93 },
        { label: 'KuCoin spot (public)', mid: 4339 },
        { label: 'Binance.US (public)', mid: 4350 },
        { label: 'CoinGecko (public)', mid: 4329.03 },
        { label: 'Bitstamp (public)', mid: 4334.88 },
      ],
    });
    expect(e.direction).toBe('SELL');
  });
});
