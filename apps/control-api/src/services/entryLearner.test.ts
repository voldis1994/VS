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

function selloffInput() {
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
  };
}

describe('entryLearner', () => {
  it('prior chooses SELL on selloff features (not blind BUY)', () => {
    const d = entryLearnerChoose(selloffInput(), 0, () => 0.99);
    expect(d.action).toBe('SELL');
    expect(d.detail).toMatch(/PRĀTS ENTRY SELL/);
    expect(d.probs.SELL).toBeGreaterThan(d.probs.BUY);
  });

  it('learns from loss — BUY into selloff features gets weaker', () => {
    const input = selloffInput();
    const before = entryLearnerChoose(input, 0, () => 0.99);
    const feat = extractEntryFeatures(input);
    // Simulate: we took BUY and lost hard
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
      },
      0,
      () => 0.99
    );
    expect(d.action).toBe('WAIT');
  });
});
