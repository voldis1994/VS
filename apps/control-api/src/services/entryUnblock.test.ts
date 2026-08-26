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

describe('entry + TRADER vision', () => {
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
    expect(explainNoEntry(mid, 'TRANSITION', bars)).toMatch(/SCAN|TAPE FLAT|TRADER/i);
    expect(explainNoEntry(mid, 'TRANSITION', bars)).not.toMatch(/WAIT ENTRY|WAIT ·/i);
  });

  it('early tape UP mid-range → BUY (regime labels ignored)', () => {
    const bars: TenSecBar[] = [];
    let px = 4600;
    for (let i = 0; i < 20; i++) {
      bars.push({
        open_time_ms: i * 10_000,
        open: px,
        high: px + 0.35,
        low: px - 0.15,
        close: px + 0.1,
        ticks: 8,
      });
      px += 0.1;
    }
    for (let i = 20; i < 26; i++) {
      bars.push({
        open_time_ms: i * 10_000,
        open: px,
        high: px + 0.1,
        low: px - 0.2,
        close: px - 0.12,
        ticks: 8,
      });
      px -= 0.12;
    }
    const live = {
      open_time_ms: 26 * 10_000,
      open: px,
      high: px + 0.2,
      low: px - 0.05,
      close: px + 0.14,
      ticks: 8,
    };
    expect(tapeSide(bars, live).dir).toBe('BUY');
    for (const regime of ['UNKNOWN', 'TRANSITION', 'COMPRESSION', 'RANGE']) {
      const entry = decideEntryFrom10sRegime(live, regime, bars);
      expect(entry, regime).not.toBeNull();
      expect(entry!.direction).toBe('BUY');
      expect(entry!.reason).toMatch(/OK BUY|TRADER/i);
    }
  });

  it('blocks BUY at extended top (120-bar climb = swing high)', () => {
    const bars = upBars(120, 4600, 0.06);
    const live = bars[bars.length - 1]!;
    expect(tapeSide(bars, live).dir).toBe('BUY');
    expect(decideEntryFrom10sRegime(live, 'TRANSITION', bars)).toBeNull();
    expect(explainNoEntry(live, 'TRANSITION', bars)).toMatch(/NO BUY|chase top|TRADER/i);
  });

  it('5m bounce that reaches swing HIGH → TRADER blocks chase', () => {
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
    for (let i = 50; i < 72; i++) {
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
    expect(tapeSide(bars, live).dir).toBe('BUY');
    const entry = decideEntryFrom10sRegime(live, 'TRANSITION', bars);
    expect(entry).toBeNull();
    expect(explainNoEntry(live, 'TRANSITION', bars)).toMatch(/NO BUY|swing HIGH/i);
  });

  it('5m+1m UP → impulse gate still free', () => {
    const bars = upBars(40, 4580, 0.08);
    const live = bars[bars.length - 1]!;
    expect(tapeSide(bars, live).dir).toBe('BUY');
    expect(allowEntryAgainstImpulse('SELL', bars, live).ok).toBe(true);
  });

  it('blocks SELL at swing LOW after extended dump', () => {
    const bars: TenSecBar[] = [];
    let px = 4720;
    for (let i = 0; i < 35; i++) {
      bars.push({
        open_time_ms: i * 10_000,
        open: px,
        high: px + 0.08,
        low: px - 0.28,
        close: px - 0.14,
        ticks: 8,
      });
      px -= 0.14;
    }
    const live = {
      open_time_ms: 35 * 10_000,
      open: px + 0.03,
      high: px + 0.05,
      low: px - 0.18,
      close: px - 0.11,
      ticks: 8,
    };
    expect(tapeSide(bars, live).dir).toBe('SELL');
    expect(decideEntryFrom10sRegime(live, 'UNKNOWN', bars)).toBeNull();
    expect(explainNoEntry(live, 'UNKNOWN', bars)).toMatch(/NO SELL|swing LOW|5m LOW/i);
  });

  it('late huge green at top → TRADER blocks BUY', () => {
    const bars = upBars(40, 4600, 0.08);
    const late = {
      open_time_ms: 999,
      open: 4640,
      high: 4647,
      low: 4639.5,
      close: 4646,
      ticks: 8,
    };
    expect(decideEntryFrom10sRegime(late, 'TRANSITION', bars)).toBeNull();
  });

  it('allows SELL on bounce mid-range (not at LOW)', () => {
    const dump: TenSecBar[] = [];
    let px = 4725;
    for (let i = 0; i < 22; i++) {
      const o = px;
      const c = px - 0.1;
      dump.push({
        open_time_ms: i * 10_000,
        open: o,
        high: o + 0.2,
        low: c - 0.2,
        close: c,
        ticks: 8,
      });
      px = c;
    }
    for (let i = 22; i < 28; i++) {
      const o = px;
      const c = px + 0.12;
      dump.push({
        open_time_ms: i * 10_000,
        open: o,
        high: c + 0.1,
        low: o - 0.2,
        close: c,
        ticks: 8,
      });
      px = c;
    }
    const red = {
      open_time_ms: 28 * 10_000,
      open: px,
      high: px + 0.05,
      low: px - 0.15,
      close: px - 0.12,
      ticks: 8,
    };
    expect(tapeSide(dump, red).dir).toBe('SELL');
    expect(decideEntryFrom10sRegime(red, 'UNKNOWN', dump)?.direction).toBe('SELL');
  });

  it('dip-buy mid-range → BUY (trader pullback)', () => {
    const bars: TenSecBar[] = [];
    let px = 4588;
    for (let i = 0; i < 22; i++) {
      const o = px;
      const c = px + 0.1;
      bars.push({
        open_time_ms: i * 10_000,
        open: o,
        high: c + 0.2,
        low: o - 0.2,
        close: c,
        ticks: 8,
      });
      px = c;
    }
    for (let i = 22; i < 28; i++) {
      const o = px;
      const c = px - 0.12;
      bars.push({
        open_time_ms: i * 10_000,
        open: o,
        high: o + 0.1,
        low: c - 0.2,
        close: c,
        ticks: 8,
      });
      px = c;
    }
    const live = {
      open_time_ms: 28 * 10_000,
      open: px,
      high: px + 0.15,
      low: px - 0.05,
      close: px + 0.15,
      ticks: 8,
    };
    const entry = decideEntryFrom10sRegime(live, 'TRANSITION', bars);
    expect(entry?.direction).toBe('BUY');
    expect(entry!.reason).toMatch(/OK BUY|TRADER/i);
  });
});
