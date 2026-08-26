import { describe, expect, it } from 'vitest';
import {
  HARD_INV_GOLD_PT,
  SAFETY_SL_PCT,
  SHORT_THESIS_MOVE_PCT,
  hardInvalidationDistance,
} from './microScalpThresholds.js';

describe('microScalpThresholds', () => {
  it('HardInv 2.0pt on Gold', () => {
    expect(hardInvalidationDistance(4660)).toBe(HARD_INV_GOLD_PT);
    expect(HARD_INV_GOLD_PT).toBe(2.0);
    expect(HARD_INV_GOLD_PT).toBeLessThan(4660 * SAFETY_SL_PCT);
  });

  it('short thesis pct matches ~2.0pt at Gold mid', () => {
    expect(SHORT_THESIS_MOVE_PCT * 4660).toBeCloseTo(HARD_INV_GOLD_PT, 0);
  });

  it('Safety SL cushion ~0.08% — wider than HardInv 2.0pt', () => {
    expect(SAFETY_SL_PCT).toBe(0.0008);
    expect(SAFETY_SL_PCT * 4660).toBeGreaterThan(HARD_INV_GOLD_PT);
  });
});
