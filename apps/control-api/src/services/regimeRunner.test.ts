import { describe, expect, it, beforeEach } from 'vitest';
import { _resetBrainGenomeForTests, getBrainGenome } from '../brainSelfImprove/brainGenome.js';
import {
  evaluateRegimeRunnerScore,
  regimeRunnerEligible,
  regimeRunnerFamiliesMatch,
  regimeRunnerScoreActive,
  regimeRunnerShouldHoldTarget,
} from './regimeRunner.js';

describe('regimeRunner — hold Target until regime change (not SIDE)', () => {
  beforeEach(() => {
    _resetBrainGenomeForTests({});
  });

  it('SIDE regimes are never eligible', () => {
    expect(regimeRunnerEligible('RANGE')).toBe(false);
    expect(regimeRunnerEligible('COMPRESSION')).toBe(false);
    expect(regimeRunnerEligible('TRANSITION')).toBe(false);
    expect(regimeRunnerEligible('TREND_UP')).toBe(true);
    expect(regimeRunnerEligible('BREAKOUT_DOWN')).toBe(true);
    expect(regimeRunnerEligible('PULLBACK_UPTREND')).toBe(true);
  });

  it('families match TREND↔PULLBACK same side; mismatch on SIDE live', () => {
    expect(regimeRunnerFamiliesMatch('TREND_UP', 'PULLBACK_UPTREND')).toBe(true);
    expect(regimeRunnerFamiliesMatch('TREND_DOWN', 'BREAKOUT_DOWN')).toBe(true);
    expect(regimeRunnerFamiliesMatch('TREND_UP', 'RANGE')).toBe(false);
    expect(regimeRunnerFamiliesMatch('TREND_UP', 'TREND_DOWN')).toBe(false);
    expect(regimeRunnerFamiliesMatch('RANGE', 'RANGE')).toBe(false);
  });

  it('holds Target after T1 when live still TREND; releases on RANGE', () => {
    // Gold-scaled T1 ≈ 5.2 at mid 4160 — fav must clear scaled layer
    const base = {
      entryRegime: 'TREND_UP' as const,
      fav: 6.0,
      mfe: 6.5,
      execFav: 5.8,
      minBank: 0.5,
      absEntry: 4160,
      targetAbs: 5,
    };
    const arm = regimeRunnerShouldHoldTarget({
      ...base,
      liveRegime: 'TREND_UP',
      armed: false,
    });
    expect(arm.hold).toBe(true);
    expect(arm.arm).toBe(true);

    const hold = regimeRunnerShouldHoldTarget({
      ...base,
      liveRegime: 'PULLBACK_UPTREND',
      armed: true,
    });
    expect(hold.hold).toBe(true);

    const release = regimeRunnerShouldHoldTarget({
      ...base,
      liveRegime: 'RANGE',
      armed: true,
    });
    expect(release.hold).toBe(false);
    expect(release.why).toMatch(/regime changed/i);
  });

  it('score fallback below active_min disables hold', () => {
    _resetBrainGenomeForTests({
      regime_runner_score: 3,
      regime_runner_active_min_score: 5,
    });
    expect(regimeRunnerScoreActive()).toBe(false);
    const r = regimeRunnerShouldHoldTarget({
      entryRegime: 'TREND_UP',
      liveRegime: 'TREND_UP',
      armed: true,
      fav: 4,
      mfe: 4,
      execFav: 3.8,
      minBank: 0.5,
      absEntry: 4160,
    });
    expect(r.hold).toBe(false);
  });

  it('evaluateRegimeRunnerScore deducts on bad window; recovers on good', () => {
    _resetBrainGenomeForTests({ regime_runner_score: 10, regime_runner_deduct_pts: 2 });
    const bad = evaluateRegimeRunnerScore([
      { used_runner: true, regime_released: true, pnl_pts: -1, mfe: 3 },
      { used_runner: true, regime_released: true, pnl_pts: -0.5, mfe: 2 },
      { used_runner: true, regime_released: false, pnl_pts: 0.2, mfe: 3 },
    ]);
    expect(bad.score).toBe(8);
    expect(bad.change).toMatch(/deduct/);

    _resetBrainGenomeForTests({ regime_runner_score: 5, regime_runner_recover_pts: 1 });
    const good = evaluateRegimeRunnerScore([
      { used_runner: true, regime_released: true, pnl_pts: 2.5, mfe: 3 },
      { used_runner: true, regime_released: true, pnl_pts: 1.8, mfe: 2.5 },
      { used_runner: false, regime_released: false, pnl_pts: 0.5, mfe: 1 },
    ]);
    expect(good.score).toBe(6);
    expect(good.change).toMatch(/recover/);
  });

  it('factory genome exposes runner knobs', () => {
    const g = getBrainGenome();
    expect(g.regime_runner_enabled).toBe(true);
    expect(g.regime_runner_score).toBe(10);
    expect(g.regime_runner_eligible_regimes).toContain('TREND_UP');
    expect(g.regime_runner_eligible_regimes).not.toContain('RANGE');
  });
});
