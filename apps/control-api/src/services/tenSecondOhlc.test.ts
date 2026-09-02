import { describe, expect, it } from 'vitest';
import {
  ENTRY_BAR_MS,
  aggregateSecondsToTen,
  bodyPct,
  decideFromClosed10s,
  isMoving10s,
  updateTenSecondOhlc,
  emptyTenSecState,
} from './tenSecondOhlc.js';

describe('confirm OHLC', () => {
  it('uses 2s confirm bars', () => {
    expect(ENTRY_BAR_MS).toBe(2_000);
  });

  it('closes a bar after 2 seconds and keeps forming the next', () => {
    let s = emptyTenSecState();
    const t0 = 1_700_000_000_000;
    s = updateTenSecondOhlc(s, 4380, t0);
    s = updateTenSecondOhlc(s, 4385, t0 + 500);
    expect(s.just_closed).toBe(false);
    s = updateTenSecondOhlc(s, 4370, t0 + ENTRY_BAR_MS);
    expect(s.just_closed).toBe(true);
    expect(s.last_closed?.open).toBe(4380);
    expect(s.last_closed?.high).toBe(4385);
    expect(s.last_closed?.close).toBe(4385);
    expect(s.forming?.open).toBe(4370);
  });

  it('treats a Capital-style spike as MOVING, not flat tick noise', () => {
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

  it('aggregates 1s Capital candles into confirm bars', () => {
    const seconds = [];
    for (let i = 0; i < 8; i++) {
      const p = 4389 + i * 0.5;
      seconds.push({ open: p, high: p + 0.2, low: p - 0.1, close: p + 0.1 });
    }
    const bars = aggregateSecondsToTen(seconds);
    expect(bars).toHaveLength(4); // 2s chunks
    expect(bars[0]!.open).toBe(4389);
    expect(bars[0]!.ticks).toBe(2);
    expect(bars[3]!.close).toBeGreaterThan(bars[0]!.open);
  });
});
