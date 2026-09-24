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

  it('defaults positive R:R — HardInv CAP 2.2 / Peak MFE ≥3 / Target ≥5', () => {
    const c = getDeskCalibration();
    expect(c.hardinv_abs).toBe(2.2);
    expect(c.peak_retention).toBe(0.65);
    expect(c.peak_mfe_abs).toBe(3.0);
    expect(c.peak_min_giveback_abs).toBe(0.85);
    expect(c.target_abs).toBe(5.0);
    expect(c.safety_tp_rr).toBe(1.5);
    expect(c.entry_filter_level).toBe(0);
    expect(c.enabled_regimes.includes('TREND_UP')).toBe(true);
    expect(c.enabled_regimes.includes('UNKNOWN')).toBe(false);
    expect(c.enabled_regimes.includes('COMPRESSION')).toBe(true);
    expect(c.enabled_regimes.includes('TRANSITION')).toBe(true);
    expect(c.enabled_regimes.includes('TREND_UP')).toBe(true);
  });

  it('clamps peak_retention and filters UNKNOWN', () => {
    const c = setDeskCalibration({
      peak_retention: 1.5,
      enabled_regimes: ['TREND_UP', 'UNKNOWN', 'bogus'] as never,
    });
    expect(c.peak_retention).toBeLessThanOrEqual(0.95);
    expect(c.enabled_regimes).toEqual(['TREND_UP']);
  });

  it('keeps COMPRESSION/TRANSITION; only UNKNOWN filtered', () => {
    const c = setDeskCalibration({
      enabled_regimes: ['TREND_UP', 'COMPRESSION', 'TRANSITION', 'UNKNOWN'] as never,
    });
    expect(c.enabled_regimes.sort()).toEqual(['COMPRESSION', 'TRANSITION', 'TREND_UP'].sort());
  });

  it('regimeAllowedForEntry respects allowlist', () => {
    setDeskCalibration({ enabled_regimes: ['BREAKOUT_UP'] });
    expect(regimeAllowedForEntry('BREAKOUT_UP')).toBe(true);
    expect(regimeAllowedForEntry('TREND_UP')).toBe(false);
    expect(regimeAllowedForEntry('UNKNOWN')).toBe(false);
  });
});
