import { describe, expect, it } from 'vitest';
import { liveVsFeedConfirm, regimeEntryPlan } from './regimeEntryPlan.js';
import { REGIME_NAMES } from './regimes.js';

function climbBars(n = 12, start = 4500) {
  return Array.from({ length: n }, (_, i) => {
    const o = start + i * 0.4;
    return { open: o, high: o + 0.5, low: o - 0.2, close: o + 0.35 };
  });
}

describe('regimeEntryPlan — ALL regimes have targets + confirms', () => {
  it('BREAKOUT_UP → BUY BREAKOUT with HIGH/break targets', () => {
    const bars = climbBars(16, 4510);
    const p = regimeEntryPlan({
      regime: 'BREAKOUT_UP',
      bias: 'UP',
      liveMid: 4522,
      feedMid: 4522.3,
      bars10s: bars,
    });
    expect(p.direction).toBe('BUY');
    expect(p.setup).toBe('BREAKOUT');
    expect(p.targets.range_high).not.toBeNull();
    expect(p.targets.range_low).not.toBeNull();
    expect(p.targets.break_level).not.toBeNull();
    expect(p.target_line).toMatch(/H /);
    expect(p.target_line).toMatch(/L /);
    expect(p.confirms.length).toBeGreaterThan(2);
    expect(p.feed_confirm).toBe('CONFIRM');
  });

  it('TREND_DOWN → SELL with rally entry toward HIGH', () => {
    const bars = climbBars(16, 4520).map((b) => ({
      open: b.close + 0.2,
      high: b.close + 0.4,
      low: b.open - 0.5,
      close: b.open - 0.3,
    }));
    const p = regimeEntryPlan({
      regime: 'TREND_DOWN',
      bias: 'DOWN',
      liveMid: 4515,
      bars10s: bars,
    });
    expect(p.direction).toBe('SELL');
    expect(p.setup).toBe('CONTINUATION');
    expect(p.targets.range_high).not.toBeNull();
    expect(p.targets.entry).not.toBeNull();
    expect(p.confirm_line).toMatch(/confirms/);
  });

  it('RANGE → HIGH/LOW targets, rejection plan', () => {
    const bars = Array.from({ length: 20 }, (_, i) => {
      const mid = 4518 + Math.sin(i) * 1.5;
      return { open: mid - 0.2, high: mid + 1.2, low: mid - 1.2, close: mid + 0.1 };
    });
    const p = regimeEntryPlan({ regime: 'RANGE', bias: 'FLAT', liveMid: 4518, bars10s: bars });
    expect(p.setup).toBe('RANGE_REJECTION');
    expect(p.targets.range_high).not.toBeNull();
    expect(p.targets.range_low).not.toBeNull();
    expect(p.plan).toMatch(/HIGH|LOW|BREAKOUT/i);
    expect(p.target_line).toMatch(/H /);
  });

  it('every REGIME_NAMES gets target_line + confirms', () => {
    const bars = climbBars(20, 4500);
    for (const name of REGIME_NAMES) {
      const p = regimeEntryPlan({
        regime: name,
        bias: name.includes('DOWN') ? 'DOWN' : name.includes('UP') ? 'UP' : 'FLAT',
        liveMid: 4510,
        feedMid: 4510.1,
        bars10s: bars,
      });
      expect(p.target_line.length, name).toBeGreaterThan(5);
      expect(p.confirms.length, name).toBeGreaterThan(0);
      expect(p.plan.length, name).toBeGreaterThan(10);
    }
  });

  it('live vs feed fight on BUY', () => {
    expect(liveVsFeedConfirm({ direction: 'BUY', liveMid: 4522, feedMid: 4521.5 })).toBe('FIGHT');
  });
});
