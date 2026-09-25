import { describe, expect, it, beforeEach } from 'vitest';
import {
  _resetLearnerForTests,
  extractLearnerFeatures,
  learnerChooseAction,
  learnerLearnFromClose,
  LEARNER_FEATURE_NAMES,
  getLearnerStatus,
} from './deskLearner.js';
import type { ManageBrainInput } from './manageBrain.js';

function input(partial: Partial<ManageBrainInput> = {}): ManageBrainInput {
  return {
    open_side: 'BUY',
    entry_price: 4330,
    mid: 4335,
    mfe: 5,
    mae: 0.4,
    unrealized: 4.5,
    peak_retention: 0.9,
    peak_protect_armed: true,
    entry_regime: 'TREND_UP',
    live_regime: 'TREND_UP',
    entry_setup: 'PULLBACK',
    soft_sl: 3.5,
    peak_mfe_floor: 6,
    peak_retention_cfg: 0.72,
    target_dist: 10,
    minute_policy: 'continue',
    soft_gate_allow: false,
    soft_gate_hold_reason: '',
    next_entry_side: 'BUY',
    session_expectancy_pts: 0.2,
    last_window_expectancy: 0.1,
    closes_in_session: 8,
    held_ms: 120_000,
    client_id: 42,
    market: {
      at_ms: Date.now(),
      regime: 'TREND_UP',
      zone: { pos: 0.35, band: 'MID_LO', width: 10 },
      story: {
        chapter: 'RALLY',
        allow: 'BUY',
        red_1m: 6,
        green_1m: 20,
        swing: 'HH_HL',
        conf: 0.7,
        net_pts: 5,
      },
      pressure: {
        green_1m: 20,
        red_1m: 6,
        green_share: 0.77,
        last_body_sign: 1,
        last_body_pct: 0.0002,
        ticks: 5,
      },
      velocity: {
        last_body_pct: 0.0002,
        avg_range_pct: 0.00015,
        expanding: false,
        compressed: false,
        moving: true,
      },
      feed: { contributing: 3, agreement: 'STRONG' },
      summary: 'RALLY · zone MID_LO · G20/R6 · STEADY · feed STRONG',
    },
    ...partial,
  };
}

describe('deskLearner', () => {
  beforeEach(() => {
    _resetLearnerForTests(42);
    _resetLearnerForTests(0);
  });

  it('extracts fixed-length features', () => {
    const x = extractLearnerFeatures(input());
    expect(x).toHaveLength(LEARNER_FEATURE_NAMES.length);
    expect(x[0]).toBe(1); // bias
  });

  it('chooses an action with probabilities', () => {
    const d = learnerChooseAction(input(), 42, () => 0.99);
    expect(['HOLD', 'TRAIL', 'CUT', 'BANK']).toContain(d.action);
    expect(d.confidence).toBeGreaterThan(0);
    expect(d.detail).toMatch(/^LEARNER /);
    expect(d.features).toHaveLength(LEARNER_FEATURE_NAMES.length);
  });

  it('learns from positive reward — preferred action rises', () => {
    const base = input({
      minute_policy: 'reverse',
      next_entry_side: 'SELL',
      unrealized: 4,
      mfe: 5,
      soft_sl: 3.5,
    });
    const before = learnerChooseAction(base, 42, () => 0.99);
    const feats = before.features;
    // Reinforce BANK many times in this context
    for (let i = 0; i < 25; i++) {
      learnerLearnFromClose({
        clientId: 42,
        features: feats,
        action: 'BANK',
        pnl_pts: 2.5,
        soft_scale: 3.5,
      });
    }
    const after = learnerChooseAction(base, 42, () => 0.99);
    expect(after.probs.BANK).toBeGreaterThan(before.probs.BANK);
    expect(getLearnerStatus(42).updates).toBe(25);
  });

  it('learns from negative reward — demotes bad action', () => {
    const base = input({ minute_policy: 'continue' });
    const feats = extractLearnerFeatures(base);
    for (let i = 0; i < 20; i++) {
      learnerLearnFromClose({
        clientId: 42,
        features: feats,
        action: 'BANK',
        pnl_pts: -2.5,
        soft_scale: 3.5,
      });
    }
    const after = learnerChooseAction(base, 42, () => 0.99);
    // After punishing BANK on continue contexts, HOLD/TRAIL should dominate
    expect(after.probs.BANK).toBeLessThan(0.45);
  });
});
