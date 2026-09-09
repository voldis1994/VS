import { describe, expect, it } from 'vitest';
import { analyzeBars } from '../analysis.js';
import {
  capitalLiveEntriesAllowed,
  closed10sFromJustClosed,
  isMeaningfulBar,
  LiveBarBuilder,
} from '../liveFeed.js';
import { PaperBroker } from '../broker.js';
import { DEFAULT_MASTER_CONFIG, GOLD_SPEC, MasterPipeline } from '../pipeline.js';
import { PositionManager } from '../positionManager.js';

describe('VS MASTER live bar builder', () => {
  it('seeds history and closes bars on interval', () => {
    const b = new LiveBarBuilder(1000, 20);
    b.seedAround(4400, 10);
    expect(b.seed_source).toBe('synthetic_fallback');
    expect(b.structureCount()).toBe(10);
    const t0 = 1_000_000;
    const a = b.pushTick(4401, t0);
    expect(a.justClosed).toBeNull();
    const c = b.pushTick(4402, t0 + 1001);
    expect(c.justClosed).not.toBeNull();
    expect(c.bars.length).toBeGreaterThan(10);
  });

  it('closed10sFromJustClosed maps justClosed Bar → TenSecBar', () => {
    const b = new LiveBarBuilder(1000, 20);
    b.seedAround(4400, 10);
    const t0 = 2_000_000;
    expect(closed10sFromJustClosed(b.pushTick(4401, t0).justClosed)).toBeNull();
    const closed = b.pushTick(4408, t0 + 1001).justClosed;
    expect(closed).not.toBeNull();
    const ten = closed10sFromJustClosed(closed);
    expect(ten).toEqual({
      open_time_ms: t0,
      open: 4401,
      high: 4408,
      low: 4401,
      close: 4408,
      ticks: 1,
    });
    // Flat close still maps (armed confirm honesty) — not null
    const flat = closed10sFromJustClosed({
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      ts_ms: 99,
    });
    expect(flat?.open_time_ms).toBe(99);
    expect(closed10sFromJustClosed(null)).toBeNull();
  });

  it('refreshHourBarsCache prefers broker HOUR and caches until everyMs', async () => {
    const {
      emptyHourBarsCache,
      refreshHourBarsCache,
    } = await import('../liveFeed.js');
    const hourBars = Array.from({ length: 8 }, (_, i) => {
      const o = 4300 + i * 10;
      return { open: o, high: o + 5, low: o - 2, close: o + 4, ts_ms: i * 3_600_000 };
    });
    let calls = 0;
    const first = await refreshHourBarsCache({
      epic: 'GOLD',
      cache: emptyHourBarsCache(),
      everyMs: 60_000,
      brokerGetHourBars: async () => {
        calls += 1;
        return { ok: true, bars: hourBars, detail: 'capital_hour_8' };
      },
    });
    expect(first.bars).toHaveLength(8);
    expect(first.detail).toBe('capital_hour_8');
    expect(calls).toBe(1);
    const cached = await refreshHourBarsCache({
      epic: 'GOLD',
      cache: first,
      everyMs: 60_000,
      brokerGetHourBars: async () => {
        calls += 1;
        return { ok: true, bars: hourBars, detail: 'again' };
      },
    });
    expect(calls).toBe(1);
    expect(cached.detail).toBe('capital_hour_8');
  });

  it('seedBars marks yahoo_ohlc source', () => {
    const b = new LiveBarBuilder(1000, 20);
    b.seedBars([
      { open: 1, high: 2, low: 0.5, close: 1.5, ts_ms: 1 },
      { open: 1.5, high: 2.5, low: 1, close: 2, ts_ms: 2 },
    ]);
    expect(b.seed_source).toBe('yahoo_ohlc');
    expect(b.structureCount()).toBe(2);
  });

  it('does not let flat tick closes erase Yahoo structure ATR', () => {
    const b = new LiveBarBuilder(1000, 20);
    const structure = Array.from({ length: 20 }, (_, i) => {
      const o = 4400 + i * 0.8;
      return { open: o, high: o + 1.2, low: o - 0.3, close: o + 0.7, ts_ms: i * 60_000 };
    });
    b.seedBars(structure);
    const before = analyzeBars(b.getAnalysisBars(), 0.4);
    expect(before.atr).toBeGreaterThan(0.5);

    // Many flat mid polls at same price — must not wipe structure
    let t = 2_000_000;
    for (let i = 0; i < 30; i++) {
      b.pushTick(4415, t);
      t += 1001;
    }
    expect(b.structureCount()).toBe(20);
    const after = analyzeBars(b.getAnalysisBars(), 0.4);
    expect(after.atr).toBeGreaterThan(0.5);
    expect(after.buy_pressure).toBeGreaterThan(0);
    expect(isMeaningfulBar({ open: 1, high: 1, low: 1, close: 1 })).toBe(false);
  });

  it('seedFromBrokerOrPublic prefers Capital OHLC over Yahoo', async () => {
    const b = new LiveBarBuilder(1000, 40);
    const capitalBars = Array.from({ length: 20 }, (_, i) => {
      const o = 4400 + i;
      return { open: o, high: o + 1, low: o - 0.5, close: o + 0.5, ts_ms: i * 60_000 };
    });
    const detail = await b.seedFromBrokerOrPublic('GOLD', 4420, 40, {
      ok: true,
      bars: capitalBars,
      detail: 'capital_minute_20',
    });
    expect(detail).toBe('capital_minute_20');
    expect(b.seed_source).toBe('capital_ohlc');
    expect(b.structureCount()).toBe(20);
  });

  it('seedFromBrokerOrPublic labels MT4 bars_m1 as mt4_ohlc (not capital)', async () => {
    const b = new LiveBarBuilder(1000, 40);
    const mt4Bars = Array.from({ length: 15 }, (_, i) => {
      const o = 4400 + i;
      return { open: o, high: o + 1, low: o - 0.5, close: o + 0.5, ts_ms: i * 60_000 };
    });
    const detail = await b.seedFromBrokerOrPublic('GOLD', 4420, 40, {
      ok: true,
      bars: mt4Bars,
      detail: 'mt4_bars_m1_15',
    });
    expect(detail).toBe('mt4_bars_m1_15');
    expect(b.seed_source).toBe('mt4_ohlc');
  });

  it('capitalLiveEntriesAllowed requires capital_ohlc (synthetic only when opted in)', () => {
    expect(capitalLiveEntriesAllowed('capital_ohlc')).toBe(true);
    expect(capitalLiveEntriesAllowed('yahoo_ohlc')).toBe(false);
    expect(capitalLiveEntriesAllowed('synthetic_fallback')).toBe(false);
    expect(capitalLiveEntriesAllowed('mt4_ohlc')).toBe(false);
    expect(capitalLiveEntriesAllowed('synthetic_fallback', { allowSynthetic: true })).toBe(true);
  });

  it('ATR ignores micro TRs mixed into structure (10s onto 5m)', () => {
    const structure = Array.from({ length: 20 }, (_, i) => {
      const o = 4400 + i;
      return { open: o, high: o + 2, low: o - 2, close: o + 1, ts_ms: i * 300_000 };
    });
    const poisoned = [
      ...structure,
      { open: 4420, high: 4420.02, low: 4419.98, close: 4420, ts_ms: 20 * 300_000 },
      { open: 4420, high: 4420.01, low: 4419.99, close: 4420, ts_ms: 20 * 300_000 + 10_000 },
    ];
    const clean = analyzeBars(structure, 0.4);
    const dirty = analyzeBars(poisoned, 0.4);
    // Micro bars must not collapse ATR toward zero
    expect(dirty.atr).toBeGreaterThan(clean.atr * 0.7);
    expect(dirty.atr).toBeGreaterThan(1);
  });
});

describe('MASTER TIME_STOP + breakeven', () => {
  it('force-closes when max_hold_ms exceeded', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry + 0.2,
      ask: entry + 0.6,
      mid: entry + 0.4,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'timestop-aaaaaaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 2,
      profit_level: entry + 4,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-ts',
      intent_id: 'ts-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry,
      stop_loss: entry - 2,
      take_profit: entry + 4,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: {
          regime: 'TREND',
          market_state: 't',
          momentum_score: 0.5,
          momentum_dir: 'UP',
          trend_dir: 'UP',
          trend_strength: 0.5,
          structure_bias: 'BULLISH',
          swing_high: entry + 5,
          swing_low: entry - 5,
          buy_pressure: 0.6,
          sell_pressure: 0.4,
          behavior_bull: 0.5,
          behavior_bear: 0.5,
          impact_score: 0.5,
          context_quality: 0.8,
          volatility: 0.001,
          atr: 1,
          data_quality: 0.9,
          session: 'LONDON',
        },
        expectancy: null,
      },
    });
    // Backdate entry
    const pos = pm.get(placed.position_id!)!;
    pos.entry_at = new Date(Date.now() - 60_000).toISOString();

    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry + 0.2,
        ask: entry + 0.6,
        mid: entry + 0.4,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      max_hold_ms: 30_000,
    });
    expect(managed.closed.length).toBe(1);
    expect(managed.closed[0]!.reason).toMatch(/TIME_STOP/);
  });

  it('moves SL to breakeven once TP progress clears threshold', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    const tp = entry + 1.0; // tight TP so 0.6 fav = 60% progress without clearing trail MFE floor
    broker.setQuote({
      bid: entry + 0.55,
      ask: entry + 0.65,
      mid: entry + 0.6,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'breakeven-bbbbbbbbbbbbbbbb',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 2,
      profit_level: tp,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-be',
      intent_id: 'be-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry,
      stop_loss: entry - 2,
      take_profit: tp,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: {
          regime: 'TREND',
          market_state: 't',
          momentum_score: 0.5,
          momentum_dir: 'UP',
          trend_dir: 'UP',
          trend_strength: 0.5,
          structure_bias: 'BULLISH',
          swing_high: entry + 5,
          swing_low: entry - 5,
          buy_pressure: 0.6,
          sell_pressure: 0.4,
          behavior_bull: 0.5,
          behavior_bear: 0.5,
          impact_score: 0.5,
          context_quality: 0.8,
          volatility: 0.001,
          atr: 1,
          data_quality: 0.9,
          session: 'LONDON',
        },
        expectancy: null,
      },
    });

    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry + 0.55,
        ask: entry + 0.65,
        mid: entry + 0.6,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: GOLD_SPEC.value_per_point_per_lot,
      breakeven_progress: 0.5,
      max_hold_ms: 0,
    });
    expect(managed.closed.length).toBe(0);
    expect(pm.get(placed.position_id!)!.stop_loss).toBe(entry);
    const opens = await broker.listOpenPositions('GOLD');
    expect(opens.positions[0]!.stop_level).toBe(entry);
  });

  it('Check- breakeven_offset locks BUY SL past entry', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    const tp = entry + 1.0;
    const offset = 0.2;
    broker.setQuote({
      bid: entry + 0.55,
      ask: entry + 0.65,
      mid: entry + 0.6,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'breakeven-offset-bbbbbbbbbb',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 2,
      profit_level: tp,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-be-off',
      intent_id: 'be-off-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry,
      stop_loss: entry - 2,
      take_profit: tp,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: {
          regime: 'TREND',
          market_state: 't',
          momentum_score: 0.5,
          momentum_dir: 'UP',
          trend_dir: 'UP',
          trend_strength: 0.5,
          structure_bias: 'BULLISH',
          swing_high: entry + 5,
          swing_low: entry - 5,
          buy_pressure: 0.6,
          sell_pressure: 0.4,
          behavior_bull: 0.5,
          behavior_bear: 0.5,
          impact_score: 0.5,
          context_quality: 0.8,
          volatility: 0.001,
          atr: 1,
          data_quality: 0.9,
          session: 'LONDON',
        },
        expectancy: null,
      },
    });

    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry + 0.55,
        ask: entry + 0.65,
        mid: entry + 0.6,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: GOLD_SPEC.value_per_point_per_lot,
      breakeven_progress: 0.5,
      breakeven_offset: offset,
      max_hold_ms: 0,
    });
    expect(managed.closed.length).toBe(0);
    expect(pm.get(placed.position_id!)!.stop_loss).toBe(entry + offset);
  });

  it('structure swing trail raises BUY SL to swing_low - buffer', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry + 3,
      ask: entry + 3.4,
      mid: entry + 3.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'swing-trail-aaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 5,
      profit_level: entry + 10,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-swing',
      intent_id: 'swing-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry,
      stop_loss: entry - 5,
      take_profit: entry + 10,
      decision: {
        decision_id: 'd-swing',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: {
          regime: 'TREND',
          market_state: 't',
          momentum_score: 0.5,
          momentum_dir: 'UP',
          trend_dir: 'UP',
          trend_strength: 0.5,
          structure_bias: 'BULLISH',
          swing_high: entry + 8,
          swing_low: entry + 1,
          buy_pressure: 0.6,
          sell_pressure: 0.4,
          behavior_bull: 0.5,
          behavior_bear: 0.5,
          impact_score: 0.5,
          context_quality: 0.8,
          volatility: 0.001,
          atr: 1,
          data_quality: 0.9,
          session: 'LONDON',
        },
        expectancy: null,
      },
    });
    // Seed MFE so manage path runs trail (structure alone is enough now)
    const pos = pm.get(placed.position_id!)!;
    pos.mfe = 0; // no MFE ratchet — structure only
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry + 3,
        ask: entry + 3.4,
        mid: entry + 3.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: GOLD_SPEC.value_per_point_per_lot,
      breakeven_progress: 0.99,
      max_hold_ms: 0,
      swing_low: entry + 1,
      swing_high: entry + 8,
      trailing_buffer: 0.2,
    });
    expect(managed.closed.length).toBe(0);
    expect(pm.get(placed.position_id!)!.stop_loss).toBeCloseTo(entry + 1 - 0.2, 8);
    const opens = await broker.listOpenPositions('GOLD');
    expect(opens.positions[0]!.stop_level).toBeCloseTo(entry + 0.8, 8);
  });
});

describe('analysis flat pressure', () => {
  it('uses neutral 0.5 pressure on zero-body window', () => {
    const flat = Array.from({ length: 20 }, (_, i) => ({
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      ts_ms: i * 1000,
    }));
    const a = analyzeBars(flat, 0.1);
    expect(a.buy_pressure).toBe(0.5);
    expect(a.sell_pressure).toBe(0.5);
  });
});

describe('emaTickLiveFromBars (VS-System Close[0])', () => {
  it('replaces forming tip close with live mid and keeps prev on closed bars', async () => {
    const { closesWithLiveClose0, emaTickLiveFromBars, isFormingBar } =
      await import('../analysis.js');
    const now = Date.now();
    const bars = [
      { open: 100, high: 101, low: 99, close: 100, ts_ms: now - 30_000 },
      { open: 100, high: 102, low: 99.5, close: 101, ts_ms: now - 20_000 },
      { open: 101, high: 103, low: 100.5, close: 102, ts_ms: now - 10_000 },
      { open: 102, high: 102.5, low: 101.8, close: 102.2, ts_ms: now - 2_000 }, // forming
    ];
    expect(isFormingBar(bars[3], now, 10_000)).toBe(true);
    const series = closesWithLiveClose0(bars, 105, now, 10_000);
    expect(series.at(-1)).toBe(105);
    expect(series).toHaveLength(4);
    const live = emaTickLiveFromBars(bars, 105, now, 10_000)!;
    expect(live.ema1).toBe(105);
    expect(live.ema3).not.toBeNull();
    expect(live.ema1Prev).toBe(102); // last closed close
    expect(live.ema3Prev).not.toBeNull();
  });

  it('appends Close[0] when last bar is already closed', async () => {
    const { closesWithLiveClose0 } = await import('../analysis.js');
    const now = Date.now();
    const bars = [
      { open: 100, high: 101, low: 99, close: 100, ts_ms: now - 40_000 },
      { open: 100, high: 102, low: 99.5, close: 101, ts_ms: now - 30_000 },
      { open: 101, high: 103, low: 100.5, close: 102, ts_ms: now - 20_000 },
    ];
    const series = closesWithLiveClose0(bars, 108, now, 10_000);
    expect(series).toEqual([100, 101, 102, 108]);
  });
});
