import { describe, expect, it } from 'vitest';
import {
  decideOneMinMoveEntry,
  oneMinMoveConfirm,
  closedOneMinBars,
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

/** Uptrend 5m without BOS — sine wave */
function bars5mUp(n = 20): StructureBar[] {
  const out: StructureBar[] = [];
  for (let i = 0; i < n; i++) {
    const base = 4600 + i * 0.4 + Math.sin(i / 2) * 1.5;
    out.push(sb(i * 300_000, base, base + 1.2, base - 0.4, base + 0.6));
  }
  return out;
}

describe('1m MOVE confirm entry', () => {
  it('oneMinMoveConfirm detects bullish displacement on closed 1m', () => {
    const bars = [
      sb(0, 4600, 4600.5, 4599.8, 4600.2),
      sb(60_000, 4600.2, 4601.5, 4600.1, 4601.2, false),
    ];
    const r = oneMinMoveConfirm(bars, 'BUY', 4601.2, 2, { tick_size: 0.01 });
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/1m MOVE BUY/);
  });

  it('forming 1m bar does not confirm', () => {
    const bars = [sb(60_000, 4600, 4601.5, 4599, 4601.2, true)];
    expect(closedOneMinBars(bars)).toHaveLength(0);
  });

  it('decideOneMinMoveEntry fires on tape + 5m up + fresh 1m close', () => {
    const bars5m = bars5mUp(18);
    const bars1m = [
      sb(0, 4605, 4605.4, 4604.8, 4605.1),
      sb(60_000, 4605.1, 4606.8, 4605.0, 4606.5),
    ];
    const entry = decideOneMinMoveEntry({
      bars5m,
      bars1m,
      tape_dir: 'BUY',
      regime: 'TREND_UP',
      htf: { trend: 'UP', near_support: true },
      price: 4606.5,
      spread: 0.3,
      broker_min_stop: 0.5,
      tick_size: 0.01,
      one_min_just_closed: true,
    });
    expect(entry).not.toBeNull();
    expect(entry!.direction).toBe('BUY');
    expect(entry!.reason).toMatch(/1M MOVE BUY/);
  });

  it('requires fresh 1m close flag', () => {
    const bars5m = bars5mUp(18);
    const bars1m = [sb(60_000, 4605.1, 4606.8, 4605.0, 4606.5)];
    expect(
      decideOneMinMoveEntry({
        bars5m,
        bars1m,
        tape_dir: 'BUY',
        price: 4606.5,
        spread: 0.3,
        tick_size: 0.01,
        one_min_just_closed: false,
      })
    ).toBeNull();
  });

  it('blocks when tape fights 5m trend', () => {
    const bars5m = bars5mUp(18).map((b, i) =>
      i > 12 ? sb(b.open_time_ms, b.open, b.high, b.low, b.open - 0.8) : b
    );
    const bars1m = [sb(60_000, 4605.1, 4606.8, 4605.0, 4606.5)];
    expect(
      decideOneMinMoveEntry({
        bars5m,
        bars1m,
        tape_dir: 'BUY',
        price: 4606.5,
        spread: 0.3,
        tick_size: 0.01,
        one_min_just_closed: true,
      })
    ).toBeNull();
  });
});
