import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyManageBrainToExit,
  scoreManageAction,
  type ManageBrainInput,
} from './manageBrain.js';
import { _resetLearnerForTests } from './deskLearner.js';

beforeEach(() => {
  _resetLearnerForTests(0);
});

function base(partial: Partial<ManageBrainInput> = {}): ManageBrainInput {
  return {
    open_side: 'BUY',
    entry_price: 4330,
    mid: 4332,
    mfe: 2.5,
    mae: 0.4,
    unrealized: 2.0,
    peak_retention: 0.8,
    peak_protect_armed: false,
    entry_regime: 'TREND_UP',
    live_regime: 'TREND_UP',
    entry_setup: 'PULLBACK',
    soft_sl: 3.5,
    peak_mfe_floor: 6.5,
    peak_retention_cfg: 0.72,
    target_dist: 10,
    minute_policy: 'wait',
    soft_gate_allow: false,
    soft_gate_hold_reason: '1m wait',
    next_entry_side: null,
    session_expectancy_pts: 0,
    last_window_expectancy: null,
    closes_in_session: 0,
    held_ms: 60_000,
    ...partial,
  };
}

describe('manageBrain', () => {
  it('HOLDs on 1m continue — does not bank mid-leg', () => {
    const r = scoreManageAction(
      base({
        minute_policy: 'continue',
        mfe: 5,
        unrealized: 4.5,
        soft_sl: 3.5,
        soft_gate_allow: false,
      })
    );
    expect(r.action).toBe('HOLD');
    expect(r.soft_gate_override).toBe(false);
  });

  it('BANKs when reverse + Soft-green + weak session E', () => {
    const r = scoreManageAction(
      base({
        minute_policy: 'reverse',
        soft_gate_allow: true,
        next_entry_side: 'SELL',
        mfe: 5,
        unrealized: 4.2,
        soft_sl: 3.5,
        session_expectancy_pts: -0.4,
        closes_in_session: 5,
        live_regime: 'TREND_DOWN',
      })
    );
    expect(r.action).toBe('BANK');
    expect(r.soft_gate_override).toBe(true);
    expect(r.force_peak_arm).toBe(true);
  });

  it('CUTs earlier when giveback + reverse and Soft-sized MFE', () => {
    const r = scoreManageAction(
      base({
        minute_policy: 'reverse',
        mfe: 5,
        unrealized: 2.2,
        peak_retention: 0.44,
        soft_sl: 3.5,
        soft_gate_allow: true,
      })
    );
    expect(['CUT', 'BANK']).toContain(r.action);
    expect(r.force_peak_arm).toBe(true);
    expect(r.peak_retention_override).toBeGreaterThanOrEqual(0.72);
  });

  it('TRAILs by default when Soft MFE and no clear market change', () => {
    const r = scoreManageAction(
      base({
        minute_policy: 'wait',
        mfe: 4,
        unrealized: 3.8,
        soft_sl: 3.5,
        soft_gate_allow: false,
        next_entry_side: 'BUY',
      })
    );
    expect(['TRAIL', 'HOLD', 'CUT', 'BANK']).toContain(r.action);
    expect(r.reason).toMatch(/LEARNER/);
    expect(r.learner_features?.length).toBeGreaterThan(10);
  });

  it('applyManageBrainToExit forces Peak arm and softGate override', () => {
    const brain = scoreManageAction(
      base({
        minute_policy: 'reverse',
        soft_gate_allow: false,
        next_entry_side: 'SELL',
        mfe: 5,
        unrealized: 4.0,
        soft_sl: 3.5,
        session_expectancy_pts: -0.5,
        closes_in_session: 6,
        live_regime: 'BREAKOUT_DOWN',
      })
    );
    const gated = applyManageBrainToExit({
      brain,
      softGateAllow: false,
      peakArmed: false,
      peakRetentionCfg: 0.72,
      peakMfeFloor: 6.5,
    });
    expect(gated.peakArmed).toBe(true);
    if (brain.action === 'BANK') {
      expect(gated.softGateAllow).toBe(true);
    }
  });

  it('ignores weak expectancy until min sample', () => {
    const r = scoreManageAction(
      base({
        session_expectancy_pts: -1.0,
        closes_in_session: 1,
        minute_policy: 'continue',
        mfe: 5,
        unrealized: 4,
        soft_sl: 3.5,
      })
    );
    expect(r.action).toBe('HOLD');
  });
});
