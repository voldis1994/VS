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
    const hourBars = Array.from({ length: 8 }, (_, i) => ({
      open: 4300 + i * 10,
      high: 4310 + i * 10,
      low: 4290 + i * 10,
      close: 4305 + i * 10,
      ts_ms: Date.now() - (8 - i) * 3_600_000,
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
        hour_bars: hourBars,
        hour_bars_detail: 'capital_hour',
        closed_10s: {
          open_time_ms: Date.now() - 10_000,
          open: 4409,
          high: 4411,
          low: 4408,
          close: 4410.2,
          ticks: 3,
        },
        structure_seed_source: 'capital_ohlc',
      },
      dir
    );
    expect(ok).toBe(true);
    expect(existsSync(join(dir, 'market_cache.json'))).toBe(true);
    const loaded = loadMarketCache(dir);
    expect(loaded?.bars.length).toBe(10);
    expect(loaded?.hour_bars?.length).toBe(8);
    expect(loaded?.hour_bars_detail).toBe('capital_hour');
    expect(loaded?.closed_10s?.close).toBeCloseTo(4410.2, 5);
    expect(loaded?.closed_10s?.ticks).toBe(3);
    expect(loaded?.epic).toBe('GOLD');
    expect(loaded?.structure_seed_source).toBe('capital_ohlc');
    expect(loaded?.quote?.mid).toBeCloseTo(4410.2, 5);
  });

  it('persists hour_bars alone when minute bars and quote are empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'master-mkt-hours-only-'));
    const hourBars = Array.from({ length: 6 }, (_, i) => ({
      open: 4400 + i,
      high: 4402 + i,
      low: 4398 + i,
      close: 4401 + i,
      ts_ms: Date.now() - (6 - i) * 3_600_000,
    }));
    expect(
      saveMarketCache(
        {
          epic: 'GOLD',
          bars: [],
          quote: null,
          hour_bars: hourBars,
          hour_bars_detail: 'hours_only',
        },
        dir
      )
    ).toBe(true);
    const loaded = loadMarketCache(dir);
    expect(loaded?.bars.length).toBe(0);
    expect(loaded?.hour_bars?.length).toBe(6);
    expect(loaded?.hour_bars_detail).toBe('hours_only');
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
      const hourBars = Array.from({ length: 12 }, (_, i) => {
        const o = 4300 + i * 5;
        return {
          open: o,
          high: o + 8,
          low: o - 3,
          close: o + 4,
          ts_ms: Date.now() - (12 - i) * 3_600_000,
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
            hour_bars: hourBars,
            hour_bars_detail: 'disk_hour_cache',
            closed_10s: {
              open_time_ms: Date.now() - 10_000,
              open: 4414,
              high: 4416,
              low: 4413,
              close: 4415.2,
              ticks: 4,
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
          last_hour_bars: unknown[];
          last_closed_10s: unknown;
          hourBarsFromDiskCache: boolean;
          closed10sFromDiskCache: boolean;
        }
      ).last_hour_bars = [];
      (
        masterRuntime as unknown as { last_closed_10s: unknown }
      ).last_closed_10s = null;
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
        masterRuntime as unknown as { hourBarsFromDiskCache: boolean }
      ).hourBarsFromDiskCache = false;
      (
        masterRuntime as unknown as { closed10sFromDiskCache: boolean }
      ).closed10sFromDiskCache = false;
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
      expect(st.hour_bars_available).toBeGreaterThanOrEqual(6);
      expect(st.hour_bars_cached).toBe(true);
      expect(st.hour_bars_source).toBe('disk_cache');
      expect(st.closed_10s_present).toBe(true);
      expect(st.closed_10s_cached).toBe(true);
      expect(st.closed_10s_source).toBe('disk_cache');
      expect(st.quote?.cached).toBe(true);
      expect(st.quote?.source).toBe('disk_cache');
      expect(st.floating_pnl).not.toBeNull();
      expect(st.floating_pnl_cached).toBe(true);
      expect(st.pipeline_stages.market_validation.ok).toBe(false);
      expect(st.pipeline_stages.market_validation.detail).toMatch(
        /^hydrated · disk_cache · Q=/
      );
      expect(st.pipeline_stages.normalization.ok).toBe(false);
      expect(st.pipeline_stages.normalization.detail).toMatch(
        /^hydrated · disk_cache · /
      );
      // Live tick clears provenance (incl. hour bars when opts supply live HOUR)
      const liveHours = Array.from({ length: 8 }, (_, i) => {
        const o = 4400 + i;
        return {
          open: o,
          high: o + 2,
          low: o - 1,
          close: o + 1,
          ts_ms: Date.now() - (8 - i) * 3_600_000,
        };
      });
      await masterRuntime.tick(bars, {
        bid: 4416,
        ask: 4416.4,
        mid: 4416.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      }, { hour_bars: liveHours });
      const live = masterRuntime.status();
      expect(live.quote?.cached).toBe(false);
      expect(live.quote?.source).toBe('live');
      expect(live.bars_cached).toBe(false);
      expect(live.hour_bars_cached).toBe(false);
      expect(live.hour_bars_source).toBe('live');
      expect(live.hour_bars_available).toBeGreaterThanOrEqual(6);
      // Sticky reuse of same disk closed_10s bucket keeps disk_cache until new 10s
      expect(live.closed_10s_cached).toBe(true);
      expect(live.closed_10s_source).toBe('disk_cache');
      const live10s = {
        open_time_ms: Date.now() - 5_000,
        open: 4415,
        high: 4417,
        low: 4414,
        close: 4416,
        ticks: 2,
      };
      await masterRuntime.tick(
        bars,
        {
          bid: 4416,
          ask: 4416.4,
          mid: 4416.2,
          spread: 0.4,
          epic: 'GOLD',
          ts_ms: Date.now(),
        },
        { hour_bars: liveHours, closed_10s: live10s }
      );
      const live2 = masterRuntime.status();
      expect(live2.closed_10s_cached).toBe(false);
      expect(live2.closed_10s_source).toBe('live');
      expect(live2.closed_10s_present).toBe(true);
      expect(live.floating_pnl_cached).toBe(false);
      expect(live.pipeline_stages.market_validation.detail).not.toMatch(
        /hydrated · disk_cache/
      );
      expect(live.pipeline_stages.normalization.detail).not.toMatch(
        /hydrated · disk_cache/
      );
      masterRuntime.positions = prevPositions;
    } finally {
      masterRuntime.last_quote = prevQuote;
      masterRuntime.last_bars = prevBars;
      masterRuntime.last_market = prevMarket;
      (
        masterRuntime as unknown as { last_hour_bars: unknown[] }
      ).last_hour_bars = [];
      (
        masterRuntime as unknown as { hourBarsFromDiskCache: boolean }
      ).hourBarsFromDiskCache = false;
      (
        masterRuntime as unknown as { last_closed_10s: unknown }
      ).last_closed_10s = null;
      (
        masterRuntime as unknown as { closed10sFromDiskCache: boolean }
      ).closed10sFromDiskCache = false;
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
      if (prevGates === undefined) delete process.env.MASTER_GATES_DIR;
      else process.env.MASTER_GATES_DIR = prevGates;
    }
  });

  it('tick without opts uses disk hour_bars + closed_10s for desk confirm', async () => {
    const { masterRuntime } = await import('../runtime.js');
    const dir = mkdtempSync(join(tmpdir(), 'master-mkt-sticky-'));
    const prevState = process.env.MASTER_STATE_DIR;
    const prevGates = process.env.MASTER_GATES_DIR;
    process.env.MASTER_STATE_DIR = dir;
    process.env.MASTER_GATES_DIR = dir;
    const prevQuote = masterRuntime.last_quote;
    const prevBars = masterRuntime.last_bars;
    const prevMarket = masterRuntime.last_market;
    const prevCfg = masterRuntime.cfg;
    try {
      masterRuntime.cfg = {
        ...masterRuntime.cfg,
        min_score: 0.25,
        require_armed_setup: false,
        block_off_hours: false,
        block_high_impact_news: false,
      };
      const bars = Array.from({ length: 50 }, (_, i) => {
        const o = 4400 + i * 0.8;
        return {
          open: o,
          high: o + 1.2,
          low: o - 0.1,
          close: o + 0.9,
          ts_ms: Date.now() - (50 - i) * 60_000,
        };
      });
      const hourBars = [
        { open: 4300, high: 4350, low: 4290, close: 4340, ts_ms: 1 },
        { open: 4340, high: 4380, low: 4330, close: 4370, ts_ms: 2 },
        { open: 4370, high: 4410, low: 4365, close: 4405, ts_ms: 3 },
        { open: 4405, high: 4430, low: 4400, close: 4420, ts_ms: 4 },
        { open: 4420, high: 4440, low: 4415, close: 4435, ts_ms: 5 },
        { open: 4435, high: 4450, low: 4430, close: 4445, ts_ms: 6 },
      ];
      const last = bars.at(-1)!;
      expect(
        saveMarketCache(
          {
            epic: 'GOLD',
            bars,
            quote: {
              bid: last.close - 0.2,
              ask: last.close + 0.2,
              mid: last.close,
              spread: 0.4,
              epic: 'GOLD',
              ts_ms: Date.now(),
            },
            hour_bars: hourBars,
            hour_bars_detail: 'sticky_test',
            closed_10s: {
              open_time_ms: Date.now() - 10_000,
              open: last.close - 0.2,
              high: last.close + 1.5,
              low: last.close - 0.3,
              close: last.close + 1.2,
              ticks: 4,
            },
            structure_seed_source: 'sticky_test',
          },
          dir
        )
      ).toBe(true);
      masterRuntime.last_quote = null;
      masterRuntime.last_bars = [];
      masterRuntime.last_market = null;
      (
        masterRuntime as unknown as { last_hour_bars: unknown[] }
      ).last_hour_bars = [];
      (
        masterRuntime as unknown as { last_closed_10s: unknown }
      ).last_closed_10s = null;
      (
        masterRuntime as unknown as {
          hydrateMarketCacheFromDisk: () => void;
        }
      ).hydrateMarketCacheFromDisk();
      masterRuntime.ensurePaperBroker();
      masterRuntime.setMode('PAPER');
      // No opts — must sticky-fall back to disk arms for hour_bias + desk confirm
      await masterRuntime.tick(bars, {
        bid: last.close - 0.2,
        ask: last.close + 0.2,
        mid: last.close,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      });
      const st = masterRuntime.status();
      expect(st.hour_bias).toBe('UP');
      expect(st.hour_bars_source).toBe('disk_cache');
      expect(st.closed_10s_present).toBe(true);
      expect(st.closed_10s_source).toBe('disk_cache');
      expect(st.desk_entry?.source === 'setup' || st.desk_entry?.source === 'move').toBe(
        true
      );
    } finally {
      masterRuntime.last_quote = prevQuote;
      masterRuntime.last_bars = prevBars;
      masterRuntime.last_market = prevMarket;
      masterRuntime.cfg = prevCfg;
      (
        masterRuntime as unknown as { last_hour_bars: unknown[] }
      ).last_hour_bars = [];
      (
        masterRuntime as unknown as { last_closed_10s: unknown }
      ).last_closed_10s = null;
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
      if (prevGates === undefined) delete process.env.MASTER_GATES_DIR;
      else process.env.MASTER_GATES_DIR = prevGates;
    }
  });

  it('aged disk_cache quote stays hydrated · disk_cache — not live stale_quote', async () => {
    const { masterRuntime } = await import('../runtime.js');
    const dir = mkdtempSync(join(tmpdir(), 'master-mkt-aged-'));
    const prevState = process.env.MASTER_STATE_DIR;
    const prevGates = process.env.MASTER_GATES_DIR;
    process.env.MASTER_STATE_DIR = dir;
    process.env.MASTER_GATES_DIR = dir;
    const prevQuote = masterRuntime.last_quote;
    const prevBars = masterRuntime.last_bars;
    const prevMarket = masterRuntime.last_market;
    const prevCfg = masterRuntime.cfg;
    try {
      masterRuntime.cfg = { ...masterRuntime.cfg, stale_quote_ms: 5_000 };
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
              ts_ms: Date.now() - 60_000,
            },
            structure_seed_source: 'aged_cache',
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
        }
      ).quoteFromDiskCache = false;
      (
        masterRuntime as unknown as { barsFromDiskCache: boolean }
      ).barsFromDiskCache = false;
      (
        masterRuntime as unknown as {
          hydrateMarketCacheFromDisk: () => void;
        }
      ).hydrateMarketCacheFromDisk();
      const st = masterRuntime.status();
      expect(st.quote?.cached).toBe(true);
      expect(st.quote?.stale).toBe(false);
      expect(st.pipeline_stages.market_validation.ok).toBe(false);
      expect(st.pipeline_stages.market_validation.detail).toMatch(
        /^hydrated · disk_cache/
      );
      expect(st.pipeline_stages.market_validation.detail).not.toMatch(
        /stale_quote · age=/
      );
      expect(st.pipeline_stages.normalization.detail).toMatch(
        /^hydrated · disk_cache/
      );
      // Sticky last_market + live (non-cache) aged quote still paints stale_quote
      masterRuntime.last_market = {
        ok: true,
        quality: 0.95,
        reasons: [],
        bars_in: 40,
        bars_out: 40,
      };
      (
        masterRuntime as unknown as { quoteFromDiskCache: boolean }
      ).quoteFromDiskCache = false;
      masterRuntime.last_quote = {
        bid: 4415,
        ask: 4415.4,
        mid: 4415.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now() - 60_000,
      };
      const liveStale = masterRuntime.status().pipeline_stages;
      expect(liveStale.market_validation.ok).toBe(false);
      expect(liveStale.market_validation.detail).toMatch(/stale_quote · age=/);
    } finally {
      masterRuntime.last_quote = prevQuote;
      masterRuntime.last_bars = prevBars;
      masterRuntime.last_market = prevMarket;
      masterRuntime.cfg = prevCfg;
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
      if (prevGates === undefined) delete process.env.MASTER_GATES_DIR;
      else process.env.MASTER_GATES_DIR = prevGates;
    }
  });
});
