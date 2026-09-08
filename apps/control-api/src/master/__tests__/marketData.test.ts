import { describe, expect, it } from 'vitest';
import { validateMarket } from '../marketData.js';
import type { Bar, Quote } from '../types.js';

function barsVarying(n: number, base = 4400): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = base + i * 0.5;
    return {
      open: c,
      high: c + 1,
      low: c - 0.5,
      close: c,
      ts_ms: Date.now() - (n - i) * 60_000,
    };
  });
}

function barsFlat(n: number, mid = 4400): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    open: mid,
    high: mid,
    low: mid,
    close: mid,
    ts_ms: Date.now() - (n - i) * 60_000,
  }));
}

function quote(mid = 4400): Quote {
  return {
    bid: mid - 0.2,
    ask: mid + 0.2,
    mid,
    spread: 0.4,
    ts_ms: Date.now(),
    epic: 'GOLD',
  };
}

describe('validateMarket flat_tape', () => {
  it('hard-fails identical last-8 closes (no soft-only trade path)', () => {
    const v = validateMarket(barsFlat(12), quote(4400));
    expect(v.reasons).toContain('flat_tape');
    expect(v.ok).toBe(false);
    expect(v.quality).toBeLessThan(0.7);
  });

  it('passes varying tape with fresh quote', () => {
    const v = validateMarket(barsVarying(12), quote(4400 + 11 * 0.5));
    expect(v.reasons).not.toContain('flat_tape');
    expect(v.ok).toBe(true);
  });

  it('still hard-fails insufficient bars', () => {
    const v = validateMarket(barsVarying(2), quote());
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain('insufficient_bars');
  });
});
