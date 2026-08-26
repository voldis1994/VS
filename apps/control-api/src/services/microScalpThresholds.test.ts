import { describe, expect, it } from 'vitest';
import {
  HARD_INV_GOLD_PT,
  SHORT_THESIS_MOVE_PCT,
  hardInvalidationDistance,
} from './microScalpThresholds.js';

describe('microScalpThresholds', () => {
  it('HardInv ~1.2pt on Gold — cuts before Safety SL ~0.08%', () => {
    expect(hardInvalidationDistance(4660)).toBe(HARD_INV_GOLD_PT);
    expect(HARD_INV_GOLD_PT).toBe(1.2);
    expect(HARD_INV_GOLD_PT).toBeLessThan(4660 * 0.0008);
    expect(HARD_INV_GOLD_PT).toBeLessThan(4660 * 0.002);
  });

  it('short thesis pct matches ~1.2pt at Gold mid', () => {
    expect(SHORT_THESIS_MOVE_PCT * 4660).toBeCloseTo(HARD_INV_GOLD_PT, 0);
  });
});
