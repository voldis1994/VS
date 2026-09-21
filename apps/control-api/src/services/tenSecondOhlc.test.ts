import { describe, expect, it } from 'vitest';
import {
  aggregateSecondsToTen,
  bodyPct,
  buildTenSecBarsFromSeconds,
  decideFromClosed10s,
  emptyTenSecState,
  enrichOhlcWithSecondCandles,
  expandMinutesToTen,
  isMoving10s,
  rangePct,
  updateTenSecondOhlc,
} from './tenSecondOhlc.js';
import { EXPAND_ABS, MOVE } from './regimeBands.js';

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

  it('SECOND candles rebuild a moving 10s bar that sparse mid polls left flat', () => {
    const now = 1_700_000_020_000; // bucket boundary-ish
    const flatPoll = {
      open_time_ms: now - 10_000,
      open: 4351.97,
      high: 4351.97,
      low: 4351.97,
      close: 4351.97,
      ticks: 1,
    };
    const state = {
      forming: {
        open_time_ms: now,
        open: 4352.35,
        high: 4352.35,
        low: 4352.35,
        close: 4352.35,
        ticks: 1,
      },
      last_closed: flatPoll,
      just_closed: false,
    };
    const seconds = [];
    for (let i = 0; i < 10; i++) {
      const t = now - 10_000 + i * 1000;
      const o = 4351.5 + i * 0.08;
      const c = o + 0.05;
      seconds.push({
        open: o,
        high: c + 0.1,
        low: o - 0.1,
        close: c,
        snapshot_time_ms: t,
      });
    }
    const { closed } = buildTenSecBarsFromSeconds(seconds, now);
    expect(closed.length).toBeGreaterThanOrEqual(1);
    const bar = closed[closed.length - 1]!;
    expect(rangePct(bar)).toBeGreaterThan(0);
    expect(isMoving10s(bar)).toBe(true);

    const enriched = enrichOhlcWithSecondCandles(state, seconds, now);
    expect(enriched.just_closed).toBe(true);
    expect(enriched.last_closed).not.toBeNull();
    expect(isMoving10s(enriched.last_closed)).toBe(true);
    expect(Math.abs(bodyPct(enriched.last_closed!))).toBeGreaterThanOrEqual(MOVE * 0.5);
  });

  it('replaces a NEWER flat poll bar with an OLDER SECOND bar that has real range', () => {
    const now = 1_700_000_030_000;
    const flatNewer = {
      open_time_ms: now - 10_000,
      open: 4354.65,
      high: 4354.65,
      low: 4354.65,
      close: 4354.65,
      ticks: 1,
    };
    const seconds = [];
    for (let i = 0; i < 10; i++) {
      const t = now - 20_000 + i * 1000; // previous 10s bucket vs flat poll
      const o = 4354.0 + i * 0.05;
      seconds.push({
        open: o,
        high: o + 0.15,
        low: o - 0.05,
        close: o + 0.04,
        snapshot_time_ms: t,
      });
    }
    const enriched = enrichOhlcWithSecondCandles(
      { forming: null, last_closed: flatNewer, just_closed: false },
      seconds,
      now
    );
    expect(enriched.just_closed).toBe(true);
    expect(enriched.last_closed!.open_time_ms).toBe(now - 20_000);
    expect(isMoving10s(enriched.last_closed)).toBe(true);
    expect(rangePct(enriched.last_closed!)).toBeGreaterThan(0);
  });
});
