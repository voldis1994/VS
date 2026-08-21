import { describe, expect, it } from 'vitest';
import {
  decideEntryFromQuietImpulse,
  quietBaseWindow,
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

describe('quietImpulseEntry', () => {
  it('resolveEntryMode defaults to quiet_impulse', () => {
    expect(resolveEntryMode('')).toBe('quiet_impulse');
    expect(resolveEntryMode('classic')).toBe('classic');
    expect(resolveEntryMode('QUIET_IMPULSE')).toBe('quiet_impulse');
  });

  it('post-exit cooldown defaults to 2.5 minutes', () => {
    expect(resolvePostExitCooldownMs('')).toBe(150_000);
    expect(resolvePostExitCooldownMs('180000')).toBe(180_000);
  });

  it('detects quiet base then first long impulse (chart green-line case)', () => {
    // Flat ~4581 then first push through base high — entry at move START
    const bars = stamp([
      bar(4581.0, 4581.05, 0.06),
      bar(4581.05, 4580.95, 0.06),
      bar(4580.95, 4581.02, 0.06),
      bar(4581.02, 4580.98, 0.06),
      bar(4581.0, 4582.3, 0.2), // first impulse up (~0.028% body)
    ]);

    expect(quietBaseWindow(bars).length).toBeGreaterThanOrEqual(4);
    const sig = decideEntryFromQuietImpulse(bars);
    expect(sig?.direction).toBe('BUY');
    expect(sig?.reason).toMatch(/QUIET→IMPULSE long/);
  });

  it('skips when first closed impulse bar already ran too far (late)', () => {
    const bars = stamp([
      bar(4581.0, 4581.0, 0.05),
      bar(4581.0, 4581.02, 0.05),
      bar(4581.0, 4580.98, 0.05),
      bar(4581.0, 4581.01, 0.05),
      bar(4581.0, 4585.5, 0.3), // ~0.1%+ body — too late for first-impulse
    ]);
    expect(decideEntryFromQuietImpulse(bars)).toBeNull();
  });

  it('does not fire without quiet base (avoids mid-trend noise)', () => {
    const bars = stamp([
      bar(4580, 4581.5, 0.4),
      bar(4581.5, 4583.0, 0.4),
      bar(4583.0, 4584.5, 0.4),
      bar(4584.5, 4585.2, 0.3),
    ]);
    expect(decideEntryFromQuietImpulse(bars)).toBeNull();
  });

  it('needs at least 4 quiet bars — 3 is not enough (chop filter)', () => {
    const bars = stamp([
      bar(4581.0, 4581.02, 0.06),
      bar(4581.02, 4580.98, 0.06),
      bar(4580.98, 4581.0, 0.06),
      bar(4581.0, 4582.3, 0.2),
    ]);
    expect(quietBaseWindow(bars).length).toBe(3);
    expect(decideEntryFromQuietImpulse(bars)).toBeNull();
  });

  it('first impulse short from quiet base', () => {
    const bars = stamp([
      bar(4584.0, 4584.05, 0.06),
      bar(4584.05, 4583.95, 0.06),
      bar(4583.95, 4584.02, 0.06),
      bar(4584.02, 4583.98, 0.06),
      bar(4584.0, 4582.7, 0.2),
    ]);
    const sig = decideEntryFromQuietImpulse(bars);
    expect(sig?.direction).toBe('SELL');
    expect(sig?.reason).toMatch(/QUIET→IMPULSE short/);
  });
});
