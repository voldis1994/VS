import { describe, expect, it } from 'vitest';
import {
  computeSafetyCushionStopLevel,
  computeMarketBehaviorStopLevel,
  isLateMoveOnOneMinute,
  SAFETY_SL_GOLD_FLOOR,
  SAFETY_SL_REL,
} from './capitalCom.js';

describe('safety SL cushion', () => {
  it('uses ~0.13% / 0.004÷3 of price (3× tighter than 0.40%)', () => {
    expect(SAFETY_SL_REL).toBeCloseTo(0.004 / 3, 10);
    expect(SAFETY_SL_GOLD_FLOOR).toBe(4);
    const mid = 2000;
    const level = computeSafetyCushionStopLevel('BUY', mid, {
      bid: 1999.8,
      ask: 2000.2,
      spread: 0.4,
      minStopDistance: 0.5,
    });
    const dist = mid - level;
    expect(dist).toBeGreaterThanOrEqual(mid * SAFETY_SL_REL);
    expect(dist).toBeLessThan(mid * 0.004);
  });

  it('on Gold ~4353 yields ~5–6pt stop from 0.13% of price (not ~17pt)', () => {
    const mid = 4353;
    const level = computeSafetyCushionStopLevel('BUY', mid, {
      bid: 4352.93,
      ask: 4353.23,
      spread: 0.3,
      minStopDistance: 0.4,
    });
    const dist = mid - level;
    expect(dist).toBeGreaterThanOrEqual(Math.max(mid * SAFETY_SL_REL, SAFETY_SL_GOLD_FLOOR));
    expect(dist).toBeLessThan(12);
    expect(dist).toBeCloseTo(mid * SAFETY_SL_REL, 0);
  });

  it('BUY entry=4410.74 → SL ≈ 4404.9 (~0.13%)', () => {
    const entry = 4410.74;
    const level = computeSafetyCushionStopLevel('BUY', entry, {
      bid: 4410.54,
      ask: 4410.94,
      spread: 0.4,
      minStopDistance: 0.4,
    });
    expect(entry - level).toBeCloseTo(entry * SAFETY_SL_REL, 0);
    expect(entry - level).toBeGreaterThanOrEqual(SAFETY_SL_GOLD_FLOOR);
  });

  it('SELL entry=4410.74 → SL ≈ 4416.6 (~0.13%)', () => {
    const entry = 4410.74;
    const level = computeSafetyCushionStopLevel('SELL', entry, {
      bid: 4410.54,
      ask: 4410.94,
      spread: 0.4,
      minStopDistance: 0.4,
    });
    expect(level - entry).toBeCloseTo(entry * SAFETY_SL_REL, 0);
    expect(level - entry).toBeGreaterThanOrEqual(SAFETY_SL_GOLD_FLOOR);
  });

  it('does not regress to 2.5% or old 0.40% (BUY 4410.74)', () => {
    const entry = 4410.74;
    const level = computeSafetyCushionStopLevel('BUY', entry, {
      bid: 4410.54,
      ask: 4410.94,
      spread: 0.4,
      minStopDistance: 0.4,
    });
    const dist = entry - level;
    expect(dist).toBeLessThan(12);
    expect(dist).toBeGreaterThan(SAFETY_SL_GOLD_FLOOR - 0.1);
    expect(dist).toBeLessThan(entry * 0.004);
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

describe('market-behavior SL (swing based)', () => {
  it('BUY uses recent swing LOW - buffer', () => {
    const entry = 2000;
    const recent = [
      { high: 2003, low: 1995 },
      { high: 2002, low: 1996 },
      { high: 2005, low: 1997 },
    ];
    const stop = computeMarketBehaviorStopLevel('BUY', entry, recent, { minStopDistance: 0.5, lookback: 3 });
    expect(stop).not.toBeNull();
    if (stop == null) return;
    expect(stop).toBeLessThan(entry);
    // should be below swing low
    expect(stop).toBeLessThan(Math.min(...recent.map((c) => c.low)));
  });

  it('SELL uses recent swing HIGH + buffer', () => {
    const entry = 2000;
    const recent = [
      { high: 2003, low: 1995 },
      { high: 2002, low: 1996 },
      { high: 2005, low: 1997 },
    ];
    const stop = computeMarketBehaviorStopLevel('SELL', entry, recent, { minStopDistance: 0.5, lookback: 3 });
    expect(stop).not.toBeNull();
    if (stop == null) return;
    expect(stop).toBeGreaterThan(entry);
    expect(stop).toBeGreaterThan(Math.max(...recent.map((c) => c.high)));
  });
});
