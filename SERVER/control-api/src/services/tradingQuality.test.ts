import { describe, expect, it } from 'vitest';
import {
  computeSafetyCushionStopLevel,
  isLateMoveOnOneMinute,
} from './capitalCom.js';

describe('safety SL cushion', () => {
  it('places BUY stop at ~2.5% of price (not Capital min-only)', () => {
    const mid = 2000;
    const level = computeSafetyCushionStopLevel('BUY', mid, {
      bid: 1999.8,
      ask: 2000.2,
      spread: 0.4,
      minStopDistance: 0.5,
    });
    const dist = mid - level;
    expect(dist).toBeGreaterThanOrEqual(mid * 0.025);
    expect(dist).toBeLessThan(mid * 0.04);
  });

  it('on Gold ~4375 yields ~109pt stop from 2.5% of price', () => {
    const mid = 4375;
    const level = computeSafetyCushionStopLevel('BUY', mid, {
      bid: 4374.8,
      ask: 4375.2,
      spread: 0.4,
      minStopDistance: 0.4,
    });
    const dist = mid - level;
    expect(dist).toBeGreaterThanOrEqual(mid * 0.025);
    expect(dist).toBeLessThan(mid * 0.04);
  });

  it('BUY entry=4410.74 → SL ≈ 4300.47 (2.5%)', () => {
    const entry = 4410.74;
    const level = computeSafetyCushionStopLevel('BUY', entry, {
      bid: 4410.54,
      ask: 4410.94,
      spread: 0.4,
      minStopDistance: 0.4,
    });
    // distance = 4410.74 * 0.025 = 110.2685 ≈ 110.27
    expect(level).toBeCloseTo(4300.47, 0);
    expect(entry - level).toBeCloseTo(110.27, 0);
  });

  it('SELL entry=4410.74 → SL ≈ 4521.01 (2.5%)', () => {
    const entry = 4410.74;
    const level = computeSafetyCushionStopLevel('SELL', entry, {
      bid: 4410.54,
      ask: 4410.94,
      spread: 0.4,
      minStopDistance: 0.4,
    });
    // distance = 4410.74 * 0.025 = 110.2685 ≈ 110.27
    expect(level).toBeCloseTo(4521.01, 0);
    expect(level - entry).toBeCloseTo(110.27, 0);
  });

  it('BUY decimal price 1850.50 → SL ≈ 2.5% below', () => {
    const entry = 1850.5;
    const level = computeSafetyCushionStopLevel('BUY', entry, {
      bid: 1850.3,
      ask: 1850.7,
      spread: 0.4,
      minStopDistance: 0.4,
    });
    const dist = entry - level;
    expect(dist).toBeGreaterThanOrEqual(entry * 0.025);
    expect(dist).toBeLessThan(entry * 0.04);
  });

  it('does not regress to 0.002 coefficient (BUY 4410.74)', () => {
    const entry = 4410.74;
    const level = computeSafetyCushionStopLevel('BUY', entry, {
      bid: 4410.54,
      ask: 4410.94,
      spread: 0.4,
      minStopDistance: 0.4,
    });
    const dist = entry - level;
    // 0.002 would give ~8.82; 0.025 gives ~110.27 — must be well above old value
    expect(dist).toBeGreaterThan(50);
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
