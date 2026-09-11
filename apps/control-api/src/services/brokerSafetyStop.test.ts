import { describe, expect, it } from 'vitest';
import {
  brokerSafetyStopDistance,
  safetyStopDistancePts,
} from './robotDesk.js';

describe('brokerSafetyStopDistance — backup past Soft HardInv 1.5, not 0.2%', () => {
  it('Gold ~4388: distance ≈ 2pt, never ~9pt from 0.2%', () => {
    const d = brokerSafetyStopDistance(4388, 0.5, 0.3);
    expect(d).toBeGreaterThanOrEqual(2.0);
    expect(d).toBeLessThan(4.0);
  });

  it('respects larger broker minimum', () => {
    const d = brokerSafetyStopDistance(4388, 0.5, 3.0);
    expect(d).toBeGreaterThanOrEqual(3.0 * 1.05 - 1e-9);
  });
});

describe('safetyStopDistancePts — Capital POINTS path (was 0.2% bug)', () => {
  it('Gold pointSize=1 → ~2pts not ~9pts', () => {
    const pts = safetyStopDistancePts(4388, 0.3, 1);
    expect(pts).toBeGreaterThanOrEqual(2.0);
    expect(pts).toBeLessThan(4.0);
  });

  it('Gold pointSize=0.1 → price 2.0 / 0.1 = 20 Capital pts (still 2.0 price)', () => {
    const pts = safetyStopDistancePts(4388, 0.3, 0.1);
    expect(pts).toBeCloseTo(20, 5); // 2.0 price / 0.1
    // Must NOT be 0.2% → 4388*0.002/0.1 = 87.76
    expect(pts).toBeLessThan(30);
  });
});
