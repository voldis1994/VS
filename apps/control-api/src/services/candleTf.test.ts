import { describe, expect, it } from 'vitest';
import {
  aggregateMinutes,
  barBodyPressure,
  countCandlePolarity,
  toCompactBar,
  type OhlcBar,
} from './candleTf.js';

function bar(o: number, h: number, l: number, c: number): OhlcBar {
  return { open: o, high: h, low: l, close: c };
}

describe('candleTf', () => {
  it('aggregates 1m into 5m dropping incomplete bucket', () => {
    const mins: OhlcBar[] = [];
    for (let i = 0; i < 12; ++i) {
      mins.push(bar(100 + i, 101 + i, 99 + i, 100.5 + i));
    }
    const five = aggregateMinutes(mins, 5);
    expect(five).toHaveLength(2);
    expect(five[0]!.open).toBe(102);
    expect(five[0]!.close).toBe(106.5);
    expect(five[1]!.open).toBe(107);
    expect(five[1]!.close).toBe(111.5);
  });

  it('counts last 200 bullish vs bearish closes', () => {
    const mins: OhlcBar[] = [];
    for (let i = 0; i < 200; ++i) {
      if (i < 120) mins.push(bar(100, 101, 99, 100.5));
      else mins.push(bar(100, 101, 99, 99.5));
    }
    const pol = countCandlePolarity(mins, 200);
    expect(pol.n).toBe(200);
    expect(pol.bullish).toBe(120);
    expect(pol.bearish).toBe(80);
    expect(pol.doji).toBe(0);
  });

  it('body pressure is positive on green window', () => {
    const mins = [bar(100, 101, 99, 100.8), bar(100.8, 102, 100, 101.5)];
    expect(barBodyPressure(mins)).toBeGreaterThan(0);
    expect(toCompactBar(mins[0]!)).toEqual({ o: 100, h: 101, l: 99, c: 100.8 });
  });
});
