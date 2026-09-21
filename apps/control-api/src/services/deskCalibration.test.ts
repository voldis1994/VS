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

  it('defaults scalp HardInv 2 / Peak keep 80% / Target 2.25', () => {
    const c = getDeskCalibration();
    expect(c.hardinv_abs).toBe(2);
    expect(c.peak_retention).toBe(0.8);
    expect(c.peak_mfe_abs).toBe(0.9);
    expect(c.peak_min_giveback_abs).toBe(0.45);
    expect(c.target_abs).toBe(2.25);
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
