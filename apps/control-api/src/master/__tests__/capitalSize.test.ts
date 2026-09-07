import { describe, expect, it } from 'vitest';
import {
  capitalDealRulesFallback,
  clampSizeForBuyingPower,
  normalizeCapitalDealSize,
  normalizeSizeForEpic,
  isCapitalSizeError,
  isCapitalRiskCheckError,
  suggestMaxLotForEquity,
} from '../capitalSize.js';

describe('VS MASTER capital size (VS-System-)', () => {
  it('normalizes gold size to step 0.01', () => {
    const rules = capitalDealRulesFallback('GOLD');
    expect(rules.minSize).toBe(0.01);
    const n = normalizeCapitalDealSize(0.013, rules);
    expect(n.size).toBe(0.02);
    expect(n.adjusted).toBe(true);
  });

  it('index micro lots use 0.001 step', () => {
    const n = normalizeSizeForEpic('US100', 0.0015);
    expect(n.rules.step).toBe(0.001);
    expect(n.size).toBe(0.002);
  });

  it('clampSizeForBuyingPower caps oversized gold lots', () => {
    expect(suggestMaxLotForEquity(100, 'GOLD')).toBe(0.01);
    const c = clampSizeForBuyingPower({
      epic: 'GOLD',
      size: 0.5,
      equity: 100,
      available_to_deal: 80,
    });
    expect(c.size).toBeLessThanOrEqual(0.01);
    expect(c.adjusted).toBe(true);
  });

  it('classifies size and risk-check errors', () => {
    expect(isCapitalSizeError('error.positive.createpositionrequest.size')).toBe(true);
    expect(isCapitalRiskCheckError('RISK_CHECK')).toBe(true);
    expect(isCapitalRiskCheckError('ok')).toBe(false);
  });
});
