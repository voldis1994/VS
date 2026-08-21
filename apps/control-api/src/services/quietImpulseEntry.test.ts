import { describe, expect, it } from 'vitest';
import {
  compressionBox,
  decideEntryFromBoxBreak,
  decideEntryFromQuietImpulse,
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
  it('defaults to box_break', () => {
    expect(resolveEntryMode('')).toBe('box_break');
    expect(resolveEntryMode('classic')).toBe('classic');
    expect(resolveEntryMode('quiet_impulse')).toBe('quiet_impulse');
  });

  it('post-exit cooldown defaults to 90 seconds', () => {
    expect(resolvePostExitCooldownMs('')).toBe(90_000);
    expect(resolvePostExitCooldownMs('180000')).toBe(180_000);
  });
});

describe('decideEntryFromBoxBreak (chart oval → drop)', () => {
  it('SELL when tight box then first break down (user green-oval case)', () => {
    // ~4587.5–4588.5 consolidation then break under box low
    const bars = stamp([
      bar(4588.0, 4588.1, 0.25),
      bar(4588.1, 4587.9, 0.25),
      bar(4587.9, 4588.05, 0.25),
      bar(4588.05, 4587.95, 0.25),
      bar(4587.95, 4588.1, 0.25),
      bar(4588.1, 4588.0, 0.25),
      bar(4588.0, 4584.5, 0.4), // first break down (~3.5pt body — not late)
    ]);
    const box = compressionBox(bars);
    expect(box.length).toBeGreaterThanOrEqual(5);
    const sig = decideEntryFromBoxBreak(bars);
    expect(sig?.direction).toBe('SELL');
    expect(sig?.reason).toMatch(/BOX→BREAK short/);
  });

  it('BUY when tight box then first break up', () => {
    const bars = stamp([
      bar(4581.0, 4581.1, 0.2),
      bar(4581.1, 4580.9, 0.2),
      bar(4580.9, 4581.05, 0.2),
      bar(4581.05, 4580.95, 0.2),
      bar(4580.95, 4581.0, 0.2),
      bar(4581.0, 4583.2, 0.3),
    ]);
    const sig = decideEntryFromBoxBreak(bars);
    expect(sig?.direction).toBe('BUY');
    expect(sig?.reason).toMatch(/BOX→BREAK long/);
  });

  it('skips when prior zone is too wide (not compressed)', () => {
    const bars = stamp([
      bar(4580, 4582, 0.5),
      bar(4582, 4584, 0.5),
      bar(4584, 4583, 0.5),
      bar(4583, 4585, 0.5),
      bar(4585, 4584, 0.5),
      bar(4584, 4581, 0.4),
    ]);
    expect(decideEntryFromBoxBreak(bars)).toBeNull();
  });

  it('skips extreme chase candle after box', () => {
    const bars = stamp([
      bar(4588.0, 4588.05, 0.2),
      bar(4588.05, 4587.95, 0.2),
      bar(4587.95, 4588.0, 0.2),
      bar(4588.0, 4587.9, 0.2),
      bar(4587.9, 4588.05, 0.2),
      bar(4588.0, 4580.0, 0.5), // ~8pt — late
    ]);
    expect(decideEntryFromBoxBreak(bars)).toBeNull();
  });

  it('still allows box even if some candles inside are not “quiet%”', () => {
    // Mixed small red/blue with mild wicks — fails quiet_impulse often, box_break should pass
    const bars = stamp([
      bar(4588.2, 4587.9, 0.55),
      bar(4587.9, 4588.15, 0.5),
      bar(4588.15, 4587.85, 0.55),
      bar(4587.85, 4588.1, 0.5),
      bar(4588.1, 4587.95, 0.5),
      bar(4588.0, 4585.2, 0.35),
    ]);
    expect(decideEntryFromQuietImpulse(bars)).toBeNull();
    const sig = decideEntryFromBoxBreak(bars);
    expect(sig?.direction).toBe('SELL');
  });

  it('rejects SELL break into a buy-move bounce (V reverse)', () => {
    // Climb ~4564→4569 then tiny box + red “break” — must NOT short the bounce
    const bars = stamp([
      bar(4564.0, 4565.2, 0.25),
      bar(4565.2, 4566.5, 0.25),
      bar(4566.5, 4567.8, 0.25),
      bar(4567.8, 4568.5, 0.2),
      bar(4568.5, 4568.7, 0.15),
      bar(4568.7, 4568.9, 0.15),
      bar(4568.9, 4568.6, 0.15),
      bar(4568.8, 4567.2, 0.25), // red break under micro high — fade trap
    ]);
    expect(decideEntryFromBoxBreak(bars)).toBeNull();
  });

  it('SELL on micro-pause resume in a dump (no wide oval — #143)', () => {
    // Continuous dump then 3-bar pause then resume — was forever WAIT under oval-only
    const bars = stamp([
      bar(4604.0, 4601.5, 0.35),
      bar(4601.5, 4598.5, 0.35),
      bar(4598.5, 4595.5, 0.35),
      bar(4595.5, 4593.0, 0.3),
      bar(4593.0, 4592.8, 0.2),
      bar(4592.8, 4593.1, 0.2),
      bar(4593.1, 4592.7, 0.2),
      bar(4592.7, 4590.5, 0.3), // resume short after micro pause
    ]);
    const sig = decideEntryFromBoxBreak(bars);
    expect(sig?.direction).toBe('SELL');
    expect(sig?.reason).toMatch(/micro/);
  });
});
