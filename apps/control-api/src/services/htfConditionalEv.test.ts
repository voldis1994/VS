import { describe, expect, it } from 'vitest';
import {
  computeConditionalEv,
  conditionalEvFor,
  type HtfTaggedTrade,
} from './htfConditionalEv.js';

function trade(
  partial: Partial<HtfTaggedTrade> & { pnl_pts: number; closed_at: string }
): HtfTaggedTrade {
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
    thesis_direction_correct: true,
    ...partial,
  };
}

describe('htfConditionalEv v2 — positive_sample vs has_edge', () => {
  it('N>=5 positive expectancy is positive_sample but NOT has_edge', () => {
    const rows: HtfTaggedTrade[] = Array.from({ length: 8 }, (_, i) =>
      trade({
        pnl_pts: 2,
        closed_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      })
    );
    const report = computeConditionalEv(rows, {
      min_trades: 5,
      min_oos_trades: 8,
      oos_fraction: 0.3,
    });
    const hit = conditionalEvFor(report, {
      structure: 'HH',
      phase: 'PULLBACK',
      setup: 'PULLBACK',
      side: 'BUY',
    });
    expect(hit?.positive_sample).toBe(true);
    expect(hit?.has_edge).toBe(false); // OOS too small
    expect(report.edge_setups).toHaveLength(0);
    expect(report.positive_samples.length).toBeGreaterThanOrEqual(1);
  });

  it('has_edge requires IS + OOS both positive with adequate samples', () => {
    const rows: HtfTaggedTrade[] = [];
    // 24 in-sample winners then 10 OOS winners
    for (let i = 0; i < 24; i++) {
      rows.push(
        trade({
          pnl_pts: 2,
          closed_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
        })
      );
    }
    for (let i = 0; i < 10; i++) {
      rows.push(
        trade({
          pnl_pts: 1.5,
          closed_at: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        })
      );
    }
    const report = computeConditionalEv(rows, {
      min_trades: 20,
      min_oos_trades: 8,
      oos_fraction: 0.3,
    });
    const hit = conditionalEvFor(report, {
      structure: 'HH',
      phase: 'PULLBACK',
      setup: 'PULLBACK',
      side: 'BUY',
    });
    expect(hit?.has_edge).toBe(true);
    expect(hit?.oos_trades).toBeGreaterThanOrEqual(8);
    expect(hit?.in_sample_expectancy_pts).toBeGreaterThan(0);
    expect(hit?.oos_expectancy_pts).toBeGreaterThan(0);
  });

  it('OOS negative → has_negative_edge even if full-sample looks ok', () => {
    const rows: HtfTaggedTrade[] = [];
    for (let i = 0; i < 20; i++) {
      rows.push(
        trade({
          pnl_pts: 3,
          closed_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T12:00:00Z`,
        })
      );
    }
    for (let i = 0; i < 10; i++) {
      rows.push(
        trade({
          pnl_pts: -4,
          closed_at: `2026-03-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
          thesis_direction_correct: false,
        })
      );
    }
    const report = computeConditionalEv(rows, {
      min_trades: 15,
      min_oos_trades: 8,
      oos_fraction: 0.3,
    });
    const hit = conditionalEvFor(report, {
      structure: 'HH',
      phase: 'PULLBACK',
      setup: 'PULLBACK',
      side: 'BUY',
    });
    expect(hit?.has_edge).toBe(false);
    expect(hit?.has_negative_edge).toBe(true);
  });
});
