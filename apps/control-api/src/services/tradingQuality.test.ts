import { describe, expect, it } from 'vitest';
import {
  computeSafetyCushionStopLevel,
  isLateMoveOnFiveMinute,
} from './capitalCom.js';

describe('safety SL cushion', () => {
  it('places BUY stop below mid (~0.20%) — wider than HardInv ~2.5pt', () => {
    const mid = 2000;
    const level = computeSafetyCushionStopLevel('BUY', mid, {
      bid: 1999.8,
      ask: 2000.2,
      spread: 0.4,
      minStopDistance: 0.5,
    });
    expect(level).toBeLessThan(mid);
    const dist = mid - level;
    expect(dist).toBeGreaterThanOrEqual(mid * 0.002 - 0.5);
    expect(dist).toBeLessThan(mid * 0.0035);
  });
});

describe('late-move gate', () => {
  it('blocks BUY after strong green net', () => {
    expect(
      isLateMoveOnFiveMinute('BUY', [
        { open: 4600, high: 4602, low: 4599, close: 4601 },
        { open: 4601, high: 4608, low: 4600, close: 4607 },
        { open: 4607, high: 4616, low: 4606, close: 4615 },
      ])
    ).toBe(true);
  });
  it('allows BUY on flat/red net', () => {
    expect(
      isLateMoveOnFiveMinute('BUY', [
        { open: 4600, high: 4601, low: 4598, close: 4599 },
        { open: 4599, high: 4600, low: 4597, close: 4598 },
        { open: 4598, high: 4599, low: 4596, close: 4597 },
      ])
    ).toBe(false);
  });
});
