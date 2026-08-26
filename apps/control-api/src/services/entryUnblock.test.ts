import { describe, expect, it } from 'vitest';
import {
  allowEntryAgainstImpulse,
  blockEntryAtExtreme,
  blockLateTrendChase,
  decideEntryFrom10sRegime,
  explainNoEntry,
  signalBarTooLate,
  tapeSide,
} from './entryFromRegime.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number, i = 0, w = 1.5): TenSecBar {
  const high = Math.max(open, close) + w;
  const low = Math.min(open, close) - w;
  return { open_time_ms: i * 10_000, open, high, low, close, ticks: 8 };
}

function quietBox(n = 20, mid = 4640): TenSecBar[] {
  const out: TenSecBar[] = [];
  for (let i = 0; i < n; i++) {
    const m = mid + (i % 3) * 0.25;
    out.push(bar(m, m + 0.15, i, 1.1));
  }
  return out;
}

/** Steady early UP — not climax (~2–3pt, mid-range). */
function earlyUpBars(n = 22, start = 4620): TenSecBar[] {
  const out: TenSecBar[] = [];
  for (let i = 0; i < n; i++) {
    const o = start + i * 0.1;
    out.push({
      open_time_ms: i * 10_000,
      open: o,
      high: o + 0.45,
      low: o - 0.25,
      close: o + 0.15,
      ticks: 8,
    });
  }
  return out;
}

describe('tape-follow entry (UP→BUY / DOWN→SELL, no zone setup wait)', () => {
  it('FLAT mid-box waits — no invented trade', () => {
    const bars = quietBox(24);
    const mid = {
      open_time_ms: 24 * 10_000,
      open: 4640.3,
      high: 4640.5,
      low: 4640.1,
      close: 4640.35,
      ticks: 8,
    };
    expect(tapeSide(bars, mid).dir).toBeNull();
    expect(decideEntryFrom10sRegime(mid, 'RANGE', bars)).toBeNull();
    expect(explainNoEntry(mid, 'RANGE', bars)).toMatch(/TAPE FLAT|need UP→BUY/i);
  });

  it('early UP tape → BUY without waiting for zone bounce', () => {
    const bars = earlyUpBars(22);
    const live = bars[bars.length - 1]!;
    expect(tapeSide(bars, live).dir).toBe('BUY');
    const entry = decideEntryFrom10sRegime(live, 'RANGE', bars);
    expect(entry).not.toBeNull();
    expect(entry!.direction).toBe('BUY');
    expect(entry!.reason).toMatch(/TAPE UP/i);
  });

  it('early DOWN tape → SELL', () => {
    const bars: TenSecBar[] = [];
    for (let i = 0; i < 22; i++) {
      const o = 4650 - i * 0.1;
      bars.push({
        open_time_ms: i * 10_000,
        open: o,
        high: o + 0.25,
        low: o - 0.45,
        close: o - 0.15,
        ticks: 8,
      });
    }
    const live = bars[bars.length - 1]!;
    expect(tapeSide(bars, live).dir).toBe('SELL');
    const entry = decideEntryFrom10sRegime(live, 'COMPRESSION', bars);
    expect(entry).not.toBeNull();
    expect(entry!.direction).toBe('SELL');
    expect(entry!.reason).toMatch(/TAPE DOWN/i);
  });

  it('blocks SELL at swing low after big struct dump', () => {
    const bars: TenSecBar[] = [];
    for (let i = 0; i < 24; i++) {
      const o = 4650 - i * 0.7;
      bars.push(bar(o, o - 0.5, i, 0.8));
    }
    const atLow = bar(4633.5, 4633.2, 24, 0.6);
    expect(blockEntryAtExtreme('SELL', bars, atLow).ok).toBe(false);
  });

  it('rejects late chase bar (~5.5pt+ body)', () => {
    const late = bar(4640, 4646, 1, 0.5);
    expect(signalBarTooLate(late)).toBe(true);
    expect(decideEntryFrom10sRegime(late, 'TREND_UP', quietBox())).toBeNull();
  });

  it('blocks SELL on pullback at top of UP tape (not just green bars)', () => {
    const bars: TenSecBar[] = [];
    for (let i = 0; i < 55; i++) {
      const o = 4627 + i * 0.2;
      bars.push({
        open_time_ms: i * 10_000,
        open: o,
        high: o + 0.6,
        low: o - 0.2,
        close: o + 0.4,
        ticks: 8,
      });
    }
    for (let i = 55; i < 65; i++) {
      const o = 4638 - (i - 55) * 0.25;
      bars.push({
        open_time_ms: i * 10_000,
        open: o,
        high: o + 0.2,
        low: o - 0.4,
        close: o - 0.2,
        ticks: 8,
      });
    }
    const pullback = bars[bars.length - 1]!;
    expect(decideEntryFrom10sRegime(pullback, 'COMPRESSION', bars)).toBeNull();
    expect(allowEntryAgainstImpulse('SELL', bars, pullback).ok).toBe(false);
  });

  it('blocks BUY after trend already ran (late chase)', () => {
    const bars: TenSecBar[] = [];
    for (let i = 0; i < 60; i++) {
      const o = 4600 + i * 0.2;
      bars.push({
        open_time_ms: i * 10_000,
        open: o,
        high: o + 0.5,
        low: o - 0.1,
        close: o + 0.35,
        ticks: 8,
      });
    }
    const top = bars[bars.length - 1]!;
    expect(blockLateTrendChase('BUY', bars, top).ok).toBe(false);
    expect(decideEntryFrom10sRegime(top, 'TREND_UP', bars)).toBeNull();
    expect(explainNoEntry(top, 'TREND_UP', bars)).toMatch(/too late|chase top/i);
  });
});
