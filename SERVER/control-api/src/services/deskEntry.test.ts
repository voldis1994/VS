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

  it('01:20 board: quote 4330 vs Capital LIVE 4338 → BUY, not SCAN', () => {
    const doji: TenSecBar = {
      open_time_ms: 0,
      open: 4338.12,
      high: 4338.12,
      low: 4337.7,
      close: 4338.12,
      ticks: 8,
    };
    const e = resolveDeskEntry({
      bar: doji,
      regime: 'COMPRESSION',
      bias: 'UP',
      capitalMid: 4330.35,
      refs: [
        ...yahooBasis,
        { label: 'BOOS / Capital.com LIVE', mid: 4338.08 },
        { label: 'Gold-API spot (public)', mid: 4338.9 },
        { label: 'Binance.US (public)', mid: 4330.27 },
      ],
    });
    expect(e.direction).toBe('BUY');
  });

  it('screenshot: PULLBACK_UPTREND + bias DOWN + dump 10s → SELL, not SCAN', () => {
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
    expect(e.direction).not.toBeNull();
  });

  it('RANGE + doji does not invent BUY/SELL just because a 10s closed', () => {
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

  it('when intended comes from C++ calc, lag-lead opposite does not flip; stale blocks entry', () => {
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
});
