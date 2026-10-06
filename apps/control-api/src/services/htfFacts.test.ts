import { describe, expect, it } from 'vitest';
import {
  buildTfFacts,
  closedCandlesOnly,
  detectBreakoutEvent,
  detectLiquidity,
  type HtfTimedCandle,
} from './htfFacts.js';

function c(
  o: number,
  h: number,
  l: number,
  close: number,
  t: number
): HtfTimedCandle {
  return { open: o, high: h, low: l, close, open_time_ms: t };
}

describe('htfFacts', () => {
  it('liquidity sweep stays PENDING until reaction candles', () => {
    const base = 1_700_000_000_000;
    const candles: HtfTimedCandle[] = [];
    for (let i = 0; i < 12; i++) {
      candles.push(c(100, 100.4, 99.6, 100.1, base + i * 60_000));
    }
    candles[6] = c(100, 101.5, 99.8, 101, base + 6 * 60_000); // swing high
    candles[7] = c(101, 101.2, 100, 100.5, base + 7 * 60_000);
    // Sweep high — wick above, close back
    candles[10] = c(100.5, 101.8, 100.4, 100.6, base + 10 * 60_000);
    candles[11] = c(100.6, 100.7, 100.3, 100.5, base + 11 * 60_000);
    const withTip = [...candles, c(100.5, 100.6, 100.4, 100.5, base + 12 * 60_000)];
    const closed = closedCandlesOnly(withTip);
    const liq = detectLiquidity(closed, 101.5, 99.6);
    expect(liq).not.toBeNull();
    expect(liq!.kind).toBe('SWEEP_HIGH');
    expect(liq!.reaction).not.toBe('CONTINUED');
  });

  it('two closes beyond level → ACCEPTANCE', () => {
    const base = 1_700_000_000_000;
    const candles: HtfTimedCandle[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push(c(100, 100.3, 99.7, 100, base + i * 60_000));
    }
    candles.push(c(100, 101.2, 99.9, 101.1, base + 10 * 60_000));
    candles.push(c(101.1, 101.5, 101, 101.3, base + 11 * 60_000));
    const brk = detectBreakoutEvent(candles, 100.5, 99.5);
    expect(brk?.status).toBe('ACCEPTANCE');
    expect(brk?.side).toBe('UP');
  });

  it('buildTfFacts returns measurable facts only', () => {
    const base = 1_700_000_000_000;
    const candles: HtfTimedCandle[] = [];
    // Zig-zag so confirmed pivots exist
    const path = [100, 101.5, 100.8, 102.5, 101.5, 103.2, 102.2, 104, 103, 104.5];
    for (let i = 0; i < path.length; i++) {
      const px = path[i]!;
      const prev = i ? path[i - 1]! : px;
      candles.push(
        c(prev, Math.max(prev, px) + 0.2, Math.min(prev, px) - 0.2, px, base + i * 60_000)
      );
    }
    candles.push(c(104.5, 105, 104.3, 104.7, base + path.length * 60_000));
    const f = buildTfFacts('15m', candles);
    expect(f).not.toBeNull();
    expect(f!.swing_highs.length + f!.swing_lows.length).toBeGreaterThan(0);
    expect(typeof f!.displacement).toBe('number');
    expect(f!.volatility).toBeTruthy();
    expect(f!.price_location).toBeTruthy();
  });
});
