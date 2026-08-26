import { describe, expect, it } from 'vitest';
import {
  allowEntryAgainstImpulse,
  decideEntryFrom10sRegime,
  explainNoEntry,
  tapeSide,
} from './entryFromRegime.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function quietBox(n = 20, mid = 4640): TenSecBar[] {
  const out: TenSecBar[] = [];
  for (let i = 0; i < n; i++) {
    const m = mid + (i % 3) * 0.25;
    const open = m;
    const close = m + 0.15;
    out.push({
      open_time_ms: i * 10_000,
      open,
      high: Math.max(open, close) + 1.1,
      low: Math.min(open, close) - 1.1,
      close,
      ticks: 8,
    });
  }
  return out;
}

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
    });
  }
  return out;
}

describe('no WAIT blocks — tape only', () => {
  it('FLAT mid-box → SCAN not WAIT ENTRY', () => {
    const bars = quietBox(40);
    const mid = {
      open_time_ms: 40 * 10_000,
      open: 4640.3,
      high: 4640.5,
      low: 4640.1,
      close: 4640.35,
      ticks: 8,
    };
    expect(tapeSide(bars, mid).dir).toBeNull();
    expect(decideEntryFrom10sRegime(mid, 'TRANSITION', bars)).toBeNull();
    expect(explainNoEntry(mid, 'TRANSITION', bars)).toMatch(/SCAN|TAPE FLAT/i);
    expect(explainNoEntry(mid, 'TRANSITION', bars)).not.toMatch(/WAIT ENTRY|WAIT ·/i);
  });

  it('TRANSITION / UNKNOWN never block when tape UP', () => {
    const bars = upBars(120, 4600, 0.06);
    const live = bars[bars.length - 1]!;
    expect(tapeSide(bars, live).dir).toBe('BUY');
    for (const regime of ['UNKNOWN', 'TRANSITION', 'COMPRESSION', 'RANGE']) {
      const entry = decideEntryFrom10sRegime(live, regime, bars);
      expect(entry, regime).not.toBeNull();
      expect(entry!.direction).toBe('BUY');
    }
  });

  it('5m bounce after older dump → not forced SELL (10m removed)', () => {
    // Older dump then clear 5m bounce — direction follows 5m+1m, not stale 10m
    const bars: TenSecBar[] = [];
    for (let i = 0; i < 50; i++) {
      const o = 4680 - i * 0.15;
      bars.push({
        open_time_ms: i * 10_000,
        open: o,
        high: o + 0.1,
        low: o - 0.3,
        close: o - 0.2,
        ticks: 8,
      });
    }
    for (let i = 50; i < 80; i++) {
      const prev = bars[bars.length - 1]!.close;
      const o = prev + 0.12;
      bars.push({
        open_time_ms: i * 10_000,
        open: o,
        high: o + 0.25,
        low: o - 0.05,
        close: o + 0.15,
        ticks: 8,
      });
    }
    const live = bars[bars.length - 1]!;
    const tape = tapeSide(bars, live);
    expect(tape.pts5m).toBeGreaterThan(0.8);
    expect(tape.dir).toBe('BUY');
    expect(decideEntryFrom10sRegime(live, 'TRANSITION', bars)?.direction).toBe('BUY');
  });

  it('5m+1m UP → SELL also allowed in profit mode', () => {
    const bars = upBars(40, 4580, 0.08);
    const live = bars[bars.length - 1]!;
    expect(tapeSide(bars, live).dir).toBe('BUY');
    expect(allowEntryAgainstImpulse('SELL', bars, live).ok).toBe(true);
  });

  it('5m+1m DOWN → SELL', () => {
    const bars = downBars(40, 4700, 0.12);
    const live = bars[bars.length - 1]!;
    expect(tapeSide(bars, live).dir).toBe('SELL');
    expect(decideEntryFrom10sRegime(live, 'UNKNOWN', bars)?.direction).toBe('SELL');
  });

  it('profit mode allows SELL into clear UP stack', () => {
    const bars = upBars(40, 4600, 0.1);
    const live = bars[bars.length - 1]!;
    expect(allowEntryAgainstImpulse('SELL', bars, live).ok).toBe(true);
  });

  it('late signal bar is allowed in profit mode', () => {
    const bars = upBars(40, 4600, 0.08);
    const late = {
      open_time_ms: 999,
      open: 4640,
      high: 4647,
      low: 4639.5,
      close: 4646,
      ticks: 8,
    };
    expect(decideEntryFrom10sRegime(late, 'TRANSITION', bars)?.direction).toBe('BUY');
  });

  it('early PROFIT BUY fires before finished 5m climb (~0.6pt not 1.2pt)', () => {
    const bars: TenSecBar[] = [];
    let px = 4640;
    for (let i = 0; i < 36; i++) {
      const step = i < 24 ? 0.012 : 0.05; // soft climb then early push
      const o = px;
      const c = px + step;
      bars.push({
        open_time_ms: i * 10_000,
        open: o,
        high: c + 0.05,
        low: o - 0.05,
        close: c,
        ticks: 8,
      });
      px = c;
    }
    const live = bars[bars.length - 1]!;
    const tape = tapeSide(bars, live);
    const entry = decideEntryFrom10sRegime(live, 'TRANSITION', bars);
    expect(entry).not.toBeNull();
    expect(entry!.direction).toBe('BUY');
    expect(entry!.reason).toMatch(/PROFIT BUY/i);
    expect(tape.pts5m).toBeLessThan(1.2);
  });
});
