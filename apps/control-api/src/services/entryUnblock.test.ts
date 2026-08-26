import { describe, expect, it } from 'vitest';
import {
  blockEntryAtExtreme,
  decideEntryFrom10sRegime,
  structNetMove,
} from './entryFromRegime.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, close: number, i = 0, w = 1.5): TenSecBar {
  const high = Math.max(open, close) + w;
  const low = Math.min(open, close) - w;
  return { open_time_ms: i * 10_000, open, high, low, close, ticks: 8 };
}

function baseBars(): TenSecBar[] {
  const out: TenSecBar[] = [];
  for (let i = 0; i < 12; i++) {
    const mid = 4500 + (i % 2) * 0.3;
    out.push(bar(mid, mid + 0.2, i, 1.0));
  }
  return out;
}

describe('unblocked entry', () => {
  it('COMPRESSION allows entry when struct trend is clear', () => {
    const bars: TenSecBar[] = [];
    for (let i = 0; i < 24; i++) {
      const o = 4650 - i * 0.35;
      bars.push(bar(o, o - 0.25, i, 1.2));
    }
    const sig = bar(4641.5, 4641.0, 24, 1.0);
    const entry = decideEntryFrom10sRegime(sig, 'COMPRESSION', bars);
    expect(structNetMove(bars).dir).toBe('DOWN');
    expect(entry).not.toBeNull();
    expect(entry!.direction).toBe('SELL');
  });

  it('blocks SELL at swing low after big struct dump (4633 case)', () => {
    const bars: TenSecBar[] = [];
    for (let i = 0; i < 24; i++) {
      const o = 4650 - i * 0.7;
      bars.push(bar(o, o - 0.5, i, 0.8));
    }
    const atLow = bar(4633.5, 4633.2, 24, 0.6);
    const gate = blockEntryAtExtreme('SELL', bars, atLow);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/swing low/);
  });

  it('still blocks TRANSITION without inventing trades', () => {
    expect(decideEntryFrom10sRegime(bar(4501, 4503, 12), 'TRANSITION', baseBars())).toBeNull();
  });

  it('UNKNOWN enters on clear short UP (not forever WAIT)', () => {
    const bars: TenSecBar[] = [];
    for (let i = 0; i < 12; i++) {
      const o = 4638 + i * 0.4;
      bars.push(bar(o, o + 0.3, i, 1.0));
    }
    const sig = bar(4642.5, 4643.2, 12, 1.0);
    const entry = decideEntryFrom10sRegime(sig, 'UNKNOWN', bars);
    expect(entry).not.toBeNull();
    expect(entry!.direction).toBe('BUY');
  });
});
