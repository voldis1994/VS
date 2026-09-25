import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetEntryLearnerForTests,
  entryLearnerChoose,
  entryLearnerLearnFromClose,
  extractEntryFeatures,
} from './entryLearner.js';

afterEach(() => {
  _resetEntryLearnerForTests(0);
});

function selloffInput(extra: Record<string, unknown> = {}) {
  return {
    regime: 'RANGE',
    story: {
      chapter: 'SELLOFF',
      allow: 'SELL' as const,
      confidence: 0.75,
      red_1m: 18,
      green_1m: 6,
      zone_pos: 0.4,
    },
    bar: {
      open_time_ms: 1,
      open: 4300,
      high: 4301,
      low: 4298,
      close: 4299,
      ticks: 8,
    },
    last_closed_side: 'BUY' as const,
    last_close_was_loss: true,
    moving: true,
    m1_dir: 'DOWN' as const,
    m1_strong: true,
    bias: 'DOWN' as const,
    ...extra,
  };
}

describe('entryLearner', () => {
  it('prior chooses SELL on selloff + 1m DOWN', () => {
    const d = entryLearnerChoose(selloffInput(), 0, () => 0.99);
    expect(d.action).toBe('SELL');
    expect(d.detail).toMatch(/PRĀTS ENTRY SELL/);
    expect(d.probs.SELL).toBeGreaterThan(d.probs.BUY);
  });

  it('learner softmax may pick any side — mind (multi-TF) owns knife veto', () => {
    const d = entryLearnerChoose(
      selloffInput({
        m1_dir: 'UP',
        m1_strong: true,
        bias: 'UP',
        bar: {
          open_time_ms: 1,
          open: 4300,
          high: 4305,
          low: 4299,
          close: 4304,
          ticks: 8,
        },
      }),
      0,
      () => 0.99
    );
    // No coherency knife list — action is softmax / explore only
    expect(['BUY', 'SELL', 'WAIT']).toContain(d.action);
    expect(d.detail).toMatch(/PRĀTS ENTRY/);
    expect(d.detail).not.toMatch(/1m UP · SELL pret/);
  });

  it('learns from loss — BUY into selloff features gets weaker', () => {
    const input = selloffInput();
    const before = entryLearnerChoose(input, 0, () => 0.99);
    const feat = extractEntryFeatures(input);
    for (let i = 0; i < 8; i++) {
      entryLearnerLearnFromClose({
        clientId: 0,
        features: feat,
        action: 'BUY',
        pnl_pts: -2.2,
      });
    }
    const after = entryLearnerChoose(input, 0, () => 0.99);
    expect(after.probs.BUY).toBeLessThan(before.probs.BUY);
    expect(after.updates).toBeGreaterThanOrEqual(8);
  });

  it('WAIT preferred on chop / none', () => {
    const d = entryLearnerChoose(
      {
        regime: 'RANGE',
        story: {
          chapter: 'RANGE_CHOP',
          allow: 'NONE',
          confidence: 0.3,
          red_1m: 10,
          green_1m: 10,
          zone_pos: 0.5,
        },
        moving: false,
        m1_dir: 'FLAT',
        bias: 'FLAT',
      },
      0,
      () => 0.99
    );
    expect(d.action).toBe('WAIT');
  });
});
