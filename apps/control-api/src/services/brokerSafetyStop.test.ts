import { describe, expect, it } from 'vitest';
import { brokerSafetyStopDistance } from './robotDesk.js';

describe('brokerSafetyStopDistance — backup past Soft HardInv 1.5, not 0.2%', () => {
  it('Gold ~4388: distance ≈ 2pt, never ~9pt from 0.2%', () => {
    const d = brokerSafetyStopDistance(4388, 0.5, 0.3);
    expect(d).toBeGreaterThanOrEqual(2.0);
    expect(d).toBeLessThan(4.0); // must NOT be ~8.8 (0.2%)
  });

  it('respects larger broker minimum', () => {
    const d = brokerSafetyStopDistance(4388, 0.5, 3.0);
    expect(d).toBeGreaterThanOrEqual(3.0 * 1.05 - 1e-9);
  });
});
