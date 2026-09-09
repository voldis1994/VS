import { describe, expect, it } from 'vitest';
import { expectancyByDeskSource } from '../expectancy.js';
import type { ExpectancySnapshot } from '../types.js';

function snap(setup_key: string, samples: number, ev: number): ExpectancySnapshot {
  return {
    setup_key,
    samples,
    p_win: ev > 0 ? 0.6 : 0.3,
    avg_win: 2,
    avg_loss: 1,
    costs: 0,
    ev,
    positive: ev > 0,
  };
}

describe('expectancyByDeskSource', () => {
  it('buckets setupKey suffixes so setup/move/none EV stay separate', () => {
    const slices = expectancyByDeskSource([
      snap('GOLD|BUY|TREND|UP|LONDON|setup', 4, 1.2),
      snap('GOLD|BUY|TREND|UP|LONDON|move', 6, -0.8),
      snap('GOLD|SELL|TREND|DOWN|NY|none', 2, 0.5),
      snap('LEGACY|BUY|TREND|UP|LONDON', 3, -0.2), // no desk suffix → none
    ]);
    const by = Object.fromEntries(slices.map((s) => [s.source, s]));
    expect(by.setup!.setups).toBe(1);
    expect(by.setup!.samples).toBe(4);
    expect(by.setup!.avg_ev).toBeCloseTo(1.2);
    expect(by.setup!.positive_setups).toBe(1);
    expect(by.move!.setups).toBe(1);
    expect(by.move!.samples).toBe(6);
    expect(by.move!.avg_ev).toBeCloseTo(-0.8);
    expect(by.none!.setups).toBe(2);
    expect(by.none!.samples).toBe(5);
    // sample-weighted: (0.5*2 + -0.2*3) / 5
    expect(by.none!.avg_ev).toBeCloseTo((0.5 * 2 + -0.2 * 3) / 5);
  });

  it('returns empty zero slices when store is empty', () => {
    const slices = expectancyByDeskSource([]);
    expect(slices.map((s) => s.source)).toEqual(['setup', 'move', 'none']);
    expect(slices.every((s) => s.samples === 0 && s.setups === 0)).toBe(true);
  });
});
