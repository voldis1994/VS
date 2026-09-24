import { describe, expect, it } from 'vitest';
import { replayStrategy, syntheticTrendBars } from './strategyReplay.js';

describe('strategyReplay', () => {
  it('runs TS brain on synthetic bars and returns expectancy shape', () => {
    const bars = syntheticTrendBars({ n: 300 });
    const result = replayStrategy(bars, { spread_pts: 0.2 });
    expect(result.bars).toBe(300);
    expect(result.expectancy.window).toBe('replay');
    expect(result.expectancy.total.trades).toBe(result.trades.length);
    // May or may not fire entries depending on zone seed — shape must be valid
    expect(result.expectancy.by_regime).toBeDefined();
    expect(Array.isArray(result.expectancy.by_setup)).toBe(true);
  });

  it('records attribution fields when trades fire', () => {
    const bars = syntheticTrendBars({ n: 400, step: 0.15 });
    const result = replayStrategy(bars, { spread_pts: 0.1, max_hold_bars: 60 });
    for (const t of result.trades) {
      expect(t.direction === 'BUY' || t.direction === 'SELL').toBe(true);
      expect(Number.isFinite(t.entry_price)).toBe(true);
      expect(t.pnl_pts == null || Number.isFinite(t.pnl_pts)).toBe(true);
      expect(t.exit_reason).toBeTruthy();
    }
  });
});
