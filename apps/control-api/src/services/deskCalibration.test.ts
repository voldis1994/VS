import { describe, expect, it, beforeEach } from 'vitest';
import {
  defaultDeskCalibration,
  getDeskCalibration,
  regimeAllowedForEntry,
  setDeskCalibration,
} from './deskCalibration.js';

describe('deskCalibration', () => {
  beforeEach(() => {
    setDeskCalibration(defaultDeskCalibration());
  });

  it('defaults HardInv 1.5 / Peak keep 75% / Target 4', () => {
    const c = getDeskCalibration();
    expect(c.hardinv_abs).toBe(1.5);
    expect(c.peak_retention).toBe(0.75);
    expect(c.target_abs).toBe(4);
    expect(c.enabled_regimes.includes('TREND_UP')).toBe(true);
    expect(c.enabled_regimes.includes('UNKNOWN')).toBe(false);
  });

  it('clamps peak_retention and filters UNKNOWN', () => {
    const c = setDeskCalibration({
      peak_retention: 1.5,
      enabled_regimes: ['TREND_UP', 'UNKNOWN', 'bogus'] as never,
    });
    expect(c.peak_retention).toBeLessThanOrEqual(0.95);
    expect(c.enabled_regimes).toEqual(['TREND_UP']);
  });

  it('regimeAllowedForEntry respects allowlist', () => {
    setDeskCalibration({ enabled_regimes: ['BREAKOUT_UP'] });
    expect(regimeAllowedForEntry('BREAKOUT_UP')).toBe(true);
    expect(regimeAllowedForEntry('TREND_UP')).toBe(false);
    expect(regimeAllowedForEntry('UNKNOWN')).toBe(false);
  });
});
