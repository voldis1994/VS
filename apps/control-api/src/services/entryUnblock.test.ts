import { describe, expect, it } from 'vitest';
import {
  blockEntryAtExtreme,
  decideEntryFrom10sRegime,
  explainNoEntry,
  signalBarTooLate,
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

describe('real zone setups (not mid-chase / not too late)', () => {
  it('RANGE mid-box waits for scalp edges — no invented trend trade', () => {
    const bars = quietBox(24);
    // Dead center of ~4638.9–4641.75 box — must NOT count as bounce
    const mid = {
      open_time_ms: 24 * 10_000,
      open: 4640.3,
      high: 4640.5,
      low: 4640.1,
      close: 4640.35,
      ticks: 8,
    };
    expect(decideEntryFrom10sRegime(mid, 'RANGE', bars)).toBeNull();
    expect(explainNoEntry(mid, 'RANGE', bars)).toMatch(/scalp edges only|mid-zone/i);
  });

  it('RANGE enters BUY on DEMAND bounce (real setup)', () => {
    const bars = quietBox(24, 4640);
    // Touch demand edge (zone low ~4638.9, band ~0.57pt)
    const bounce = {
      open_time_ms: 24 * 10_000,
      open: 4639.2,
      high: 4640.0,
      low: 4638.95,
      close: 4639.7,
      ticks: 8,
    };
    const entry = decideEntryFrom10sRegime(bounce, 'RANGE', bars);
    expect(entry).not.toBeNull();
    expect(entry!.direction).toBe('BUY');
    expect(entry!.reason).toMatch(/BOUNCE|SETUP/i);
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

  it('still blocks TRANSITION', () => {
    expect(decideEntryFrom10sRegime(bar(4501, 4503, 12), 'TRANSITION', quietBox())).toBeNull();
  });
});
