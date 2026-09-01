import { describe, expect, it } from 'vitest';
import { computeSignalEngine } from './signalEngine.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(open: number, high: number, low: number, close: number, i = 0): TenSecBar {
  return { open_time_ms: i * 10_000, open, high, low, close, ticks: 10 };
}

/** Pad with quiet history so Units 1–29 have L/N warm-up. */
function withWarmup(tail: TenSecBar[], warm = 140): TenSecBar[] {
  const start = tail[0]?.open ?? 100;
  const out: TenSecBar[] = [];
  let p = start - 0.5;
  for (let i = 0; i < warm; i++) {
    const wobble = Math.sin(i / 7) * 0.02;
    const c = p + wobble;
    out.push(bar(p, c + 0.05, c - 0.05, c, i));
    p = c;
  }
  const base = out.length;
  for (let j = 0; j < tail.length; j++) {
    const b = tail[j]!;
    out.push({ ...b, open_time_ms: (base + j) * 10_000 });
  }
  return out;
}

function trendTail(
  start: number,
  step: number,
  count: number,
  fromIdx = 0
): TenSecBar[] {
  const bars: TenSecBar[] = [];
  let p = start;
  for (let i = 0; i < count; i++) {
    const c = p + step;
    bars.push(bar(p, Math.max(p, c) + 0.3, Math.min(p, c) - 0.3, c, fromIdx + i));
    p = c;
  }
  return bars;
}

describe('signalEngine', () => {
  it('returns seeding output when history is too short', () => {
    const out = computeSignalEngine([bar(100, 100.1, 99.9, 100, 0)]);
    expect(out.ready).toBe(false);
    expect(out.confidence).toBeLessThanOrEqual(0.25);
  });

  it('produces valid probabilities that sum to ~1 when warm', () => {
    const tail = trendTail(100, 0.35, 30);
    const bars = withWarmup(tail);
    const out = computeSignalEngine(bars);
    expect(out.ready).toBe(true);
    const sum = out.p_trend + out.p_transition + out.p_sideways + out.p_breakout;
    expect(sum).toBeGreaterThan(0.99);
    expect(sum).toBeLessThan(1.01);
    expect(out.confidence).toBeGreaterThan(0);
  });

  it('detects upward trend on persistent rally', () => {
    const tail = trendTail(100, 0.45, 40);
    const out = computeSignalEngine(withWarmup(tail));
    expect(out.ready).toBe(true);
    expect(out.regime).toMatch(/TREND_UP|PULLBACK_UPTREND|BREAKOUT_UP/);
    expect(out.direction).toBeGreaterThan(0);
  });

  it('detects downward trend on persistent selloff', () => {
    const tail = trendTail(140, -0.45, 40);
    const out = computeSignalEngine(withWarmup(tail));
    expect(out.ready).toBe(true);
    expect(out.regime).toMatch(/TREND_DOWN|PULLBACK_DOWNTREND|BREAKOUT_DOWN/);
    expect(out.direction).toBeLessThan(0);
  });

  it('exposes lifecycle booleans', () => {
    const flat: TenSecBar[] = [];
    let p = 100;
    for (let i = 0; i < 50; i++) {
      const c = p + Math.sin(i / 3) * 0.04;
      flat.push(bar(p, c + 0.06, c - 0.06, c, i));
      p = c;
    }
    const out = computeSignalEngine(withWarmup(flat));
    expect(typeof out.side_start).toBe('boolean');
    expect(typeof out.side_confirmed).toBe('boolean');
    expect(typeof out.side_end).toBe('boolean');
  });
});
