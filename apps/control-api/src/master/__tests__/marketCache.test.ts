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

  it('embeds market_cache into master_state operator_meta on save', () => {
    const { writeFileSync, readFileSync } = require('fs') as typeof import('fs');
    const dir = mkdtempSync(join(tmpdir(), 'master-mkt-embed-'));
    writeFileSync(
      join(dir, 'master_state.json'),
      JSON.stringify({
        opportunities: [],
        outcomes: [],
        positions: [],
        intents: [],
        operator_meta: { owns_pipeline: true },
      })
    );
    const bars = Array.from({ length: 6 }, (_, i) => ({
      open: 4400 + i,
      high: 4401 + i,
      low: 4399 + i,
      close: 4400.5 + i,
      ts_ms: Date.now() - (6 - i) * 60_000,
    }));
    expect(
      saveMarketCache(
        { epic: 'GOLD', bars, quote: null, structure_seed_source: 'broker_history' },
        dir
      )
    ).toBe(true);
    const state = JSON.parse(readFileSync(join(dir, 'master_state.json'), 'utf8'));
    expect(state.operator_meta?.owns_pipeline).toBe(true);
    expect(state.operator_meta?.market_cache?.bars?.length).toBe(6);
    expect(state.operator_meta?.market_cache?.epic).toBe('GOLD');
  });
});

describe('market_cache hydrate provenance', () => {
  it('status marks Quote/Bars as disk_cache until a live tick', async () => {
    const { masterRuntime } = await import('../runtime.js');
    const dir = mkdtempSync(join(tmpdir(), 'master-mkt-prov-'));
    const prevState = process.env.MASTER_STATE_DIR;
    const prevGates = process.env.MASTER_GATES_DIR;
    process.env.MASTER_STATE_DIR = dir;
    process.env.MASTER_GATES_DIR = dir;
    const prevQuote = masterRuntime.last_quote;
    const prevBars = masterRuntime.last_bars;
    const prevMarket = masterRuntime.last_market;
    try {
      const bars = Array.from({ length: 40 }, (_, i) => {
        const o = 4400 + i * 0.5;
        return {
          open: o,
          high: o + 1,
          low: o - 0.2,
          close: o + 0.4,
          ts_ms: Date.now() - (40 - i) * 60_000,
        };
      });
      expect(
        saveMarketCache(
          {
            epic: 'GOLD',
            bars,
            quote: {
              bid: 4415,
              ask: 4415.4,
              mid: 4415.2,
              spread: 0.4,
              epic: 'GOLD',
              ts_ms: Date.now(),
            },
            structure_seed_source: 'restart_check',
          },
          dir
        )
      ).toBe(true);
      masterRuntime.last_quote = null;
      masterRuntime.last_bars = [];
      masterRuntime.last_market = null;
      (
        masterRuntime as unknown as {
          quoteFromDiskCache: boolean;
          barsFromDiskCache: boolean;
          bookHydrated: boolean;
        }
      ).quoteFromDiskCache = false;
      (
        masterRuntime as unknown as {
          barsFromDiskCache: boolean;
        }
      ).barsFromDiskCache = false;
      (
        masterRuntime as unknown as { bookHydrated: boolean }
      ).bookHydrated = false;
      // Direct disk hydrate path used by hydrateBookFromDisk
      (
        masterRuntime as unknown as {
          hydrateMarketCacheFromDisk: () => void;
        }
      ).hydrateMarketCacheFromDisk();
      // Open + disk quote → Float UPL must mark cached (not live MTM)
      const prevPositions = masterRuntime.positions;
      const { PositionManager } = await import('../positionManager.js');
      masterRuntime.positions = new PositionManager();
      masterRuntime.positions.register({
        position_id: 'cache-float-1',
        opportunity_id: 'cache-opp-1',
        intent_id: 'cache-intent-1',
        epic: 'GOLD',
        side: 'BUY',
        size: 0.1,
        entry: 4410,
        stop_loss: 4390,
        take_profit: 4450,
        decision: {
          decision_id: 'cache-d',
          kind: 'BUY',
          side: 'BUY',
          score: 0.8,
          block_reason: null,
          buy: { score: 0.8 } as never,
          sell: { score: 0.2 } as never,
          analysis: {
            regime: 'TREND_UP',
            market_state: 'test',
          } as never,
          expectancy: null,
        },
      });
      const st = masterRuntime.status();
      expect(st.bars_available).toBeGreaterThanOrEqual(40);
      expect(st.bars_cached).toBe(true);
      expect(st.quote?.cached).toBe(true);
      expect(st.quote?.source).toBe('disk_cache');
      expect(st.floating_pnl).not.toBeNull();
      expect(st.floating_pnl_cached).toBe(true);
      // Live tick clears provenance
      await masterRuntime.tick(bars, {
        bid: 4416,
        ask: 4416.4,
        mid: 4416.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      });
      const live = masterRuntime.status();
      expect(live.quote?.cached).toBe(false);
      expect(live.quote?.source).toBe('live');
      expect(live.bars_cached).toBe(false);
      expect(live.floating_pnl_cached).toBe(false);
      masterRuntime.positions = prevPositions;
    } finally {
      masterRuntime.last_quote = prevQuote;
      masterRuntime.last_bars = prevBars;
      masterRuntime.last_market = prevMarket;
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
      if (prevGates === undefined) delete process.env.MASTER_GATES_DIR;
      else process.env.MASTER_GATES_DIR = prevGates;
    }
  });
});
