import { describe, expect, it } from 'vitest';
import { LiveBarBuilder } from '../liveFeed.js';

describe('VS MASTER live bar builder', () => {
  it('seeds history and closes bars on interval', () => {
    const b = new LiveBarBuilder(1000, 20);
    b.seedAround(4400, 10);
    expect(b.getBars().length).toBe(10);
    const t0 = 1_000_000;
    const a = b.pushTick(4401, t0);
    expect(a.justClosed).toBeNull();
    const c = b.pushTick(4402, t0 + 1001);
    expect(c.justClosed).not.toBeNull();
    expect(c.bars.length).toBeGreaterThan(10);
  });
});
