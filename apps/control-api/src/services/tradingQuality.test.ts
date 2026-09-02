import { describe, expect, it } from 'vitest';
import {
  computeSafetyCushionStopLevel,
  isLateMoveOnOneMinute,
} from './capitalCom.js';

describe('safety SL cushion', () => {
  it('places BUY stop well below mid (~0.20%), not at spread min', () => {
    const mid = 2000;
    const level = computeSafetyCushionStopLevel('BUY', mid, {
      bid: 1999.8,
      ask: 2000.2,
      spread: 0.4,
      minStopDistance: 0.5,
    });
    expect(level).toBeLessThan(mid - 3);
    expect(mid - level).toBeGreaterThanOrEqual(mid * 0.002 - 0.01);
    expect(mid - level).toBeLessThan(mid * 0.0025 + 0.5);
  });
});

describe('1m late-move gate', () => {
  it('blocks BUY after ~4pt+ green Gold 1m (tip of spike)', () => {
    expect(
      isLateMoveOnOneMinute('BUY', [{ open: 4317, high: 4326, low: 4316.5, close: 4325.5 }])
    ).toBe(true);
    expect(
      isLateMoveOnOneMinute('BUY', [{ open: 2000, high: 2008, low: 1999, close: 2006 }])
    ).toBe(true);
    // Small 1–2pt tick — still allow
    expect(
      isLateMoveOnOneMinute('BUY', [{ open: 4320, high: 4321.2, low: 4319.8, close: 4321 }])
    ).toBe(false);
  });
  it('allows BUY on flat/red 1m candle', () => {
    expect(
      isLateMoveOnOneMinute('BUY', [{ open: 2000, high: 2000.2, low: 1999.5, close: 1999.8 }])
    ).toBe(false);
  });
});
