import { describe, expect, it } from 'vitest';
import {
  computeSafetyCushionStopLevel,
  isLateMoveOnOneMinute,
  SAFETY_SL_REL,
} from './capitalCom.js';

describe('safety SL cushion', () => {
  it('uses 0.25% / 0.00250 of price (not 2.5% and not Capital min-only)', () => {
    expect(SAFETY_SL_REL).toBe(0.0025);
    const mid = 2000;
    const level = computeSafetyCushionStopLevel('BUY', mid, {
      bid: 1999.8,
      ask: 2000.2,
      spread: 0.4,
      minStopDistance: 0.5,
    });
    const dist = mid - level;
    expect(dist).toBeGreaterThanOrEqual(mid * 0.0025);
    expect(dist).toBeLessThan(mid * 0.01);
  });

  it('on Gold ~4353 yields ~11pt stop from 0.25% of price', () => {
    const mid = 4353;
    const level = computeSafetyCushionStopLevel('BUY', mid, {
      bid: 4352.93,
      ask: 4353.23,
      spread: 0.3,
      minStopDistance: 0.4,
    });
    const dist = mid - level;
    expect(dist).toBeGreaterThanOrEqual(mid * 0.0025);
    expect(dist).toBeLessThan(20);
    expect(dist).toBeCloseTo(mid * 0.0025, 0);
  });

  it('BUY entry=4410.74 → SL ≈ 4399.71 (0.25%)', () => {
    const entry = 4410.74;
    const level = computeSafetyCushionStopLevel('BUY', entry, {
      bid: 4410.54,
      ask: 4410.94,
      spread: 0.4,
      minStopDistance: 0.4,
    });
    expect(level).toBeCloseTo(4399.71, 0);
    expect(entry - level).toBeCloseTo(11.03, 0);
  });

  it('SELL entry=4410.74 → SL ≈ 4421.77 (0.25%)', () => {
    const entry = 4410.74;
    const level = computeSafetyCushionStopLevel('SELL', entry, {
      bid: 4410.54,
      ask: 4410.94,
      spread: 0.4,
      minStopDistance: 0.4,
    });
    expect(level).toBeCloseTo(4421.77, 0);
    expect(level - entry).toBeCloseTo(11.03, 0);
  });

  it('does not regress to 2.5% (BUY 4410.74)', () => {
    const entry = 4410.74;
    const level = computeSafetyCushionStopLevel('BUY', entry, {
      bid: 4410.54,
      ask: 4410.94,
      spread: 0.4,
      minStopDistance: 0.4,
    });
    const dist = entry - level;
    // 2.5% would give ~110; 0.25% gives ~11
    expect(dist).toBeLessThan(30);
    expect(dist).toBeGreaterThan(8);
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
