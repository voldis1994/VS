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

  it('10m dump dominates (screenshot case) → SELL even if 5m bounce', () => {
    // Hard 10m dump then mild bounce — 10m stays deeply negative
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
    // ~5m bounce (~1.5pt) — not enough to flip 10m
    for (let i = 50; i < 65; i++) {
      const prev = bars[bars.length - 1]!.close;
      const o = prev + 0.08;
      bars.push({
        open_time_ms: i * 10_000,
        open: o,
        high: o + 0.2,
        low: o - 0.05,
        close: o + 0.1,
        ticks: 8,
      });
    }
    const live = bars[bars.length - 1]!;
    const tape = tapeSide(bars, live);
    expect(tape.pts10m).toBeLessThan(-1.5);
    expect(tape.dir).toBe('SELL');
    expect(decideEntryFrom10sRegime(live, 'TRANSITION', bars)?.direction).toBe('SELL');
  });

  it('25/10/5/1 UP → BUY only', () => {
    const bars = upBars(150, 4580, 0.05);
    const live = bars[bars.length - 1]!;
    expect(tapeSide(bars, live).dir).toBe('BUY');
    expect(allowEntryAgainstImpulse('SELL', bars, live).ok).toBe(false);
  });

  it('1–5m DOWN → SELL', () => {
    const bars = downBars(50, 4700, 0.12);
    const live = bars[bars.length - 1]!;
    expect(tapeSide(bars, live).dir).toBe('SELL');
    expect(decideEntryFrom10sRegime(live, 'UNKNOWN', bars)?.direction).toBe('SELL');
  });

  it('blocks SELL into clear UP stack', () => {
    const bars = upBars(100, 4600, 0.1);
    const live = bars[bars.length - 1]!;
    expect(allowEntryAgainstImpulse('SELL', bars, live).ok).toBe(false);
  });

  it('huge signal bar does NOT block (no late-bar WAIT)', () => {
    const bars = upBars(80, 4600, 0.06);
    const late = {
      open_time_ms: 999,
      open: 4640,
      high: 4647,
      low: 4639.5,
      close: 4646,
      ticks: 8,
    };
    // Append so tape still UP
    const withLate = [...bars, late];
    const entry = decideEntryFrom10sRegime(late, 'TRANSITION', withLate);
    expect(entry).not.toBeNull();
    expect(entry!.direction).toBe('BUY');
  });
});
