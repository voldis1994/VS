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

/** Quiet base — flat tape. */
function baseBars(): TenSecBar[] {
  const out: TenSecBar[] = [];
  for (let i = 0; i < 12; i++) {
    const mid = 4500 + (i % 2) * 0.3;
    out.push(bar(mid, mid + 0.2, i, 1.0));
  }
  return out;
}

describe('10s tape-follow entry', () => {
  it('skips flat chop — no direction', () => {
    const bars = baseBars();
    const sigBar = bar(4500.4, 4500.5, 12, 0.3);
    expect(tapeSide(bars, sigBar).dir).toBeNull();
    expect(decideEntryFrom10sRegime(sigBar, 'COMPRESSION', bars)).toBeNull();
    expect(decideEntryFrom10sRegime(sigBar, 'RANGE', bars)).toBeNull();
    expect(decideEntryFrom10sRegime(sigBar, 'UNKNOWN', bars)).toBeNull();
  });

  it('skips EXPANSION without clear slope (no random color)', () => {
    const bars = baseBars();
    const midFlat = {
      open_time_ms: 12 * 10_000,
      open: 4500.5,
      high: 4500.7,
      low: 4500.3,
      close: 4500.55,
      ticks: 8,
    };
    expect(decideEntryFrom10sRegime(midFlat, 'EXPANSION', bars)).toBeNull();
  });

  it('explainNoEntry surfaces tape flat', () => {
    const bars = baseBars();
    const quiet = bar(4500.5, 4500.55, 12, 0.2);
    expect(explainNoEntry(quiet, 'TREND_UP', bars)).toMatch(/WAIT|TAPE FLAT|need UP→BUY/i);
  });

  it('continuationSameSide holds with TREND_UP + green', () => {
    const bars = baseBars();
    const green = bar(4502, 4503.5, 12);
    const c = continuationSameSide('BUY', green, 'TREND_UP', bars);
    expect(c.ok).toBe(true);
    expect(c.reason).toMatch(/continuation/i);
  });

  it('continuationSameSide rejects flipped market', () => {
    const dump: TenSecBar[] = [];
    for (let i = 0; i < 10; i++) {
      dump.push(bar(4520 - i * 2, 4518 - i * 2, i, 1));
    }
    const red = bar(4500, 4497, 10);
    const c = continuationSameSide('BUY', red, 'TREND_DOWN', dump);
    expect(c.ok).toBe(false);
  });
});
