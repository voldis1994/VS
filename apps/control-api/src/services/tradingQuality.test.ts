import { describe, expect, it } from 'vitest';
import {
  computeSafetyCushionStopLevel,
  isLateMoveOnOneMinute,
} from './capitalCom.js';

describe('safety SL cushion', () => {
  it('places BUY stop below mid (~0.18% micro), ~30% tighter than 0.25%', () => {
    const mid = 2000;
    const level = computeSafetyCushionStopLevel('BUY', mid, {
      bid: 1999.8,
      ask: 2000.2,
      spread: 0.4,
      minStopDistance: 0.5,
    });
    expect(level).toBeLessThan(mid - 3);
    expect(mid - level).toBeGreaterThanOrEqual(mid * 0.00175 - 0.5);
    expect(mid - level).toBeLessThan(mid * 0.0025);
  });
});

describe('1m late-move gate', () => {
  it('never blocks BUY after strong green 1m candle', () => {
    expect(
      isLateMoveOnOneMinute('BUY', [{ open: 2000, high: 2005, low: 1999, close: 2004 }])
    ).toBe(false);
  });
  it('allows BUY on flat/red 1m candle', () => {
    expect(
      isLateMoveOnOneMinute('BUY', [{ open: 2000, high: 2000.2, low: 1999.5, close: 1999.8 }])
    ).toBe(false);
  });
});
