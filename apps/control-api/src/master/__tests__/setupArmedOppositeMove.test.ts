import { describe, expect, it } from 'vitest';
import { analyzeBars } from '../analysis.js';
import { decide } from '../decision.js';
import { DEFAULT_MASTER_CONFIG } from '../pipeline.js';
import type { Bar } from '../types.js';

function barsTrendDown(n = 40): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 2650 - i * 0.6;
    out.push({
      open: o,
      high: o + 0.3,
      low: o - 1.0,
      close: o - 0.5,
      ts_ms: i * 60_000,
    });
  }
  return out;
}

describe('ARMED setup vs opposite MOVE', () => {
  it('ignores opposite MOVE and waits need_SELL (not setup_side_mismatch)', () => {
    const bars = barsTrendDown();
    const a = analyzeBars(bars, 0.4);
    const q = {
      bid: 2625,
      ask: 2625.4,
      mid: 2625.2,
      spread: 0.4,
      ts_ms: Date.now(),
      epic: 'GOLD',
    };
    const d = decide(
      a,
      q,
      {
        ...DEFAULT_MASTER_CONFIG,
        min_score: 0.01,
        require_armed_setup: true,
        block_off_hours: false,
        block_high_impact_news: false,
        max_relative_volatility: 100,
      },
      () => null,
      bars,
      null,
      {
        kind: 'CONTINUATION',
        side: 'SELL',
        playbook: null,
        status: 'ARMED',
        swing_high: 2660,
        swing_low: 2610,
        reason: 'test',
        confirm: 2,
        updated_at: new Date().toISOString(),
      },
      {
        side: 'BUY',
        source: 'move',
        reason: 'opposite',
        setup_kind: 'CONTINUATION',
        playbook: null,
      },
      { closed_10s_present: true, epic: 'GOLD' }
    );
    expect(d.kind).toBe('WAIT');
    expect(d.block_reason).toBe('setup_confirm_pending:need_SELL');
    expect(d.block_reason).not.toMatch(/setup_side_mismatch/);
  });
});
