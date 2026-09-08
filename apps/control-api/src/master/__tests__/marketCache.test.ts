import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { loadMarketCache, saveMarketCache } from '../marketCache.js';

describe('market_cache persist', () => {
  it('round-trips bars and drops stale quote on load path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'master-mkt-cache-'));
    const bars = Array.from({ length: 10 }, (_, i) => ({
      open: 4400 + i,
      high: 4401 + i,
      low: 4399 + i,
      close: 4400.5 + i,
      ts_ms: Date.now() - (10 - i) * 60_000,
    }));
    const ok = saveMarketCache(
      {
        epic: 'GOLD',
        bars,
        quote: {
          bid: 4410,
          ask: 4410.4,
          mid: 4410.2,
          spread: 0.4,
          epic: 'GOLD',
          ts_ms: Date.now(),
        },
        structure_seed_source: 'capital_ohlc',
      },
      dir
    );
    expect(ok).toBe(true);
    expect(existsSync(join(dir, 'market_cache.json'))).toBe(true);
    const loaded = loadMarketCache(dir);
    expect(loaded?.bars.length).toBe(10);
    expect(loaded?.epic).toBe('GOLD');
    expect(loaded?.structure_seed_source).toBe('capital_ohlc');
    expect(loaded?.quote?.mid).toBeCloseTo(4410.2, 5);
  });

  it('rejects empty garbage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'master-mkt-empty-'));
    expect(
      saveMarketCache({ epic: 'GOLD', bars: [], quote: null }, dir)
    ).toBe(false);
    expect(loadMarketCache(dir)).toBeNull();
  });
});
