import { describe, expect, it } from 'vitest';
import {
  allowEntryAgainstImpulse,
  decideEntryFrom10sRegime,
  tapeSide,
} from './entryFromRegime.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function upBars(n = 150, start = 4600, step = 0.08): TenSecBar[] {
  const out: TenSecBar[] = [];
  for (let i = 0; i < n; i++) {
    const o = start + i * step;
    out.push({
      open_time_ms: i * 10_000,
      open: o,
      high: o + 0.4,
      low: o - 0.2,
      close: o + 0.12,
      ticks: 8,
      provenance: 'REAL',
    });
  }
  return out;
}

function downBars(n = 80, start = 4680, step = 0.08): TenSecBar[] {
  const out: TenSecBar[] = [];
  for (let i = 0; i < n; i++) {
    const o = start - i * step;
    out.push({
      open_time_ms: i * 10_000,
      open: o,
      high: o + 0.2,
      low: o - 0.4,
      close: o - 0.12,
      ticks: 8,
      provenance: 'REAL',
    });
  }
  return out;
}

describe('entry gates — no PROFIT bypass', () => {
  it('blocks SELL against clear UP impulse', () => {
    const bars = upBars(40, 4580, 0.08);
    const live = bars[bars.length - 1]!;
    expect(tapeSide(bars, live).dir).toBe('BUY');
    expect(allowEntryAgainstImpulse('SELL', bars, live).ok).toBe(false);
  });

  it('blocks BUY against clear DOWN impulse', () => {
    const bars = downBars(40, 4700, 0.12);
    const live = bars[bars.length - 1]!;
    expect(allowEntryAgainstImpulse('BUY', bars, live).ok).toBe(false);
  });

  it('synthetic signal bar cannot enter', () => {
    const bars = upBars(90, 4600, 0.05);
    const live: TenSecBar = {
      ...bars[bars.length - 1]!,
      provenance: 'SYNTHETIC',
    };
    expect(decideEntryFrom10sRegime(live, 'TREND_UP', bars)).toBeNull();
  });

  it('10s color alone without 5m structure does not force entry', () => {
    const bars = upBars(20, 4600, 0.01); // too few for 5m aggregate
    const live = bars[bars.length - 1]!;
    // Need 30×10s per 5m bar × 8 = 240 for 8 five-min bars — 20 is insufficient
    expect(decideEntryFrom10sRegime(live, 'TRANSITION', bars)).toBeNull();
  });
});
