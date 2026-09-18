import { describe, expect, it } from 'vitest';
import {
  aggregateSecondsToTen,
  bodyPct,
  decideFromClosed10s,
  expandMinutesToTen,
  isMoving10s,
  rangePct,
  updateTenSecondOhlc,
  emptyTenSecState,
} from './tenSecondOhlc.js';
import { EXPAND_ABS } from './regimeBands.js';

describe('10s OHLC', () => {
  it('closes a bar after 10 seconds and keeps forming the next', () => {
    let s = emptyTenSecState();
    const t0 = 1_700_000_000_000; // aligned-ish
    s = updateTenSecondOhlc(s, 4380, t0);
    s = updateTenSecondOhlc(s, 4385, t0 + 3000);
    expect(s.just_closed).toBe(false);
    s = updateTenSecondOhlc(s, 4370, t0 + 10_000);
    expect(s.just_closed).toBe(true);
    expect(s.last_closed?.open).toBe(4380);
    expect(s.last_closed?.high).toBe(4385);
    expect(s.last_closed?.close).toBe(4385);
    expect(s.forming?.open).toBe(4370);
  });

  it('treats a Capital-style 10s spike as MOVING, not flat tick noise', () => {
    const bar = {
      open_time_ms: 0,
      open: 4389,
      high: 4405,
      low: 4388,
      close: 4370,
      ticks: 20,
    };
    expect(isMoving10s(bar)).toBe(true);
    expect(bodyPct(bar)).toBeLessThan(-0.002);
    const d = decideFromClosed10s(bar);
    expect(d?.direction).toBe('BUY');
  });

  it('does not call a 0.06% tick-to-tick twitch a setup', () => {
    const bar = {
      open_time_ms: 0,
      open: 4389.19,
      high: 4389.4,
      low: 4389.1,
      close: 4389.25,
      ticks: 8,
    };
    expect(isMoving10s(bar)).toBe(false);
    expect(decideFromClosed10s(bar)).toBeNull();
  });

  it('aggregates 1s Capital candles into 10s bars', () => {
    const seconds = [];
    for (let i = 0; i < 20; i++) {
      const p = 4389 + i * 0.5;
      seconds.push({ open: p, high: p + 0.2, low: p - 0.1, close: p + 0.1 });
    }
    const tens = aggregateSecondsToTen(seconds);
    expect(tens).toHaveLength(2);
    expect(tens[0]!.open).toBe(4389);
    expect(tens[1]!.ticks).toBe(10);
    expect(isMoving10s(tens[1]!)).toBe(true);
  });

  it('expandMinutesToTen: 6×10s per minute, zone extremes kept, no 1m-range EXPANSION on every bar', () => {
    const mins = [
      { open: 2650, high: 2652, low: 2648, close: 2651 },
      { open: 2651, high: 2653, low: 2650, close: 2652 },
    ];
    const bars = expandMinutesToTen(mins, 1_700_000_060_000);
    expect(bars).toHaveLength(12);
    expect(bars[0]!.open_time_ms % 10_000).toBe(0);
    // Mid-bucket of first minute carries minute high/low
    expect(Math.max(...bars.slice(0, 6).map((b) => b.high))).toBe(2652);
    expect(Math.min(...bars.slice(0, 6).map((b) => b.low))).toBe(2648);
    // Most synthetic bars must stay below expansion absolute range
    const quiet = bars.filter((b) => rangePct(b) < EXPAND_ABS);
    expect(quiet.length).toBeGreaterThanOrEqual(8);
  });
});
