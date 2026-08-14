import { describe, expect, it } from 'vitest';
import {
  computeSafetyCushionStopLevel,
  isLateMoveOnOneMinute,
} from './capitalCom.js';

describe('safety SL cushion', () => {
  it('places BUY stop at ~0.20% of price (not Capital min-only)', () => {
    const mid = 2000;
    const level = computeSafetyCushionStopLevel('BUY', mid, {
      bid: 1999.8,
      ask: 2000.2,
      spread: 0.4,
      minStopDistance: 0.5,
    });
    const dist = mid - level;
    expect(dist).toBeGreaterThanOrEqual(mid * 0.002);
    expect(dist).toBeLessThan(mid * 0.005);
  });

  it('on Gold ~4375 yields ~8–9pt stop from 0.20% of price', () => {
    const mid = 4375;
    const level = computeSafetyCushionStopLevel('BUY', mid, {
      bid: 4374.8,
      ask: 4375.2,
      spread: 0.4,
      minStopDistance: 0.4,
    });
    const dist = mid - level;
    expect(dist).toBeGreaterThanOrEqual(8);
    expect(dist).toBeLessThan(12);
  });
});

describe('1m late-move gate', () => {
  it('blocks BUY after strong green 1m candle', () => {
    expect(
      isLateMoveOnOneMinute('BUY', [{ open: 2000, high: 2005, low: 1999, close: 2004 }])
    ).toBe(true);
  });
  it('allows BUY on flat/red 1m candle', () => {
    expect(
      isLateMoveOnOneMinute('BUY', [{ open: 2000, high: 2000.2, low: 1999.5, close: 1999.8 }])
    ).toBe(false);
  });
});
