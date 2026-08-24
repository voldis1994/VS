import { describe, expect, it } from 'vitest';
import { clampBudgetPct, sizeFromBudgetPct } from './budgetSizing.js';

describe('budgetSizing', () => {
  it('clamps budget pct', () => {
    expect(clampBudgetPct(25)).toBe(25);
    expect(clampBudgetPct(0)).toBe(1);
    expect(clampBudgetPct(150)).toBe(100);
  });

  it('£100 account 25% on Gold ~4500 → size near 0.11 (5% margin)', () => {
    const r = sizeFromBudgetPct({
      equity: 100,
      budgetPct: 25,
      mid: 4500,
      minLot: 0.01,
      maxLot: 100,
      lotStep: 0.01,
      marginFactor: 0.05,
      category: 'metals',
    });
    // target 25 / (4500*0.05=225) ≈ 0.111 → 0.11
    expect(r.target_budget).toBe(25);
    expect(r.size).toBeGreaterThanOrEqual(0.1);
    expect(r.size).toBeLessThanOrEqual(0.12);
  });

  it('respects min lot when budget is tiny', () => {
    const r = sizeFromBudgetPct({
      equity: 10,
      budgetPct: 5,
      mid: 20000,
      minLot: 0.1,
      maxLot: 100,
      lotStep: 0.1,
      category: 'indices',
    });
    expect(r.size).toBe(0.1);
  });
});
