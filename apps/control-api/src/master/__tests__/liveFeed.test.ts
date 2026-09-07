import { describe, expect, it } from 'vitest';
import { LiveBarBuilder } from '../liveFeed.js';

describe('VS MASTER live bar builder', () => {
  it('seeds history and closes bars on interval', () => {
    const b = new LiveBarBuilder(1000, 20);
    b.seedAround(4400, 10);
    expect(b.seed_source).toBe('synthetic_fallback');
    expect(b.getBars().length).toBe(10);
    const t0 = 1_000_000;
    const a = b.pushTick(4401, t0);
    expect(a.justClosed).toBeNull();
    const c = b.pushTick(4402, t0 + 1001);
    expect(c.justClosed).not.toBeNull();
    expect(c.bars.length).toBeGreaterThan(10);
  });

  it('seedBars marks yahoo_ohlc source', () => {
    const b = new LiveBarBuilder(1000, 20);
    b.seedBars([
      { open: 1, high: 2, low: 0.5, close: 1.5, ts_ms: 1 },
      { open: 1.5, high: 2.5, low: 1, close: 2, ts_ms: 2 },
    ]);
    expect(b.seed_source).toBe('yahoo_ohlc');
    expect(b.getBars().length).toBe(2);
  });
});
