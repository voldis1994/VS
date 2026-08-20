import { describe, expect, it } from 'vitest';
import { entryPlanReady, liveVsFeedConfirm, regimeEntryPlan } from './regimeEntryPlan.js';
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
    expect(p.confirms.length).toBeGreaterThan(2);
  });

  it('BREAKOUT_UP at highs with all confirms → plan ready (context ARMED, not auto EntryReady)', () => {
    const bars = climbBars(16, 4510);
    const last = bars[bars.length - 1]!;
    const p = regimeEntryPlan({
      regime: 'BREAKOUT_UP',
      bias: 'UP',
      liveMid: last.high,
      feedMid: last.high + 0.1,
      bars10s: bars,
    });
    expect(p.direction).toBe('BUY');
    expect(p.ready).toBe(true);
    expect(entryPlanReady(p)).toBe(true);
    expect(p.confirm_ok).toBe(p.confirm_n);
    expect(p.confirms.find((c) => c.id === 'FEEDS')?.ok).toBe(true);
  });

  it('FIGHT → FEEDS confirm ok=false (never green checkmark)', () => {
    const bars = climbBars(16, 4510);
    const p = regimeEntryPlan({
      regime: 'BREAKOUT_UP',
      bias: 'UP',
      liveMid: 4522,
      feedMid: 4521.5,
      bars10s: bars,
    });
    expect(p.feed_confirm).toBe('FIGHT');
    expect(p.confirms.find((c) => c.id === 'FEEDS')?.ok).toBe(false);
    expect(entryPlanReady(p)).toBe(false);
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
  });

  it('RANGE at HIGH → SELL rejection', () => {
    const bars = Array.from({ length: 20 }, () => ({
      open: 4517,
      high: 4520,
      low: 4515,
      close: 4517.5,
    }));
    const p = regimeEntryPlan({
      regime: 'RANGE',
      bias: 'FLAT',
      liveMid: 4519.85,
      bars10s: bars,
    });
    expect(p.direction).toBe('SELL');
    expect(p.setup).toBe('RANGE_REJECTION');
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
    }
  });

  it('live vs feed fight on BUY', () => {
    expect(liveVsFeedConfirm({ direction: 'BUY', liveMid: 4522, feedMid: 4521.5 })).toBe('FIGHT');
  });
});
