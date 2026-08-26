import { describe, expect, it } from 'vitest';
import {
  HARD_INV_GOLD_PT,
  SAFETY_SL_PCT,
  SHORT_THESIS_MOVE_PCT,
  hardInvalidationDistance,
} from './microScalpThresholds.js';

describe('microScalpThresholds', () => {
  it('HardInv ~0.6pt on Gold — one loss must not wipe a stack of micro wins', () => {
    expect(hardInvalidationDistance(4660)).toBe(HARD_INV_GOLD_PT);
    expect(HARD_INV_GOLD_PT).toBe(0.6);
    expect(HARD_INV_GOLD_PT).toBeLessThan(4660 * SAFETY_SL_PCT);
    // Old -£0.19 @ 0.09 ≈ 2.1pt must be impossible under HardInv
    expect(HARD_INV_GOLD_PT).toBeLessThan(1.2);
  });

  it('short thesis pct matches ~0.6pt at Gold mid', () => {
    expect(SHORT_THESIS_MOVE_PCT * 4660).toBeCloseTo(HARD_INV_GOLD_PT, 0);
  });

  it('Safety SL cushion ~0.04% — not the old 0.20% hole', () => {
    expect(SAFETY_SL_PCT).toBe(0.0004);
    expect(SAFETY_SL_PCT).toBeLessThan(0.001);
  });
});
