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

  it('hard-fails stale quote (matches DATA_STALE / Stage·validate)', () => {
    const q = quote(4400);
    q.ts_ms = Date.now() - 60_000;
    const v = validateMarket(barsVarying(12), q, { stale_ms: 15_000 });
    expect(v.reasons).toContain('stale_quote');
    expect(v.ok).toBe(false);
  });

  it('Capital LIVE default 90s allows age=60s (was false-BLOCK)', () => {
    const q = quote(4400 + 11 * 0.5);
    q.ts_ms = Date.now() - 60_000;
    const v = validateMarket(barsVarying(12), q);
    expect(v.reasons).not.toContain('stale_quote');
    expect(v.ok).toBe(true);
  });

  it('hard-fails feed_divergent when public mids disagree with quote (READER honesty)', () => {
    const v = validateMarket(barsVarying(12), quote(4400), {
      reference_mids: [4400, 4600],
    });
    expect(v.reasons).toContain('feed_divergent');
    expect(v.ok).toBe(false);
  });

  it('passes when reference mids agree with quote', () => {
    const mid = 4400 + 11 * 0.5;
    const v = validateMarket(barsVarying(12), quote(mid), {
      reference_mids: [mid, mid + 0.5, mid - 0.4],
    });
    expect(v.reasons).not.toContain('feed_divergent');
    expect(v.ok).toBe(true);
  });

  it('ignores empty reference_mids (single-source path unchanged)', () => {
    const v = validateMarket(barsVarying(12), quote(4400 + 11 * 0.5), {
      reference_mids: [],
    });
    expect(v.reasons).not.toContain('feed_divergent');
    expect(v.ok).toBe(true);
  });

  it('assessFeedDivergence marks DIVERGENT on wide broker vs public span', async () => {
    const { assessFeedDivergence } = await import('../marketData.js');
    const d = assessFeedDivergence(4400, [4600, 4610]);
    expect(d.agreement).toBe('DIVERGENT');
    expect(d.contributing).toBeGreaterThanOrEqual(2);
  });
});
