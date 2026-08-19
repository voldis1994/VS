import { describe, expect, it } from 'vitest';
import {
  analyzeStructure,
  classifyMarketTrend,
  confirmBullishReversal,
  confirmBearishReversal,
  evaluateEntryDirectionGate,
} from './entryDirectionGate.js';
import { resolveDeskEntry } from './deskEntry.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number, spread = 0.5): TenSecBar {
  return {
    open_time_ms: 0,
    open,
    high: Math.max(open, close) + spread,
    low: Math.min(open, close) - spread,
    close,
    ticks: 12,
  };
}

/** Stepping lower highs + lower lows. */
function clearDowntrend(start = 2500, n = 14): TenSecBar[] {
  const out: TenSecBar[] = [];
  for (let i = 0; i < n; i++) {
    const o = start - i * 2.2;
    const c = o - 1.8;
    out.push(bar(o, c));
  }
  return out;
}

function clearUptrend(start = 2400, n = 14): TenSecBar[] {
  const out: TenSecBar[] = [];
  for (let i = 0; i < n; i++) {
    const o = start + i * 2.2;
    const c = o + 1.8;
    out.push(bar(o, c));
  }
  return out;
}

describe('entryDirectionGate — trend classification', () => {
  it('detects STRONG_DOWN from lower highs + lower lows + bearish momentum', () => {
    const bars = clearDowntrend();
    expect(analyzeStructure(bars)).toBe('LOWER_HIGH_LOWER_LOW');
    expect(classifyMarketTrend(bars, 'TREND_DOWN', 'DOWN')).toBe('STRONG_DOWN');
  });

  it('detects STRONG_UP from higher highs + higher lows', () => {
    const bars = clearUptrend();
    expect(analyzeStructure(bars)).toBe('HIGHER_HIGH_HIGHER_LOW');
    expect(classifyMarketTrend(bars, 'TREND_UP', 'UP')).toBe('STRONG_UP');
  });
});

describe('entryDirectionGate — hard direction gate (spec cases 1–10)', () => {
  const downBars = clearDowntrend();
  const upBars = clearUptrend();
  const lastDown = downBars[downBars.length - 1]!;
  const lastUp = upBars[upBars.length - 1]!;

  it('1. clear downtrend + BUY signal → BLOCK', () => {
    const v = evaluateEntryDirectionGate({
      direction: 'BUY',
      closedBars: downBars,
      bar: lastDown,
      regime: 'TREND_DOWN',
      bias: 'DOWN',
    });
    expect(v.final_entry).toBe('BLOCK');
    expect(v.block_reason).toMatch(/BUY_AGAINST/);
  });

  it('2. clear uptrend + SELL signal → BLOCK', () => {
    const v = evaluateEntryDirectionGate({
      direction: 'SELL',
      closedBars: upBars,
      bar: lastUp,
      regime: 'TREND_UP',
      bias: 'UP',
    });
    expect(v.final_entry).toBe('BLOCK');
    expect(v.block_reason).toMatch(/SELL_AGAINST/);
  });

  it('3. downtrend + valid SELL continuation → ALLOW', () => {
    const dumpBar = bar(lastDown.close + 0.5, lastDown.close - 1.2);
    const v = evaluateEntryDirectionGate({
      direction: 'SELL',
      closedBars: downBars,
      bar: dumpBar,
      regime: 'TREND_DOWN',
      bias: 'DOWN',
      setup: 'CONTINUATION',
    });
    expect(v.final_entry).toBe('ALLOW');
    expect(v.trend).toMatch(/DOWN|STRONG_DOWN/);
  });

  it('4. uptrend + valid BUY continuation → ALLOW', () => {
    const dipBar = bar(lastUp.close - 0.5, lastUp.close + 0.3);
    const v = evaluateEntryDirectionGate({
      direction: 'BUY',
      closedBars: upBars,
      bar: dipBar,
      regime: 'TREND_UP',
      bias: 'UP',
      setup: 'PULLBACK',
    });
    expect(v.final_entry).toBe('ALLOW');
    expect(v.trend).toMatch(/UP|STRONG_UP/);
  });

  it('5. downtrend + one bullish candle → BUY still BLOCK', () => {
    const bounce = bar(lastDown.close, lastDown.close + 1.5);
    const v = evaluateEntryDirectionGate({
      direction: 'BUY',
      closedBars: downBars,
      bar: bounce,
      regime: 'TREND_DOWN',
      bias: 'DOWN',
    });
    expect(v.final_entry).toBe('BLOCK');
    expect(v.reversal_confirmed).toBe(false);
  });

  it('6. downtrend + short bullish pullback → BUY still BLOCK', () => {
    const pullback = [
      bar(lastDown.close, lastDown.close + 0.8),
      bar(lastDown.close + 0.8, lastDown.close + 1.2),
    ];
    const bars = [...downBars, ...pullback];
    const v = evaluateEntryDirectionGate({
      direction: 'BUY',
      closedBars: bars,
      bar: pullback[1]!,
      regime: 'TREND_DOWN',
      bias: 'DOWN',
    });
    expect(v.final_entry).toBe('BLOCK');
    expect(confirmBullishReversal(bars, 'TREND_DOWN')).toBe(false);
  });

  it('7. downtrend + confirmed bullish structure reversal → BUY ALLOW', () => {
    const base = clearDowntrend(2500, 12);
    const reversal = [
      bar(2475, 2477),
      bar(2477, 2480),
      bar(2480, 2484),
      bar(2484, 2488),
      bar(2488, 2492),
    ];
    const bars = [...base, ...reversal];
    expect(confirmBullishReversal(bars, 'TREND_UP')).toBe(true);
    const v = evaluateEntryDirectionGate({
      direction: 'BUY',
      closedBars: bars,
      bar: reversal[reversal.length - 1]!,
      regime: 'TREND_UP',
      bias: 'UP',
      setup: 'REVERSAL',
    });
    expect(v.final_entry).toBe('ALLOW');
    expect(v.reversal_confirmed).toBe(true);
  });

  it('8. stale BUY signal + market now DOWN → BLOCK', () => {
    const v = evaluateEntryDirectionGate({
      direction: 'BUY',
      closedBars: downBars,
      bar: lastDown,
      regime: 'TREND_DOWN',
      bias: 'DOWN',
      signalAgeMs: 15_000,
    });
    expect(v.final_entry).toBe('BLOCK');
    expect(v.block_reason).toBe('STALE_SIGNAL');
  });

  it('9. RANGE/UNCERTAIN does not invent trend block', () => {
    const flat = [bar(2500, 2500.1), bar(2500.1, 2499.9), bar(2499.9, 2500)];
    const v = evaluateEntryDirectionGate({
      direction: 'BUY',
      closedBars: flat,
      bar: flat[flat.length - 1]!,
      regime: 'RANGE',
      bias: 'FLAT',
    });
    expect(['RANGE', 'UNCERTAIN']).toContain(v.trend);
    expect(v.final_entry).toBe('ALLOW');
  });

  it('10. BUY/SELL logic is symmetric', () => {
    const buyBlock = evaluateEntryDirectionGate({
      direction: 'BUY',
      closedBars: downBars,
      bar: lastDown,
      regime: 'TREND_DOWN',
      bias: 'DOWN',
    });
    const sellBlock = evaluateEntryDirectionGate({
      direction: 'SELL',
      closedBars: upBars,
      bar: lastUp,
      regime: 'TREND_UP',
      bias: 'UP',
    });
    expect(buyBlock.final_entry).toBe('BLOCK');
    expect(sellBlock.final_entry).toBe('BLOCK');
    expect(buyBlock.block_reason).toContain('BUY');
    expect(sellBlock.block_reason).toContain('SELL');
  });
});

describe('entryDirectionGate — deskEntry integration', () => {
  it('resolveDeskEntry blocks C++ BUY in clear downtrend with diagnostic', () => {
    const downBars = clearDowntrend();
    const last = downBars[downBars.length - 1]!;
    const e = resolveDeskEntry({
      intended: 'BUY',
      intendedSetup: 'CONTINUATION',
      intendedReason: 'CALC vein long',
      bar: last,
      closedBars: downBars,
      regime: 'TREND_DOWN',
      bias: 'DOWN',
      capitalMid: last.close,
      refs: [
        { label: 'Gold-API spot (public)', mid: last.close },
        { label: 'Coinbase spot (public)', mid: last.close },
        { label: 'Kraken spot (public)', mid: last.close },
      ],
    });
    expect(e.direction).toBeNull();
    expect(e.reason).toMatch(/TREND_GATE|REGIME_BLOCK|CALC_BLOCK|CONCEPT_BLOCK/);
  });
});

describe('entryDirectionGate — bearish reversal symmetry', () => {
  it('confirmBearishReversal after sustained uptrend', () => {
    const base = clearUptrend(2400, 12);
    const reversal = [
      bar(2625, 2622),
      bar(2622, 2618),
      bar(2618, 2613),
      bar(2613, 2608),
      bar(2608, 2602),
    ];
    const bars = [...base, ...reversal];
    expect(confirmBearishReversal(bars, 'TREND_DOWN')).toBe(true);
  });
});
