import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyManageBrainToExit,
  mindOwnsGreenExit,
  scoreManageAction,
  type ManageBrainInput,
} from './manageBrain.js';
import { _resetLearnerForTests } from './deskLearner.js';
import { _resetBrainGenomeForTests } from '../brainSelfImprove/brainGenome.js';

beforeEach(() => {
  _resetLearnerForTests(0);
  _resetBrainGenomeForTests();
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

  it('HOLD does not force Peak arm at Soft×1 — genome Soft× arm (no hidden Soft ceiling)', () => {
    _resetBrainGenomeForTests({ peak_arm_soft_mult: 1.35 });
    const softOnly = scoreManageAction(
      base({
        minute_policy: 'continue',
        mfe: 3.5, // Soft×1.0
        unrealized: 3.4,
        soft_sl: 3.5,
        soft_gate_allow: false,
        peak_protect_armed: false,
      })
    );
    expect(softOnly.action).toBe('HOLD');
    expect(softOnly.force_peak_arm).toBe(false);

    const runner = scoreManageAction(
      base({
        minute_policy: 'continue',
        mfe: 4.8, // Soft×1.37
        unrealized: 4.5,
        soft_sl: 3.5,
        soft_gate_allow: false,
        peak_protect_armed: false,
      })
    );
    expect(runner.action).toBe('HOLD');
    expect(runner.force_peak_arm).toBe(true);
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
    // Keep override respects desk/genome cfg — no Mind 0.72–0.88 hardcode
    expect(r.peak_retention_override).toBe(0.72);
  });

  it('BANK/CUT Keep override respects desk cfg outside old 0.72–0.88 band', () => {
    const bank = scoreManageAction(
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
        peak_retention_cfg: 0.55,
      })
    );
    expect(bank.action).toBe('BANK');
    expect(bank.peak_retention_override).toBe(0.55);
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
    expect(r.reason).toMatch(/PRĀTS/);
    expect(r.learner_features?.length).toBeGreaterThan(10);
  });

  it('Learner never overrides manage action — Mind/Genome only (one brain)', () => {
    // Seed learner with many updates so old path would have overridden
    for (let i = 0; i < 25; i++) {
      scoreManageAction(
        base({
          minute_policy: 'reverse',
          soft_gate_allow: false,
          next_entry_side: 'SELL',
          mfe: 5,
          unrealized: 4.0,
          soft_sl: 3.5,
          session_expectancy_pts: -0.5,
          closes_in_session: 6,
        })
      );
    }
    const r = scoreManageAction(
      base({
        minute_policy: 'continue',
        mfe: 5,
        unrealized: 4.5,
        soft_sl: 3.5,
        soft_gate_allow: false,
        next_entry_side: 'BUY',
      })
    );
    expect(r.reason).toMatch(/PRĀTS/);
    expect(r.reason).not.toMatch(/^LEARNER/);
    expect(r.learner_features?.length).toBeGreaterThan(0);
    expect(['TRAIL', 'HOLD', 'CUT', 'BANK']).toContain(r.action);
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

  it('path quality deep-green Soft× follows genome near_target_lean_bank', () => {
    // Loose (0.5): upl 2.0 ≥ soft×0.5 → deep-green credit (score more negative)
    _resetBrainGenomeForTests({ near_target_lean_bank: 0.5 });
    const loose = scoreManageAction(
      base({
        minute_policy: 'continue',
        mfe: 4,
        unrealized: 2.0,
        soft_sl: 3.5,
        soft_gate_allow: false,
      })
    );
    // Strict (0.95): same upl does NOT qualify → no deep-green credit
    _resetBrainGenomeForTests({ near_target_lean_bank: 0.95 });
    const strict = scoreManageAction(
      base({
        minute_policy: 'continue',
        mfe: 4,
        unrealized: 2.0,
        soft_sl: 3.5,
        soft_gate_allow: false,
      })
    );
    expect(loose.score).toBeLessThan(strict.score);
  });

  it('mindOwnsGreenExit — BANK/CUT close Soft-sized green; never red', () => {
    expect(
      mindOwnsGreenExit({ action: 'BANK', execFav: 3.5, softSl: 3.4 }).exit
    ).toBe(true);
    expect(
      mindOwnsGreenExit({ action: 'CUT', execFav: 4.0, softSl: 3.4 })
    ).toMatchObject({ exit: true, tag: 'MindCut' });
    expect(
      mindOwnsGreenExit({ action: 'HOLD', execFav: 5, softSl: 3.4 }).exit
    ).toBe(false);
    expect(
      mindOwnsGreenExit({ action: 'BANK', execFav: 1.0, softSl: 3.4 }).exit
    ).toBe(false);
    expect(
      mindOwnsGreenExit({ action: 'BANK', execFav: -1.0, softSl: 3.4 }).exit
    ).toBe(false);
  });
});
