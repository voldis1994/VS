import { describe, expect, it } from 'vitest';
import {
  allowEntryAgainstImpulse,
  blockLateTrendChase,
  decideEntryFrom10sRegime,
  explainNoEntry,
  signalBarTooLate,
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

/** Steady multi-TF UP (~25m worth). */
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

describe('multi-TF tape entry (25/10/5/1 — no regime WAIT)', () => {
  it('FLAT mid-box → no entry (not UNKNOWN wait)', () => {
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
    expect(decideEntryFrom10sRegime(mid, 'UNKNOWN', bars)).toBeNull();
    expect(decideEntryFrom10sRegime(mid, 'TRANSITION', bars)).toBeNull();
    expect(explainNoEntry(mid, 'UNKNOWN', bars)).toMatch(/NO ENTRY|TAPE FLAT/i);
    expect(explainNoEntry(mid, 'UNKNOWN', bars)).not.toMatch(/WAIT · UNKNOWN/i);
  });

  it('UNKNOWN / TRANSITION / COMPRESSION do not block when tape UP', () => {
    const bars = upBars(120, 4600, 0.06);
    const live = bars[bars.length - 1]!;
    expect(tapeSide(bars, live).dir).toBe('BUY');
    for (const regime of ['UNKNOWN', 'TRANSITION', 'COMPRESSION', 'RANGE', 'REVERSAL_CANDIDATE']) {
      const entry = decideEntryFrom10sRegime(live, regime, bars);
      expect(entry, regime).not.toBeNull();
      expect(entry!.direction).toBe('BUY');
    }
  });

  it('25/10/5/1 UP → BUY only', () => {
    const bars = upBars(150, 4580, 0.05);
    const live = bars[bars.length - 1]!;
    const tape = tapeSide(bars, live);
    expect(tape.dir).toBe('BUY');
    expect(tape.reason).toMatch(/TAPE UP|25m=/);
    const entry = decideEntryFrom10sRegime(live, 'RANGE', bars);
    expect(entry!.direction).toBe('BUY');
    expect(allowEntryAgainstImpulse('SELL', bars, live).ok).toBe(false);
  });

  it('1–5m DOWN → SELL when longer not UP', () => {
    const bars = downBars(50, 4700, 0.12);
    const live = bars[bars.length - 1]!;
    expect(tapeSide(bars, live).dir).toBe('SELL');
    const entry = decideEntryFrom10sRegime(live, 'UNKNOWN', bars);
    expect(entry).not.toBeNull();
    expect(entry!.direction).toBe('SELL');
  });

  it('blocks SELL on pullback at top of UP tape', () => {
    const bars = upBars(100, 4600, 0.1);
    // short red pullback at end
    for (let i = 0; i < 8; i++) {
      const o = bars[bars.length - 1]!.close - i * 0.15;
      bars.push({
        open_time_ms: (100 + i) * 10_000,
        open: o,
        high: o + 0.1,
        low: o - 0.25,
        close: o - 0.12,
        ticks: 8,
      });
    }
    const pullback = bars[bars.length - 1]!;
    expect(allowEntryAgainstImpulse('SELL', bars, pullback).ok).toBe(false);
    const entry = decideEntryFrom10sRegime(pullback, 'COMPRESSION', bars);
    // either null or BUY — never SELL into UP stack
    if (entry) expect(entry.direction).toBe('BUY');
  });

  it('rejects huge already-ran signal bar', () => {
    const late = {
      open_time_ms: 1,
      open: 4640,
      high: 4647,
      low: 4639.5,
      close: 4646,
      ticks: 8,
    };
    expect(signalBarTooLate(late)).toBe(true);
    expect(decideEntryFrom10sRegime(late, 'TREND_UP', quietBox())).toBeNull();
  });

  it('blocks only extreme climax BUY (soft gate)', () => {
    const bars = upBars(80, 4500, 0.25); // huge run
    const top = bars[bars.length - 1]!;
    expect(blockLateTrendChase('BUY', bars, top).ok).toBe(false);
  });
});
