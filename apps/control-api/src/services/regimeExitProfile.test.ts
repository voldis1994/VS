import { describe, expect, it, beforeEach } from 'vitest';
import { REGIME_NAMES } from './regimes.js';
import {
  byRegimeExitProfiles,
  exitProfilesFromGenome,
  peakRetentionFromGenome,
  regimeExitFamily,
  regimeExitProfile,
  shouldArmPeakProtect,
  structureInvalidationReason,
} from './regimeExitProfile.js';
import { _resetBrainGenomeForTests, getBrainGenome } from '../brainSelfImprove/brainGenome.js';

describe('regimeExitProfile — all 14 regimes', () => {
  beforeEach(() => {
    _resetBrainGenomeForTests({});
  });

  it('maps every regime to a profile without fallthrough', () => {
    for (const r of REGIME_NAMES) {
      const p = regimeExitProfile(r);
      expect(p.family).toBeTruthy();
      expect(p.hardinv_mult).toBeGreaterThan(0);
      expect(p.target_mult).toBeGreaterThan(0);
      expect(p.timedecay_hold_ms).toBeGreaterThan(60_000);
    }
  });

  it('factory genome matches prior hardcoded family table', () => {
    const g = getBrainGenome();
    const by = byRegimeExitProfiles(g);
    expect(by.TREND_UP.hardinv_mult).toBe(1);
    expect(by.TREND_UP.peak_retention).toBeNull();
    expect(by.TREND_UP.target_mult).toBe(1.15);
    expect(by.TREND_UP.timedecay_hold_ms).toBe(840_000);
    expect(by.TREND_UP.structure).toBe('none');
    expect(by.RANGE.family).toBe('fade');
    expect(by.RANGE.peak_retention).toBe(0.7);
    expect(by.RANGE.structure).toBe('through_mid');
    expect(by.BREAKOUT_UP.structure).toBe('back_in_range');
    expect(by.FAILED_BREAKOUT_UP.family).toBe('break_fail');
    expect(by.REVERSAL_CANDIDATE.peak_arm).toBe('fast');
    expect(peakRetentionFromGenome(0)).toBeNull();
    expect(peakRetentionFromGenome(0.7)).toBe(0.7);
    expect(exitProfilesFromGenome(g).trend.peak_arm).toBe('reverse_1m');
  });

  it('TREND lets winners run; RANGE/FAILED still shorter hold — but Target never < Soft', () => {
    const trend = regimeExitProfile('TREND_UP');
    const range = regimeExitProfile('RANGE');
    const failed = regimeExitProfile('FAILED_BREAKOUT_UP');
    expect(trend.family).toBe('trend');
    expect(range.family).toBe('fade');
    expect(failed.family).toBe('break_fail');
    expect(range.target_mult).toBeLessThan(trend.target_mult);
    expect(failed.target_mult).toBeLessThanOrEqual(trend.target_mult);
    expect(range.timedecay_hold_ms).toBeLessThan(trend.timedecay_hold_ms);
    expect(range.structure).toBe('through_mid');
    expect(regimeExitProfile('BREAKOUT_UP').structure).toBe('back_in_range');
  });

  it('no regime shrinks Peak/Target under Soft (Funds tiny-win vs Soft-loss)', () => {
    for (const r of REGIME_NAMES) {
      const p = regimeExitProfile(r);
      expect(p.peak_mfe_mult).toBeGreaterThanOrEqual(1);
      expect(p.target_mult).toBeGreaterThanOrEqual(p.hardinv_mult);
      expect(p.target_mult).toBeGreaterThanOrEqual(1);
    }
  });

  it('BREAKOUT Soft tighter than TREND; REVERSAL Soft tightest', () => {
    expect(regimeExitProfile('BREAKOUT_UP').hardinv_mult).toBeLessThan(
      regimeExitProfile('TREND_UP').hardinv_mult
    );
    expect(regimeExitProfile('REVERSAL_CANDIDATE').hardinv_mult).toBeLessThan(
      regimeExitProfile('BREAKOUT_UP').hardinv_mult
    );
  });

  it('families group as expected', () => {
    expect(regimeExitFamily('TREND_DOWN')).toBe('trend');
    expect(regimeExitFamily('PULLBACK_UPTREND')).toBe('pullback');
    expect(regimeExitFamily('EXPANSION')).toBe('expansion');
    expect(regimeExitFamily('COMPRESSION')).toBe('chop');
    expect(regimeExitFamily('TRANSITION')).toBe('chop');
    expect(regimeExitFamily('UNKNOWN')).toBe('chop');
  });

  it('reads live genome overrides for exit_* knobs', () => {
    _resetBrainGenomeForTests({
      exit_trend_target_mult: 1.5,
      exit_trend_peak_retention: 0.8,
      exit_fade_hardinv_mult: 0.7,
    });
    expect(regimeExitProfile('TREND_UP').target_mult).toBe(1.5);
    expect(regimeExitProfile('TREND_DOWN').peak_retention).toBe(0.8);
    expect(regimeExitProfile('RANGE').hardinv_mult).toBe(0.7);
  });
});

describe('structureInvalidationReason', () => {
  beforeEach(() => {
    _resetBrainGenomeForTests({});
  });

  const zone = { hi: 4340, lo: 4320, mid: 4330, width: 20 };

  it('BREAKOUT_UP dies back under hi; TREND does not', () => {
    expect(
      structureInvalidationReason('BUY', 4339, 'BREAKOUT_UP', zone)
    ).toMatch(/back under/);
    expect(structureInvalidationReason('BUY', 4339, 'TREND_UP', zone)).toBeNull();
  });

  it('BREAKOUT_DOWN dies back above lo', () => {
    expect(
      structureInvalidationReason('SELL', 4321, 'BREAKOUT_DOWN', zone)
    ).toMatch(/back above/);
  });

  it('RANGE fade BUY dies through mid toward HI', () => {
    expect(
      structureInvalidationReason('BUY', 4332, 'RANGE', zone)
    ).toMatch(/through mid/);
    expect(structureInvalidationReason('BUY', 4324, 'RANGE', zone)).toBeNull();
  });

  it('FAILED_BREAKOUT_UP SELL dies on reclaim above hi', () => {
    expect(
      structureInvalidationReason('SELL', 4341, 'FAILED_BREAKOUT_UP', zone)
    ).toMatch(/reclaim/);
    expect(
      structureInvalidationReason('SELL', 4335, 'FAILED_BREAKOUT_UP', zone)
    ).toBeNull();
  });
});

describe('shouldArmPeakProtect', () => {
  beforeEach(() => {
    _resetBrainGenomeForTests({});
  });

  const zone = { hi: 4340, lo: 4320, mid: 4330, width: 20 };

  it('TREND arms only on reverse 1m', () => {
    expect(
      shouldArmPeakProtect({
        regime: 'TREND_UP',
        policy: 'reverse',
        side: 'BUY',
        mid: 4330,
        zone,
        mfe: 2,
      })
    ).toBe(true);
    expect(
      shouldArmPeakProtect({
        regime: 'TREND_UP',
        policy: 'wait',
        side: 'BUY',
        mid: 4335,
        zone,
        mfe: 2,
      })
    ).toBe(false);
  });

  it('RANGE arms on reverse or through-mid while green MFE', () => {
    expect(
      shouldArmPeakProtect({
        regime: 'RANGE',
        policy: 'wait',
        side: 'BUY',
        mid: 4332,
        zone,
        mfe: 1,
      })
    ).toBe(true);
  });

  it('REVERSAL fast arms on wait once MFE exists', () => {
    expect(
      shouldArmPeakProtect({
        regime: 'REVERSAL_CANDIDATE',
        policy: 'wait',
        side: 'BUY',
        mid: 4330,
        zone,
        mfe: 0.5,
      })
    ).toBe(true);
    expect(
      shouldArmPeakProtect({
        regime: 'REVERSAL_CANDIDATE',
        policy: 'wait',
        side: 'BUY',
        mid: 4330,
        zone,
        mfe: 0,
      })
    ).toBe(false);
  });
});
