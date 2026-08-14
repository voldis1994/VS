import { describe, expect, it } from 'vitest';
import {
  aggregateSecondsToTen,
  bodyPct,
  decideFromClosed10s,
  isMoving10s,
  updateTenSecondOhlc,
  emptyTenSecState,
} from './tenSecondOhlc.js';

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
    expect(d?.direction).toBe('SELL');
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
});
