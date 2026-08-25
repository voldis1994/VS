import { describe, expect, it } from 'vitest';
import {
  HARD_INV_GOLD_PT,
  SHORT_THESIS_MOVE_PCT,
  hardInvalidationDistance,
} from './microScalpThresholds.js';

describe('microScalpThresholds', () => {
  it('HardInv ~2.5pt on Gold — not 7pt (0.15%)', () => {
    expect(hardInvalidationDistance(4660)).toBe(HARD_INV_GOLD_PT);
    expect(HARD_INV_GOLD_PT).toBeLessThan(4660 * 0.0015);
    expect(HARD_INV_GOLD_PT).toBeLessThan(4660 * 0.002);
  });

  it('short thesis pct matches ~2.5pt at Gold mid', () => {
    expect(SHORT_THESIS_MOVE_PCT * 4660).toBeCloseTo(HARD_INV_GOLD_PT, 0);
  });
});
