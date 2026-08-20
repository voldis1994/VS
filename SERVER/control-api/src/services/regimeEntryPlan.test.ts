import { describe, expect, it } from 'vitest';
import { liveVsFeedConfirm, regimeEntryPlan } from './regimeEntryPlan.js';

describe('regimeEntryPlan', () => {
  it('BREAKOUT_UP → BUY BREAKOUT (zone break = entry plan)', () => {
    const p = regimeEntryPlan({ regime: 'BREAKOUT_UP', bias: 'UP', liveMid: 4522, feedMid: 4522.3 });
    expect(p.direction).toBe('BUY');
    expect(p.setup).toBe('BREAKOUT');
    expect(p.plan).toMatch(/BREAKOUT_UP/);
    expect(p.feed_confirm).toBe('CONFIRM');
  });

  it('TREND_DOWN → SELL CONTINUATION', () => {
    const p = regimeEntryPlan({ regime: 'TREND_DOWN', bias: 'DOWN' });
    expect(p.direction).toBe('SELL');
    expect(p.setup).toBe('CONTINUATION');
  });

  it('RANGE → rejection plan, no forced side', () => {
    const p = regimeEntryPlan({ regime: 'RANGE', bias: 'FLAT' });
    expect(p.direction).toBeNull();
    expect(p.setup).toBe('RANGE_REJECTION');
    expect(p.plan).toMatch(/rejection|BREAKOUT/i);
  });

  it('live vs feed fight on BUY', () => {
    expect(
      liveVsFeedConfirm({ direction: 'BUY', liveMid: 4522, feedMid: 4521.5 })
    ).toBe('FIGHT');
  });
});
