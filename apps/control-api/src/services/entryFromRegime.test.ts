import { describe, expect, it } from 'vitest';
import {
  continuationSameSide,
  decideEntryFrom10sRegime,
  explainNoEntry,
  tapeSide,
} from './entryFromRegime.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number, i = 0, w = 1.5): TenSecBar {
  const high = Math.max(open, close) + w;
  const low = Math.min(open, close) - w;
  return { open_time_ms: i * 10_000, open, high, low, close, ticks: 8 };
}

function baseBars(): TenSecBar[] {
  const out: TenSecBar[] = [];
  for (let i = 0; i < 40; i++) {
    const mid = 4500 + ((i % 4) - 1.5) * 0.05; // tight chop ±0.075
    out.push(bar(mid, mid + 0.02, i, 0.15));
  }
  return out;
}

describe('10s multi-TF entry — no WAIT', () => {
  it('skips flat chop', () => {
    const bars = baseBars();
    const sigBar = bar(4500.02, 4500.03, 40, 0.1);
    expect(tapeSide(bars, sigBar).dir).toBeNull();
    expect(decideEntryFrom10sRegime(sigBar, 'TRANSITION', bars)).toBeNull();
  });

  it('explainNoEntry is SCAN not WAIT', () => {
    const bars = baseBars();
    const quiet = bar(4500.5, 4500.55, 12, 0.2);
    const msg = explainNoEntry(quiet, 'UNKNOWN', bars);
    expect(msg).toMatch(/SCAN|TAPE FLAT/i);
    expect(msg).not.toMatch(/WAIT ENTRY|WAIT ·/);
  });

  it('continuationSameSide holds with UP tape', () => {
    const bars: TenSecBar[] = [];
    for (let i = 0; i < 60; i++) {
      const o = 4500 + i * 0.08;
      bars.push(bar(o, o + 0.1, i, 0.3));
    }
    const green = bar(4505, 4505.4, 60, 0.3);
    expect(continuationSameSide('BUY', green, 'TRANSITION', bars).ok).toBe(true);
  });

  it('continuationSameSide rejects flipped market', () => {
    const dump: TenSecBar[] = [];
    for (let i = 0; i < 40; i++) {
      dump.push(bar(4520 - i * 0.2, 4519.8 - i * 0.2, i, 0.4));
    }
    const red = bar(4500, 4499.5, 40, 0.3);
    expect(continuationSameSide('BUY', red, 'TREND_DOWN', dump).ok).toBe(false);
  });
});
