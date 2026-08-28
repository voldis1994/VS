import { describe, expect, it } from 'vitest';
import {
  decideOneMinMoveEntry,
  oneMinMoveConfirm,
  closedOneMinBars,
  directionFromOneMinMove,
} from './oneMinMoveEntry.js';
import type { StructureBar } from './marketStructure.js';

function sb(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  forming = false
): StructureBar {
  return { open_time_ms: t, open: o, high: h, low: l, close: c, ticks: 10, provenance: 'REAL', forming };
}

function bars5mUp(n = 20): StructureBar[] {
  const out: StructureBar[] = [];
  for (let i = 0; i < n; i++) {
    const base = 4600 + i * 0.4 + Math.sin(i / 2) * 1.5;
    out.push(sb(i * 300_000, base, base + 1.2, base - 0.4, base + 0.6));
  }
  return out;
}

describe('1m MOVE confirm entry (fast)', () => {
  it('oneMinMoveConfirm detects bullish displacement on closed 1m', () => {
    const bars = [
      sb(0, 4600, 4600.5, 4599.8, 4600.2),
      sb(60_000, 4600.2, 4601.5, 4600.1, 4601.2, false),
    ];
    const r = oneMinMoveConfirm(bars, 'BUY', 4601.2, 2, { tick_size: 0.01 });
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/1m MOVE BUY/);
  });

  it('LIVE forming 1m can confirm mid-candle', () => {
    const bars = [
      sb(0, 4600, 4600.4, 4599.9, 4600.2),
      sb(60_000, 4600.2, 4601.8, 4600.1, 4601.4, true),
    ];
    const r = oneMinMoveConfirm(bars, 'BUY', 4601.4, 2, { tick_size: 0.01 }, { allowLive: true });
    expect(r.ok).toBe(true);
    expect(r.live).toBe(true);
  });

  it('forming alone is ignored without allowLive', () => {
    const bars = [sb(60_000, 4600, 4601.5, 4599, 4601.2, true)];
    expect(closedOneMinBars(bars)).toHaveLength(0);
    expect(oneMinMoveConfirm(bars, 'BUY', 4601.2, 2, { tick_size: 0.01 }).ok).toBe(false);
  });

  it('direction comes from 1m — tape not required', () => {
    const bars5m = bars5mUp(18);
    const bars1m = [
      sb(0, 4605, 4605.4, 4604.8, 4605.1),
      sb(60_000, 4605.1, 4606.8, 4605.0, 4606.5),
    ];
    const entry = decideOneMinMoveEntry({
      bars5m,
      bars1m,
      tape_dir: null,
      regime: 'RANGE',
      htf: { trend: 'RANGE', near_support: true },
      price: 4606.5,
      spread: 0.3,
      broker_min_stop: 0.5,
      tick_size: 0.01,
    });
    expect(entry).not.toBeNull();
    expect(entry!.direction).toBe('BUY');
    expect(entry!.reason).toMatch(/1M MOVE BUY/);
  });

  it('dedup: already fired bar key → null', () => {
    const bars5m = bars5mUp(18);
    const bars1m = [sb(60_000, 4605.1, 4606.8, 4605.0, 4606.5)];
    expect(
      decideOneMinMoveEntry({
        bars5m,
        bars1m,
        price: 4606.5,
        spread: 0.3,
        tick_size: 0.01,
        already_fired_bar_key: '60000',
      })
    ).toBeNull();
  });

  it('LIVE forming path fires without waiting for close', () => {
    const bars5m = bars5mUp(18);
    const bars1m = [
      sb(0, 4605, 4605.3, 4604.9, 4605.1),
      sb(60_000, 4605.1, 4607.0, 4605.0, 4606.6, true),
    ];
    const entry = decideOneMinMoveEntry({
      bars5m,
      bars1m,
      price: 4606.6,
      spread: 0.3,
      tick_size: 0.01,
      broker_min_stop: 0.5,
    });
    expect(entry).not.toBeNull();
    expect(entry!.live).toBe(true);
    expect(entry!.direction).toBe('BUY');
  });

  it('blocks hard opposite 5m trend', () => {
    const bars5m: StructureBar[] = [];
    for (let i = 0; i < 18; i++) {
      const base = 4620 - i * 0.8;
      bars5m.push(sb(i * 300_000, base, base + 0.3, base - 1.0, base - 0.7));
    }
    const bars1m = [sb(60_000, 4605.1, 4606.8, 4605.0, 4606.5)];
    expect(
      decideOneMinMoveEntry({
        bars5m,
        bars1m,
        price: 4606.5,
        spread: 0.3,
        tick_size: 0.01,
      })
    ).toBeNull();
  });

  it('move threshold works without ATR or tick metadata', () => {
    const bars = [sb(60_000, 4600.2, 4601.5, 4600.1, 4601.2, false)];
    const r = oneMinMoveConfirm(bars, 'BUY', 4601.2, null, null);
    expect(r.detail).not.toMatch(/UNKNOWN/i);
  });
});
