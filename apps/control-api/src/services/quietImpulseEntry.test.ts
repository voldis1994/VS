import { describe, expect, it } from 'vitest';
import {
  decideEntryFromBoxBreak,
  resolveEntryMode,
  resolvePostExitCooldownMs,
} from './quietImpulseEntry.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number, pad = 0.15): TenSecBar {
  return {
    open_time_ms: 0,
    open,
    high: Math.max(open, close) + pad,
    low: Math.min(open, close) - pad,
    close,
    ticks: 10,
  };
}

function stamp(bars: TenSecBar[]): TenSecBar[] {
  return bars.map((b, i) => ({ ...b, open_time_ms: i * 10_000 }));
}

describe('resolveEntryMode / cooldown', () => {
  it('defaults to breakout (BOX removed)', () => {
    expect(resolveEntryMode('')).toBe('breakout');
    expect(resolveEntryMode('classic')).toBe('classic');
    expect(resolveEntryMode('box_break')).toBe('breakout');
    expect(resolveEntryMode('quiet_impulse')).toBe('quiet_impulse');
  });

  it('post-exit cooldown defaults to 30 seconds', () => {
    expect(resolvePostExitCooldownMs('')).toBe(30_000);
    expect(resolvePostExitCooldownMs('90000')).toBe(90_000);
    expect(resolvePostExitCooldownMs('30000')).toBe(30_000);
  });
});

describe('decideEntryFromBoxBreak — retired', () => {
  it('never arms (BOX path killed)', () => {
    const bars = stamp([
      bar(4588.0, 4588.1, 0.25),
      bar(4588.1, 4587.9, 0.25),
      bar(4587.9, 4588.05, 0.25),
      bar(4588.05, 4587.95, 0.25),
      bar(4587.95, 4588.1, 0.25),
      bar(4588.1, 4588.0, 0.25),
      bar(4588.0, 4584.5, 0.4),
    ]);
    expect(decideEntryFromBoxBreak(bars)).toBeNull();
    expect(decideEntryFromBoxBreak([])).toBeNull();
  });
});
