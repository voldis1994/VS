import { describe, expect, it } from 'vitest';
import {
  computeConditionalEv,
  conditionalEvFor,
  type HtfTaggedTrade,
} from './htfConditionalEv.js';

function trade(partial: Partial<HtfTaggedTrade> & { pnl_pts: number }): HtfTaggedTrade {
  return {
    pnl: null,
    regime: 'TREND_UP',
    setup_type: 'PULLBACK',
    exit_reason: 'PeakProtection',
    epic: 'GOLD',
    mfe: 2,
    mae: -0.5,
    hold_ms: 30_000,
    direction: 'BUY',
    htf_structure: 'HH',
    htf_phase: 'PULLBACK',
    htf_bias: 'UP',
    htf_path_status: 'CONFIRMED',
    ...partial,
  };
}

describe('htfConditionalEv', () => {
  it('buckets by HTF structure × phase × setup × side and flags edge', () => {
    const rows: HtfTaggedTrade[] = [
      trade({ pnl_pts: 3 }),
      trade({ pnl_pts: 2.5 }),
      trade({ pnl_pts: 4 }),
      trade({ pnl_pts: 2 }),
      trade({ pnl_pts: 3.5 }),
      // same HTF, opposite side — negative
      trade({
        pnl_pts: -2,
        direction: 'SELL',
        setup_type: 'FADE',
        htf_phase: 'IMPULSE',
        mfe: 0.2,
        mae: -2,
      }),
      trade({
        pnl_pts: -3,
        direction: 'SELL',
        setup_type: 'FADE',
        htf_phase: 'IMPULSE',
        mfe: 0.1,
        mae: -3,
      }),
      trade({
        pnl_pts: -2.5,
        direction: 'SELL',
        setup_type: 'FADE',
        htf_phase: 'IMPULSE',
        mfe: 0.3,
        mae: -2.5,
      }),
      trade({
        pnl_pts: -1.5,
        direction: 'SELL',
        setup_type: 'FADE',
        htf_phase: 'IMPULSE',
        mfe: 0.2,
        mae: -1.5,
      }),
      trade({
        pnl_pts: -2,
        direction: 'SELL',
        setup_type: 'FADE',
        htf_phase: 'IMPULSE',
        mfe: 0.1,
        mae: -2,
      }),
    ];
    const report = computeConditionalEv(rows, { window: '7d', min_trades: 5 });
    expect(report.sample_size).toBe(10);
    expect(report.edge_setups.length).toBeGreaterThanOrEqual(1);
    expect(report.avoid_setups.length).toBeGreaterThanOrEqual(1);
    const edge = conditionalEvFor(report, {
      structure: 'HH',
      phase: 'PULLBACK',
      setup: 'PULLBACK',
      side: 'BUY',
    });
    expect(edge?.has_edge).toBe(true);
    expect(edge?.expectancy_pts).toBeGreaterThan(0);
    expect(edge?.avg_mfe).toBeGreaterThan(0);
    const avoid = conditionalEvFor(report, {
      structure: 'HH',
      phase: 'IMPULSE',
      setup: 'FADE',
      side: 'SELL',
    });
    expect(avoid?.has_negative_edge).toBe(true);
  });

  it('under-sampled combo is not has_edge', () => {
    const rows = [trade({ pnl_pts: 5 }), trade({ pnl_pts: 4 })];
    const report = computeConditionalEv(rows, { min_trades: 5 });
    expect(report.edge_setups).toHaveLength(0);
    const hit = conditionalEvFor(report, {
      structure: 'HH',
      phase: 'PULLBACK',
      setup: 'PULLBACK',
      side: 'BUY',
    });
    expect(hit?.has_edge).toBe(false);
    expect(hit?.trades).toBe(2);
  });
});
