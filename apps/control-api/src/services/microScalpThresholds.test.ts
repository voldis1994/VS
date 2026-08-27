import { describe, expect, it } from 'vitest';
import {
  SAFETY_SL_PCT,
  SHORT_THESIS_MOVE_PCT,
  hardInvalidationDistance,
  shortThesisPts,
} from './microScalpThresholds.js';

describe('microScalpThresholds — universal', () => {
  it('HardInv scales with price (no Gold abs>=1000 branch)', () => {
    const gold = hardInvalidationDistance(4660);
    expect(gold).toBeCloseTo(4660 * 0.00043, 2);
    expect(gold).toBeLessThan(4660 * SAFETY_SL_PCT);
  });

  it('short thesis pts scale universally', () => {
    const pts = shortThesisPts(4660);
    expect(pts).toBeGreaterThan(hardInvalidationDistance(4660));
    expect(SHORT_THESIS_MOVE_PCT).toBeCloseTo(3 / 4660, 8);
  });

  it('Safety SL cushion ~0.20% — wider than HardInv', () => {
    expect(SAFETY_SL_PCT).toBe(0.002);
    expect(SAFETY_SL_PCT * 4660).toBeGreaterThan(hardInvalidationDistance(4660));
  });

  it('FX / index / crypto all produce positive distances', () => {
    expect(hardInvalidationDistance(1.085)).toBeGreaterThan(0);
    expect(hardInvalidationDistance(420)).toBeGreaterThan(0);
    expect(hardInvalidationDistance(67000)).toBeGreaterThan(0);
  });
});
