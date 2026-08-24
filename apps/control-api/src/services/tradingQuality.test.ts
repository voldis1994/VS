import { describe, expect, it } from 'vitest';
import {
  computeSafetyCushionStopLevel,
  isLateMoveOnOneMinute,
} from './capitalCom.js';

describe('safety SL cushion', () => {
  it('places BUY stop well below mid (~0.50% disaster cushion), not at spread min', () => {
    const mid = 2000;
    const level = computeSafetyCushionStopLevel('BUY', mid, {
      bid: 1999.8,
      ask: 2000.2,
      spread: 0.4,
      minStopDistance: 0.5,
    });
    expect(level).toBeLessThan(mid - 8);
    expect(mid - level).toBeGreaterThanOrEqual(mid * 0.004 - 0.5);
    expect(mid - level).toBeLessThan(mid * 0.006 + 0.5);
  });
});

describe('1m late-move gate', () => {
  it('blocks BUY after strong green 1m candle', () => {
    expect(
      isLateMoveOnOneMinute('BUY', [{ open: 2000, high: 2005, low: 1999, close: 2004 }])
    ).toBe(true);
  });
  it('blocks BUY after ~3pt Gold 1m stretch (was allowed at 0.12%)', () => {
    expect(
      isLateMoveOnOneMinute('BUY', [{ open: 4500, high: 4504, low: 4499.5, close: 4503.2 }])
    ).toBe(true);
  });
  it('blocks BUY when last 2–3 minutes already ran the same way', () => {
    expect(
      isLateMoveOnOneMinute('BUY', [
        { open: 4500, high: 4501.5, low: 4499.8, close: 4501.2 },
        { open: 4501.2, high: 4503, low: 4501, close: 4502.8 },
        { open: 4502.8, high: 4505, low: 4502.5, close: 4504.5 },
      ])
    ).toBe(true);
  });
  it('allows BUY on flat/red 1m candle', () => {
    expect(
      isLateMoveOnOneMinute('BUY', [{ open: 2000, high: 2000.2, low: 1999.5, close: 1999.8 }])
    ).toBe(false);
  });
});
