import { describe, expect, it, beforeEach } from 'vitest';
import {
  defaultDeskCalibration,
  getDeskCalibration,
  regimeAllowedForEntry,
  setDeskCalibration,
  _resetDeskCalibrationCacheForTests,
} from './deskCalibration.js';
import { _resetBrainGenomeForTests } from '../brainSelfImprove/brainGenome.js';

describe('deskCalibration', () => {
  beforeEach(() => {
    _resetDeskCalibrationCacheForTests();
    _resetBrainGenomeForTests();
    setDeskCalibration(defaultDeskCalibration());
  });

  it('isolates calibration per client_id on disk; genome SoT shares Soft/Target', () => {
    setDeskCalibration({ target_abs: 5 }, 1);
    setDeskCalibration({ target_abs: 9 }, 2);
    // Genome wins Soft/Peak/Target — last synced write is SoT for all clients
    expect(getDeskCalibration(1).target_abs).toBe(9);
    expect(getDeskCalibration(2).target_abs).toBe(9);
  });

  it('defaults positive R:R — HardInv CAP 2.2 / Peak MFE ≥3 / Target ≥5', () => {
    const c = getDeskCalibration();
    expect(c.hardinv_abs).toBe(2.2);
    expect(c.peak_retention).toBe(0.72);
    expect(c.peak_mfe_abs).toBe(3.0);
    expect(c.peak_min_giveback_abs).toBeGreaterThanOrEqual(0.85);
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

  it('defaults soft_off_regimes empty', () => {
    expect(getDeskCalibration().soft_off_regimes).toEqual([]);
  });

  it('genome Soft L1 overrides desk file on getDeskCalibration', () => {
    _resetBrainGenomeForTests({ soft_l1_abs: 0.9, soft_l2_abs: 1.4, soft_l3_abs: 2.0 });
    _resetDeskCalibrationCacheForTests();
    const c = getDeskCalibration();
    expect(c.soft_l1_abs).toBe(0.9);
    expect(c.soft_l2_abs).toBe(1.4);
    expect(c.hardinv_abs).toBe(2.0);
  });
});
