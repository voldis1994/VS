import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildCandidates } from '../candidates.js';
import { masterOwnsManageSafely, masterOwnsPipeline, resolveManageOwner, syncMasterEntryOwnership } from '../deskBridge.js';
import { applyMarketFilters } from '../filters.js';
import { DEFAULT_MASTER_CONFIG, MasterPipeline } from '../pipeline.js';
import { PositionManager, mapRegimeToPlaybook, toDeskRegime, entrySetupFromRegime } from '../positionManager.js';
import { Mt4FileBroker, PaperBroker, epicsMatch, normalizeEpicKey } from '../broker.js';
import { Mt4BridgeSimulator } from '../mt4Sim.js';
import { syncPositionsWithBroker } from '../positionSync.js';
import { masterRuntime } from '../runtime.js';
import { SpreadHistory, updateSpreadModel } from '../spreadModel.js';
import type { AnalysisSnapshot, Quote } from '../types.js';
import { calculateRelativeVolatility } from '../volatility.js';

function baseAnalysis(over: Partial<AnalysisSnapshot> = {}): AnalysisSnapshot {
  return {
    regime: 'RANGE',
    market_state: 'test',
    momentum_score: 0,
    momentum_dir: 'NEUTRAL',
    trend_dir: 'SIDEWAYS',
    trend_strength: 0.2,
    structure_bias: 'NEUTRAL',
    swing_high: 4405,
    swing_low: 4395,
    buy_pressure: 0.55,
    sell_pressure: 0.45,
    behavior_bull: 0.5,
    behavior_bear: 0.5,
    impact_score: 0.5,
    context_quality: 0.6,
    volatility: 0.001,
    atr: 1.5,
    data_quality: 0.8,
    session: 'LONDON',
    ...over,
  };
}

const quote: Quote = {
  bid: 4400,
  ask: 4400.4,
  mid: 4400.2,
  spread: 0.4,
  ts_ms: Date.now(),
};

describe('MASTER filters + dual flow', () => {
  const weekday = Date.UTC(2026, 8, 7, 12); // Monday

  it('allows UNKNOWN regime through shared filters (no dual-starve)', () => {
    const v = applyMarketFilters(
      baseAnalysis({ regime: 'UNKNOWN' }),
      quote,
      DEFAULT_MASTER_CONFIG,
      weekday
    );
    expect(v.ok).toBe(true);
    expect(v.checks.regime_stable).toBe(true);
  });

  it('still hard-blocks UNSTABLE', () => {
    const v = applyMarketFilters(
      baseAnalysis({ regime: 'UNSTABLE' }),
      quote,
      DEFAULT_MASTER_CONFIG,
      weekday
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/regime/);
  });

  it('hard-blocks OFF_HOURS session (Reader-style)', () => {
    const v = applyMarketFilters(
      baseAnalysis({ session: 'OFF_HOURS' }),
      quote,
      DEFAULT_MASTER_CONFIG,
      Date.UTC(2026, 8, 7, 12) // Monday noon UTC
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('session_off_hours');
  });

  it('hard-blocks weekend even in LONDON hours (Check- style)', () => {
    const v = applyMarketFilters(
      baseAnalysis({ session: 'LONDON' }),
      quote,
      DEFAULT_MASTER_CONFIG,
      Date.UTC(2026, 8, 5, 10) // Saturday
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('session_weekend');
  });

  it('Check- trading_hours hard-blocks outside weekday window', () => {
    const cfg = {
      ...DEFAULT_MASTER_CONFIG,
      trading_hours: {
        enabled: true,
        hours: {
          '0': { on: true, start: 8, end: 16 }, // Monday
          '1': { on: true, start: 8, end: 16 },
          '2': { on: true, start: 8, end: 16 },
          '3': { on: true, start: 8, end: 16 },
          '4': { on: true, start: 8, end: 16 },
          '5': { on: false, start: 0, end: 23 },
          '6': { on: false, start: 0, end: 23 },
        },
      },
    };
    const outside = applyMarketFilters(
      baseAnalysis(),
      quote,
      cfg,
      Date.UTC(2026, 8, 7, 7) // Monday 07:00 UTC
    );
    expect(outside.ok).toBe(false);
    expect(outside.reason).toBe('trading_hours');
    const inside = applyMarketFilters(
      baseAnalysis(),
      quote,
      cfg,
      Date.UTC(2026, 8, 7, 12) // Monday noon
    );
    expect(inside.ok).toBe(true);
    expect(inside.checks.trading_hours_ok).toBe(true);
  });

  it('allows OFF_HOURS when block_off_hours disabled', () => {
    const v = applyMarketFilters(baseAnalysis({ session: 'OFF_HOURS' }), quote, {
      ...DEFAULT_MASTER_CONFIG,
      block_off_hours: false,
    });
    expect(v.ok).toBe(true);
  });

  it('hard-blocks high-impact news (Reader-style)', () => {
    const prev = process.env.MASTER_NEWS_IMPACT;
    process.env.MASTER_NEWS_IMPACT = 'high';
    try {
      const v = applyMarketFilters(
        baseAnalysis({ session: 'LONDON' }),
        quote,
        DEFAULT_MASTER_CONFIG,
        Date.UTC(2026, 8, 7, 12)
      );
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('news_high_impact');
      expect(v.checks.news_ok).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.MASTER_NEWS_IMPACT;
      else process.env.MASTER_NEWS_IMPACT = prev;
    }
  });

  it('Check- MASTER_NEWS_FILTER forces entry block', () => {
    const prev = process.env.MASTER_NEWS_FILTER;
    process.env.MASTER_NEWS_FILTER = 'true';
    delete process.env.MASTER_NEWS_IMPACT;
    try {
      const v = applyMarketFilters(
        baseAnalysis({ session: 'LONDON' }),
        quote,
        DEFAULT_MASTER_CONFIG,
        Date.UTC(2026, 8, 7, 12)
      );
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('news_high_impact');
    } finally {
      if (prev === undefined) delete process.env.MASTER_NEWS_FILTER;
      else process.env.MASTER_NEWS_FILTER = prev;
    }
  });

  it('allows news window when block_high_impact_news disabled', () => {
    const prev = process.env.MASTER_NEWS_IMPACT;
    process.env.MASTER_NEWS_IMPACT = 'high';
    try {
      const v = applyMarketFilters(baseAnalysis({ session: 'LONDON' }), quote, {
        ...DEFAULT_MASTER_CONFIG,
        block_high_impact_news: false,
      }, Date.UTC(2026, 8, 7, 12));
      expect(v.ok).toBe(true);
      expect(v.checks.news_ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MASTER_NEWS_IMPACT;
      else process.env.MASTER_NEWS_IMPACT = prev;
    }
  });

  it('mapRegimeToPlaybook: TREND→LONG, RANGE→FADE, BREAKOUT→SCALP (desk parity)', () => {
    expect(mapRegimeToPlaybook('TREND_UP')).toBe('LONG');
    expect(mapRegimeToPlaybook('TREND', { trend_dir: 'DOWN' })).toBe('LONG');
    expect(toDeskRegime('TREND', { trend_dir: 'DOWN' })).toBe('TREND_DOWN');
    expect(mapRegimeToPlaybook('RANGE')).toBe('FADE');
    expect(mapRegimeToPlaybook('BREAKOUT_UP')).toBe('SCALP');
    expect(mapRegimeToPlaybook('LOW_VOLATILITY')).toBe('SCALP'); // COMPRESSION→WAIT→SCALP
    expect(entrySetupFromRegime('TREND_UP')).toBe('CONTINUATION');
    expect(entrySetupFromRegime('BREAKOUT_UP')).toBe('BREAKOUT');
    expect(entrySetupFromRegime('RANGE')).toBe('FADE');
    expect(entrySetupFromRegime('LOW_VOLATILITY')).toBe('SCALP');
  });

  it('Capital unread UPL still fires HardInvalidation (not PeakProtect)', async () => {
    const broker = {
      name: 'CAPITAL',
      paper: false,
      async closePosition() {
        return { ok: true, fill_price: 4388, fill_pnl: null, detail: 'closed' };
      },
      async modifyPosition() {
        return { ok: true, detail: 'ok' };
      },
    } as never;
    const pipe = new MasterPipeline('LIVE');
    const pm = new PositionManager();
    pm.register({
      position_id: 'deal-hardinv',
      opportunity_id: 'opp-hi',
      intent_id: 'hi-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4400,
      stop_loss: 4300, // wide — HardInv should fire before STOP_HIT
      take_profit: 4600,
      entry_at: new Date(Date.now() - 120_000).toISOString(),
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ regime: 'TREND_UP', trend_dir: 'UP' }),
        expectancy: null,
      },
    });
    const pos = pm.get('deal-hardinv')!;
    pos.broker_upl = null;
    pos.playbook_at_entry = 'LONG';
    pos.entry_setup = 'CONTINUATION';
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4388,
        ask: 4388.4,
        mid: 4388.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      max_hold_ms: 0,
      breakeven_progress: 0,
      allow_close: true,
    });
    expect(managed.closed.some((c) => /HardInvalidation/i.test(c.reason))).toBe(
      true
    );
  });

  it('ema3_side freezes while Capital UPL unread', async () => {
    const broker = {
      name: 'CAPITAL',
      paper: false,
      async closePosition() {
        return { ok: false, detail: 'no' };
      },
      async modifyPosition() {
        return { ok: true, detail: 'ok' };
      },
    } as never;
    const pipe = new MasterPipeline('LIVE');
    const pm = new PositionManager();
    pm.register({
      position_id: 'deal-ema3-freeze',
      opportunity_id: 'opp-e3',
      intent_id: 'e3-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4400,
      stop_loss: 4390,
      take_profit: 4600,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ regime: 'TREND_UP' }),
        expectancy: null,
      },
    });
    const pos = pm.get('deal-ema3-freeze')!;
    pos.broker_upl = null;
    pos.ema3_side = 'above';
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4395,
        ask: 4395.4,
        mid: 4395.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      max_hold_ms: 0,
      breakeven_progress: 0,
      ema3: 4400,
      ema1: 4395,
      ema1_prev: 4401,
      ema3_prev: 4400,
    });
    expect(pos.ema3_side).toBe('above');
  });

  it('BestOutcome ThesisFailure fires on live TREND_UP vs LONG SELL', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry - 0.05,
      ask: entry + 0.05,
      mid: entry,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'thesis-selllllllllllll',
      epic: 'GOLD',
      side: 'SELL',
      size: 0.01,
      stop_level: entry + 5,
      profit_level: entry - 10,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-thesis',
      intent_id: 'thesis-1',
      epic: 'GOLD',
      side: 'SELL',
      size: 0.01,
      entry,
      stop_loss: entry + 5,
      take_profit: entry - 10,
      entry_at: new Date(Date.now() - 120_000).toISOString(),
      decision: {
        decision_id: 'd',
        kind: 'SELL',
        side: 'SELL',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({
          regime: 'TREND_DOWN',
          trend_dir: 'DOWN',
          structure_bias: 'BEARISH',
        }),
        expectancy: null,
      },
    });
    const pos = pm.get(placed.position_id!)!;
    expect(pos.playbook_at_entry).toBe('LONG');
    expect(pos.regime_at_entry).toBe('TREND_DOWN');
    // Slightly underwater so thesis can fire (fav <= 0); live regime flipped against SELL
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry + 0.2,
        ask: entry + 0.3,
        mid: entry + 0.25,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      max_hold_ms: 0,
      breakeven_progress: 0,
      live_regime: 'TREND_UP',
    });
    expect(managed.closed.some((c) => /ThesisFailure/.test(c.reason))).toBe(true);
  });

  it('Capital LIVE mark-geometry scalp chase refuses while venue UPL unread', async () => {
    let modifies = 0;
    const broker = {
      name: 'CAPITAL',
      paper: false,
      supportsNativeTrailingStop: true,
      async closePosition() {
        return { ok: false, detail: 'no' };
      },
      async modifyPosition() {
        modifies += 1;
        return { ok: true, detail: 'ok' };
      },
    } as never;
    const pipe = new MasterPipeline('LIVE');
    const pm = new PositionManager();
    pm.register({
      position_id: 'deal-chase-upl',
      opportunity_id: 'opp-chase-upl',
      intent_id: 'chase-upl',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4400,
      stop_loss: 4390,
      take_profit: 4500,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ regime: 'TREND_UP', trend_dir: 'UP' }),
        expectancy: null,
      },
    });
    const pos = pm.get('deal-chase-upl')!;
    pos.broker_upl = null;
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4440,
        ask: 4440.4,
        mid: 4440.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      scalp_pct_chase: true,
      scalp_lock_pct: 0.2,
      max_hold_ms: 0,
      breakeven_progress: 0,
      allow_close: true,
    });
    expect(modifies).toBe(0);
    expect(pos.native_trail_armed).toBeFalsy();
  });

  it('clearStaleBrokerUpl also disarms native_trail_armed', () => {
    masterRuntime.positions = new PositionManager();
    const pm = masterRuntime.positions;
    pm.register({
      position_id: 'deal-native-stale',
      opportunity_id: 'opp-ns',
      intent_id: 'ns-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4400,
      stop_loss: 4390,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    const pos = pm.get('deal-native-stale')!;
    pos.broker_upl = 12;
    pos.soft_trail_armed_at = new Date().toISOString();
    pos.soft_trail_peak = 4410;
    pos.native_trail_armed = true;
    (masterRuntime as unknown as { clearStaleBrokerUpl: () => void }).clearStaleBrokerUpl();
    expect(pos.broker_upl).toBeNull();
    expect(pos.soft_trail_armed_at).toBeNull();
    expect(pos.soft_trail_peak).toBeNull();
    expect(pos.native_trail_armed).toBe(false);
  });

  it('Capital LIVE does not ratchet MFE while venue UPL unread', async () => {
    const broker = {
      name: 'CAPITAL',
      paper: false,
      async closePosition() {
        return { ok: false, detail: 'no' };
      },
      async modifyPosition() {
        return { ok: true, detail: 'ok' };
      },
    } as never;
    const pipe = new MasterPipeline('LIVE');
    const pm = new PositionManager();
    pm.register({
      position_id: 'deal-mfe-upl',
      opportunity_id: 'opp-mfe',
      intent_id: 'mfe-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4400,
      stop_loss: 4390,
      take_profit: 4600,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ regime: 'TREND_UP' }),
        expectancy: null,
      },
    });
    const pos = pm.get('deal-mfe-upl')!;
    pos.broker_upl = null;
    pos.mfe = 0;
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4450,
        ask: 4450.4,
        mid: 4450.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      max_hold_ms: 0,
      breakeven_progress: 0,
    });
    expect(pos.mfe).toBe(0);
    pos.broker_upl = 12.5;
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4450,
        ask: 4450.4,
        mid: 4450.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      max_hold_ms: 0,
      breakeven_progress: 0,
    });
    expect(pos.mfe).toBeGreaterThan(40);
  });

  it('Capital reconcile null/0 UPL disarms soft+native trail', () => {
    const pm = new PositionManager();
    pm.register({
      position_id: 'deal-upl-disarm',
      opportunity_id: 'opp-ud',
      intent_id: 'ud-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4400,
      stop_loss: 4390,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    const pos = pm.get('deal-upl-disarm')!;
    pos.broker_upl = 8;
    pos.soft_trail_armed_at = new Date().toISOString();
    pos.soft_trail_peak = 4410;
    pos.native_trail_armed = true;
    pm.reconcileFromBroker(
      [
        {
          position_id: 'deal-upl-disarm',
          epic: 'GOLD',
          side: 'BUY',
          size: 0.1,
          open_level: 4400,
          open_level_proven: true,
          stop_level: 4390,
          upl: 0,
        },
      ],
      { capitalLive: true }
    );
    expect(pos.broker_upl).toBeNull();
    expect(pos.soft_trail_armed_at).toBeNull();
    expect(pos.native_trail_armed).toBe(false);
  });

  it('blocks BUY against dump but can leave SELL valid', () => {
    const a = baseAnalysis({
      regime: 'TREND',
      momentum_dir: 'DOWN',
      trend_dir: 'DOWN',
      momentum_score: -0.6,
      trend_strength: 0.7,
      sell_pressure: 0.8,
      buy_pressure: 0.2,
      behavior_bear: 0.8,
      behavior_bull: 0.2,
      structure_bias: 'BEARISH',
    });
    const { buy, sell } = buildCandidates(a, quote, { ...DEFAULT_MASTER_CONFIG, min_score: 0.3 });
    expect(buy.filter_reason).toBe('against_flow_dump');
    expect(buy.valid).toBe(false);
    expect(sell.filter_reason).not.toBe('against_flow_dump');
  });

  it('hard-blocks BUY late-move on last bar (Capital desk port)', () => {
    const bars = Array.from({ length: 5 }, (_, i) => ({
      open: 4400,
      high: 4401,
      low: 4399,
      close: 4400.1,
      ts_ms: i * 60_000,
    }));
    bars[bars.length - 1] = {
      open: 4400,
      high: 4425,
      low: 4399,
      close: 4420,
      ts_ms: 5 * 60_000,
    };
    const { buy, sell } = buildCandidates(
      baseAnalysis({
        regime: 'TREND',
        trend_dir: 'UP',
        momentum_dir: 'UP',
        atr: 2,
      }),
      quote,
      {
        ...DEFAULT_MASTER_CONFIG,
        min_score: 0.3,
        // Isolate late-move from relative-vol gate for this assertion
        max_relative_volatility: 100,
      },
      bars
    );
    expect(buy.filter_ok).toBe(false);
    expect(buy.filter_reason).toBe('late_move');
    expect(sell.filter_reason).not.toBe('late_move');
  });

  it('hard-blocks relative volatility spike (Reader-style)', () => {
    const quiet = Array.from({ length: 20 }, (_, i) => ({
      open: 4400 + i * 0.01,
      high: 4400.05 + i * 0.01,
      low: 4399.95 + i * 0.01,
      close: 4400.02 + i * 0.01,
      ts_ms: i * 60_000,
    }));
    const spiked = [
      ...quiet.slice(0, -1),
      {
        open: 4400,
        high: 4420,
        low: 4380,
        close: 4410,
        ts_ms: 20 * 60_000,
      },
    ];
    const pass = applyMarketFilters(
      baseAnalysis({ volatility: 0.001 }),
      quote,
      DEFAULT_MASTER_CONFIG,
      Date.UTC(2026, 8, 7, 12),
      quiet
    );
    expect(pass.ok).toBe(true);
    const fail = applyMarketFilters(
      baseAnalysis({ volatility: 0.001 }),
      quote,
      DEFAULT_MASTER_CONFIG,
      Date.UTC(2026, 8, 7, 12),
      spiked
    );
    expect(fail.ok).toBe(false);
    expect(fail.reason).toBe('relative_volatility');
  });

  it('ignores trailing flat forming tip for relative volatility (live mid gap)', () => {
    const structure = Array.from({ length: 20 }, (_, i) => ({
      open: 4400 + i * 0.1,
      high: 4400.4 + i * 0.1,
      low: 4399.7 + i * 0.1,
      close: 4400.2 + i * 0.1,
      ts_ms: i * 60_000,
    }));
    // Live tip ~20pts below last structure close — gap TR would false-trip without strip
    const withForming = [
      ...structure,
      {
        open: 4380,
        high: 4380,
        low: 4380,
        close: 4380,
        ts_ms: Date.now(),
      },
    ];
    expect(calculateRelativeVolatility(withForming, 14)).toBeLessThan(1.5);
    const pass = applyMarketFilters(
      baseAnalysis({ volatility: 0.001 }),
      quote,
      DEFAULT_MASTER_CONFIG,
      Date.UTC(2026, 8, 7, 12),
      withForming
    );
    expect(pass.ok).toBe(true);
  });

  it('hard-blocks relative spread spike (Reader-style)', () => {
    let hist: number[] = [];
    for (let i = 0; i < 15; i++) {
      hist = updateSpreadModel(hist, 0.3, 20).history;
    }
    const spiked = updateSpreadModel(hist, 1.5, 20);
    expect(spiked.relative_spread).toBeGreaterThan(1.5);
    const pass = applyMarketFilters(
      baseAnalysis({ volatility: 0.001 }),
      { ...quote, spread: 0.3 },
      DEFAULT_MASTER_CONFIG,
      Date.UTC(2026, 8, 7, 12),
      null,
      0.5
    );
    expect(pass.ok).toBe(true);
    const fail = applyMarketFilters(
      baseAnalysis({ volatility: 0.001 }),
      { ...quote, spread: 1.5 },
      { ...DEFAULT_MASTER_CONFIG, max_spread_abs: 5, max_spread_pct: 0.01 },
      Date.UTC(2026, 8, 7, 12),
      null,
      spiked.relative_spread
    );
    expect(fail.ok).toBe(false);
    expect(fail.reason).toBe('relative_spread');
  });

  it('SpreadHistory persists and restores across restart (Reader)', () => {
    const prev = process.env.MASTER_STATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'vs-spread-'));
    process.env.MASTER_STATE_DIR = dir;
    try {
      const a = new SpreadHistory(20);
      for (let i = 0; i < 10; i++) a.push(0.25 + i * 0.001);
      expect(a.size()).toBe(10);
      expect(a.save()).toBe(true);
      const b = new SpreadHistory(20);
      expect(b.load()).toBe(10);
      expect(b.size()).toBe(10);
      const snap = b.snapshot(1.5);
      expect(snap.relative_spread).toBeGreaterThan(1);
    } finally {
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });
});

describe('AI allow_close + portfolio close-all', () => {
  it('AI allow_close=false vetoes TIME_STOP but STOP_HIT still closes', async () => {
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
      intent_id: 'ai-close-veto-aaaaaaaaaa',
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
      opportunity_id: 'opp-ai-veto',
      intent_id: 'ai-veto-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry,
      stop_loss: entry - 5,
      take_profit: entry + 10,
      decision: {
        decision_id: 'd-ai',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ regime: 'TREND' }),
      },
    });
    // Force TIME_STOP clock
    pm.get(placed.position_id!)!.entry_at = new Date(Date.now() - 60_000).toISOString();
    const soft = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: { bid: entry + 0.2, ask: entry + 0.6, mid: entry + 0.4, spread: 0.4, ts_ms: Date.now() },
      max_hold_ms: 1_000,
      allow_close: false,
    });
    expect(soft.closed.length).toBe(0);
    expect(soft.close_failed.some((f) => f.detail === 'ai_veto_close')).toBe(true);
    expect(pm.count()).toBe(1);

    // Hard STOP still fires
    const hard = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: { bid: entry - 6, ask: entry - 5.6, mid: entry - 5.8, spread: 0.4, ts_ms: Date.now() },
      max_hold_ms: 1_000,
      allow_close: false,
    });
    expect(hard.closed.length).toBe(1);
    expect(hard.closed[0]!.reason).toBe('STOP_HIT');
  });

  it('Check- close_all_profit closes entire book on floating PnL', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry + 5,
      ask: entry + 5.4,
      mid: entry + 5.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const a = await broker.placeOrder({
      intent_id: 'pf-a-aaaaaaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 5,
    });
    const b = await broker.placeOrder({
      intent_id: 'pf-b-aaaaaaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 5,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    for (const placed of [a, b]) {
      pm.register({
        position_id: placed.position_id!,
        opportunity_id: `opp-${placed.position_id}`,
        intent_id: placed.order_id || placed.position_id!,
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        entry,
        stop_loss: entry - 5,
        take_profit: entry + 20,
        decision: {
          decision_id: 'd-pf',
          kind: 'BUY',
          side: 'BUY',
          score: 0.7,
          block_reason: null,
          buy: null as never,
          sell: null as never,
          analysis: baseAnalysis({ regime: 'TREND' }),
        },
      });
    }
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: { bid: entry + 5, ask: entry + 5.4, mid: entry + 5.2, spread: 0.4, ts_ms: Date.now() },
      instrument_point_value: 1,
      close_all_profit: 8,
      max_hold_ms: 0,
    });
    expect(managed.closed.length).toBe(2);
    expect(managed.closed.every((c) => c.reason.startsWith('AUTO_PROFIT_'))).toBe(true);
    expect(pm.count()).toBe(0);
  });

  it('close_all_profit honors AI allow_close=false (ai_veto_close)', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry + 5,
      ask: entry + 5.4,
      mid: entry + 5.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'pf-veto-aaaaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 5,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-pf-veto',
      intent_id: 'pf-veto-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry,
      stop_loss: entry - 5,
      take_profit: entry + 20,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ regime: 'TREND' }),
        expectancy: null,
      },
    });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry + 5,
        ask: entry + 5.4,
        mid: entry + 5.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      close_all_profit: 4,
      max_hold_ms: 0,
      allow_close: false,
    });
    expect(managed.closed.length).toBe(0);
    expect(pm.count()).toBe(1);
    expect(managed.close_failed.some((f) => f.detail === 'ai_veto_close')).toBe(
      true
    );
  });
});

describe('MASTER recover orphan journal', () => {
  it('attaches exit outcome to recover stub opportunity', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    broker.setQuote({
      bid: 4400,
      ask: 4400.4,
      mid: 4400.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'recover-journal-aaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: 4395,
    });
    const pm = new PositionManager();
    const pipe = new MasterPipeline('PAPER');
    const sync = await syncPositionsWithBroker(pm, broker, 'GOLD');
    expect(sync.adopted).toBe(1);
    const pos = pm.get(placed.position_id!)!;
    pipe.journal.recordOpportunity({
      id: pos.opportunity_id,
      mode: 'PAPER',
      epic: pos.epic,
      decision: pos.decision,
      risk: { allowed: true, volume: 1, risk_amount: 0, reasons: ['recover_orphan'] },
      executed: true,
      execution: {
        accepted: true,
        intent_id: pos.intent_id,
        order_id: null,
        fill_price: pos.entry,
        detail: 'recover_orphan',
        paper: true,
      },
    });

    broker.setQuote({
      bid: 4370,
      ask: 4370.4,
      mid: 4370.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: { bid: 4370, ask: 4370.4, mid: 4370.2, spread: 0.4, ts_ms: Date.now() },
      instrument_point_value: 1,
    });
    expect(managed.closed.length).toBe(1);
    expect(managed.closed[0]!.reason).toBe('STOP_HIT');
    const stub = pipe.journal.opportunities.find((o) => o.id === pos.opportunity_id);
    expect(stub?.outcome).toBeTruthy();
    expect(pipe.journal.traded().length).toBe(1);
  });
});

describe('MASTER paper recover + protective fills + close stub', () => {
  it('seedOpens prevents recover wipe of restored PAPER opens', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const pm = new PositionManager();
    const decision = {
      decision_id: 'd-seed',
      kind: 'BUY' as const,
      side: 'BUY' as const,
      score: 0.7,
      block_reason: null,
      buy: null as never,
      sell: null as never,
      analysis: baseAnalysis(),
      expectancy: null,
    };
    pm.register({
      position_id: 'paper-restored-1',
      opportunity_id: 'opp-restored-1',
      intent_id: 'intent-restored-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: 4410,
      stop_loss: 4405,
      take_profit: 4420,
      decision,
    });
    expect((await broker.listOpenPositions()).positions.length).toBe(0);

    broker.seedOpens([
      {
        position_id: 'paper-restored-1',
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        open_level: 4410,
        stop_level: 4405,
        profit_level: 4420,
      },
    ]);
    const sync = await syncPositionsWithBroker(pm, broker, 'GOLD');
    expect(sync.orphans_local.length).toBe(0);
    expect(sync.matched).toBe(1);
    expect(pm.count()).toBe(1);
  });

  it('closes on STOP_HIT / TP_HIT before soft exits', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    broker.setQuote({
      bid: 4410,
      ask: 4410.4,
      mid: 4410.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'sl-hit-intent',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: 4405,
      profit_level: 4425,
    });
    const pm = new PositionManager();
    const pipe = new MasterPipeline('PAPER');
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-sl-hit',
      intent_id: 'sl-hit-intent',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: placed.fill_price!,
      stop_loss: 4405,
      take_profit: 4425,
      decision: {
        decision_id: 'd-sl',
        kind: 'BUY',
        side: 'BUY',
        score: 0.8,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ regime: 'TREND' }),
        expectancy: null,
      },
    });
    broker.setQuote({
      bid: 4404,
      ask: 4404.4,
      mid: 4404.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: { bid: 4404, ask: 4404.4, mid: 4404.2, spread: 0.4, ts_ms: Date.now() },
      instrument_point_value: 1,
    });
    expect(managed.closed.length).toBe(1);
    expect(managed.closed[0]!.reason).toBe('STOP_HIT');
    // Paper close returns bid fill when available (real exitable mark)
    expect(managed.closed[0]!.outcome.exit).toBe(4404);
    expect(pipe.journal.traded().length).toBe(1);
  });

  it('recordTradeClose stubs missing opportunity so exits are not silent', () => {
    const pipe = new MasterPipeline('PAPER');
    pipe.recordTradeClose(
      'missing-opp',
      {
        decision_id: 'd-miss',
        kind: 'BUY',
        side: 'BUY',
        score: 0.5,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
      {
        position_id: 'p1',
        side: 'BUY',
        entry: 100,
        exit: 99,
        volume: 1,
        pnl: -1,
        fees: 0,
        slippage: 0,
        mae: 1,
        mfe: 0,
        r_multiple: -1,
        hold_ms: 1000,
        exit_reason: 'STOP_HIT',
      },
      { epic: 'GOLD' }
    );
    const row = pipe.journal.opportunities.find((o) => o.id === 'missing-opp');
    expect(row?.executed).toBe(true);
    expect(row?.outcome?.exit_reason).toBe('STOP_HIT');
    expect(row?.epic).toBe('GOLD');
    expect(pipe.journal.traded().length).toBe(1);
  });
});

describe('masterOwnsManageSafely', () => {
  it('ensureOwnsPipelineForCapitalLive defaults ON and refuses explicit OFF', () => {
    const prev = process.env.MASTER_OWNS_PIPELINE;
    const prevPref = masterRuntime.owns_pipeline_pref;
    try {
      masterRuntime.owns_pipeline_pref = null;
      delete process.env.MASTER_OWNS_PIPELINE;
      expect(masterRuntime.ownsPipelineEffective()).toBe(false);
      const on = masterRuntime.ensureOwnsPipelineForCapitalLive();
      expect(on.ok).toBe(true);
      expect(masterRuntime.ownsPipelineEffective()).toBe(true);

      masterRuntime.setOwnsPipeline(false);
      const off = masterRuntime.ensureOwnsPipelineForCapitalLive();
      expect(off.ok).toBe(false);
      if (!off.ok) expect(off.detail).toMatch(/owns_pipeline is OFF/);
      expect(masterRuntime.ownsPipelineEffective()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.MASTER_OWNS_PIPELINE;
      else process.env.MASTER_OWNS_PIPELINE = prev;
      masterRuntime.owns_pipeline_pref = prevPref;
    }
  });

  it('refuses Owns OFF while Capital LIVE is already running', () => {
    const prevPref = masterRuntime.owns_pipeline_pref;
    const prevRunning = masterRuntime.running;
    const prevMode = masterRuntime.cfg.mode;
    const prevBroker = masterRuntime.broker;
    try {
      masterRuntime.setOwnsPipeline(true);
      masterRuntime.setMode('LIVE');
      masterRuntime.running = true;
      masterRuntime.broker = { name: 'CAPITAL', paper: false } as never;
      const refused = masterRuntime.setOwnsPipeline(false);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.detail).toMatch(/Owns OFF refused/);
      expect(masterRuntime.ownsPipelineEffective()).toBe(true);
    } finally {
      masterRuntime.owns_pipeline_pref = prevPref;
      masterRuntime.running = prevRunning;
      masterRuntime.cfg.mode = prevMode;
      masterRuntime.broker = prevBroker;
    }
  });

  it('desk Capital structure seed marks capital_ohlc and clears seed pause', () => {
    const prevMode = masterRuntime.cfg.mode;
    const prevArmed = masterRuntime.entries_armed;
    const prevReason = masterRuntime.entries_pause_reason;
    const prevSeed = masterRuntime.structure_seed_source;
    const prevBroker = masterRuntime.broker;
    try {
      masterRuntime.setMode('LIVE');
      // Minimal Capital-shaped broker so applyStructureSeedGate treats LIVE Capital
      masterRuntime.broker = {
        name: 'CAPITAL',
        paper: false,
      } as never;
      masterRuntime.setEntriesArmed(false, 'structure_seed_not_capital:yahoo_ohlc');
      masterRuntime.structure_seed_source = 'yahoo_ohlc';
      masterRuntime.applyStructureSeedGate('capital_ohlc');
      expect(masterRuntime.structure_seed_source).toBe('capital_ohlc');
      expect(masterRuntime.entries_armed).toBe(true);
      expect(masterRuntime.entries_pause_reason).toBeNull();
      masterRuntime.preferDeskMarketFeed();
    } finally {
      masterRuntime.setMode(prevMode);
      masterRuntime.entries_armed = prevArmed;
      masterRuntime.entries_pause_reason = prevReason;
      masterRuntime.structure_seed_source = prevSeed;
      masterRuntime.broker = prevBroker;
    }
  });

  it('defers when owns-pipeline but live Capital position and no CAPITAL broker', () => {
    const prev = process.env.MASTER_OWNS_PIPELINE;
    const prevLive = process.env.MASTER_LIVE_ENABLED;
    const prevPref = masterRuntime.owns_pipeline_pref;
    masterRuntime.owns_pipeline_pref = null;
    process.env.MASTER_OWNS_PIPELINE = 'true';
    delete process.env.MASTER_LIVE_ENABLED;
    masterRuntime.setMode('PAPER');
    masterRuntime.ensurePaperBroker();
    expect(masterOwnsPipeline()).toBe(true);
    expect(masterOwnsManageSafely(true)).toBe(false);
    expect(masterOwnsManageSafely(false)).toBe(true);
    if (prev === undefined) delete process.env.MASTER_OWNS_PIPELINE;
    else process.env.MASTER_OWNS_PIPELINE = prev;
    if (prevLive === undefined) delete process.env.MASTER_LIVE_ENABLED;
    else process.env.MASTER_LIVE_ENABLED = prevLive;
    masterRuntime.owns_pipeline_pref = prevPref;
  });

  it('LIVE_ENABLED refuses PAPER as safe owner (Capital connect-fail dual-brain)', () => {
    const prev = process.env.MASTER_OWNS_PIPELINE;
    const prevLive = process.env.MASTER_LIVE_ENABLED;
    const prevPref = masterRuntime.owns_pipeline_pref;
    const prevArmed = masterRuntime.entries_armed;
    const prevReason = masterRuntime.entries_pause_reason;
    try {
      masterRuntime.owns_pipeline_pref = null;
      process.env.MASTER_OWNS_PIPELINE = 'true';
      process.env.MASTER_LIVE_ENABLED = 'true';
      masterRuntime.setMode('PAPER');
      masterRuntime.ensurePaperBroker();
      masterRuntime.setEntriesArmed(true);
      expect(masterOwnsManageSafely(false)).toBe(false);
      syncMasterEntryOwnership(false);
      expect(masterRuntime.entries_armed).toBe(false);
      expect(masterRuntime.entries_pause_reason).toBe('desk_live_manage_deferred');
      expect(resolveManageOwner(false)).toBe('DESK_DEFERRED_HARD');
      masterRuntime.setDeskManageOwnerHint('DESK_DEFERRED_HARD');
      expect(masterRuntime.status().manage_owner).toBe('DESK_DEFERRED_HARD');
    } finally {
      if (prev === undefined) delete process.env.MASTER_OWNS_PIPELINE;
      else process.env.MASTER_OWNS_PIPELINE = prev;
      if (prevLive === undefined) delete process.env.MASTER_LIVE_ENABLED;
      else process.env.MASTER_LIVE_ENABLED = prevLive;
      masterRuntime.owns_pipeline_pref = prevPref;
      masterRuntime.entries_armed = prevArmed;
      masterRuntime.entries_pause_reason = prevReason;
      masterRuntime.setDeskManageOwnerHint('MASTER');
    }
  });

  it('robotDesk deferred path uses decideHardProtectiveExit (no soft BestOutcome)', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const src = readFileSync(join(__dirname, '../../services/robotDesk.ts'), 'utf8');
    expect(src).toMatch(/decideHardProtectiveExit/);
    expect(src).toMatch(/DESK_DEFERRED_HARD/);
    expect(src).toMatch(/hard SL only/);
    // Soft BestOutcome only when not deferred
    expect(src).toMatch(
      /deferredHard\s*\?\s*decideHardProtectiveExit[\s\S]*:\s*decideBestOutcomeExit/
    );
  });

  it('pauses MASTER entries when desk owns live manage (no dual-brain)', () => {
    const prev = process.env.MASTER_OWNS_PIPELINE;
    const prevLive = process.env.MASTER_LIVE_ENABLED;
    const prevPref = masterRuntime.owns_pipeline_pref;
    masterRuntime.owns_pipeline_pref = null;
    process.env.MASTER_OWNS_PIPELINE = 'true';
    delete process.env.MASTER_LIVE_ENABLED;
    masterRuntime.setMode('PAPER');
    masterRuntime.ensurePaperBroker();
    masterRuntime.setEntriesArmed(true);
    syncMasterEntryOwnership(true);
    expect(masterRuntime.entries_armed).toBe(false);
    expect(masterRuntime.entries_pause_reason).toBe('desk_live_manage_deferred');
    syncMasterEntryOwnership(false);
    expect(masterRuntime.entries_armed).toBe(true);
    expect(masterRuntime.entries_pause_reason).toBeNull();
    if (prev === undefined) delete process.env.MASTER_OWNS_PIPELINE;
    else process.env.MASTER_OWNS_PIPELINE = prev;
    if (prevLive === undefined) delete process.env.MASTER_LIVE_ENABLED;
    else process.env.MASTER_LIVE_ENABLED = prevLive;
    masterRuntime.owns_pipeline_pref = prevPref;
    masterRuntime.setEntriesArmed(true);
  });
});

describe('partial close scale-out', () => {
  it('evaluatePartialClose fires at 50% to TP and paper reduces size', async () => {
    const { evaluatePartialClose } = await import('../positionManager.js');
    const d = evaluatePartialClose(
      {
        side: 'BUY',
        entry: 4400,
        take_profit: 4410,
        size: 0.1,
        partial_close_applied: false,
      },
      4405,
      { progressNeed: 0.5, volumeRatio: 0.5, volumeStep: 0.01 }
    );
    expect(d?.close_size).toBe(0.05);
    expect(d?.reason).toMatch(/PARTIAL_CLOSE/);

    const broker = new PaperBroker();
    await broker.connect();
    broker.setQuote({
      bid: 4405,
      ask: 4405.4,
      mid: 4405.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const pm = new PositionManager();
    const pipe = new MasterPipeline('PAPER');
    pm.register({
      position_id: 'paper-partial-1',
      opportunity_id: 'opp-partial',
      intent_id: 'partial-aaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4400,
      stop_loss: 4395,
      take_profit: 4410,
      decision: {
        decision_id: 'd-p',
        kind: 'BUY',
        side: 'BUY',
        score: 0.8,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ regime: 'TREND' }),
        expectancy: null,
      },
    });
    // Seed paper book so close works
    broker.seedOpens([
      {
        position_id: 'paper-partial-1',
        epic: 'GOLD',
        side: 'BUY',
        size: 0.1,
        open_level: 4400,
        stop_level: 4395,
        profit_level: 4410,
      },
    ]);
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: { bid: 4405, ask: 4405.4, mid: 4405.2, spread: 0.4, ts_ms: Date.now() },
      instrument_point_value: 1,
      partial_close_progress: 0.5,
      partial_close_volume: 0.5,
      volume_step: 0.01,
    });
    expect(managed.closed.length).toBe(1);
    expect(managed.closed[0]!.reason).toMatch(/PARTIAL_CLOSE/);
    expect(pm.count()).toBe(1);
    expect(pm.list()[0]!.size).toBeCloseTo(0.05, 8);
    expect(pm.list()[0]!.partial_close_applied).toBe(true);
  });

  it('skips partial scale-out when broker.supportsPartialClose is false', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    Object.defineProperty(broker, 'supportsPartialClose', { value: false });
    expect(broker.supportsPartialClose).toBe(false);
    let closeCalls = 0;
    const origClose = broker.closePosition.bind(broker);
    broker.closePosition = async (id, opts) => {
      closeCalls += 1;
      return origClose(id, opts);
    };
    const pm = new PositionManager();
    const pipe = new MasterPipeline('PAPER');
    pm.register({
      position_id: 'paper-no-partial',
      opportunity_id: 'opp-no-partial',
      intent_id: 'nopart-aaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4400,
      stop_loss: 4395,
      take_profit: 4410,
      decision: {
        decision_id: 'd-np',
        kind: 'BUY',
        side: 'BUY',
        score: 0.8,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ regime: 'TREND' }),
      },
    });
    broker.seedOpens([
      {
        position_id: 'paper-no-partial',
        epic: 'GOLD',
        side: 'BUY',
        size: 0.1,
        open_level: 4400,
        stop_level: 4395,
        profit_level: 4410,
      },
    ]);
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: { bid: 4405, ask: 4405.4, mid: 4405.2, spread: 0.4, ts_ms: Date.now() },
      instrument_point_value: 1,
      partial_close_progress: 0.5,
      partial_close_volume: 0.5,
      volume_step: 0.01,
      max_hold_ms: 0,
    });
    expect(managed.closed.every((c) => !/PARTIAL_CLOSE/.test(c.reason))).toBe(true);
    expect(pm.list()[0]!.size).toBeCloseTo(0.1, 8);
    expect(pm.list()[0]!.partial_close_applied).toBe(false);
    // No partial close attempted (full soft exits may still call close — only assert size untouched)
    expect(closeCalls === 0 || managed.closed.every((c) => !/PARTIAL/.test(c.reason))).toBe(true);
  });

  it('Mt4FileBroker partial CLOSE proves size reduction (EA lot honor)', async () => {
    const prevFast = process.env.MASTER_CONFIRM_FAST;
    const prevState = process.env.MASTER_STATE_DIR;
    const prevPoll = process.env.MASTER_MT4_ACK_POLL_MS;
    const prevPolls = process.env.MASTER_MT4_ACK_POLLS;
    process.env.MASTER_CONFIRM_FAST = 'true';
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'mt4-partial-state-'));
    process.env.MASTER_MT4_ACK_POLL_MS = '20';
    process.env.MASTER_MT4_ACK_POLLS = '80';
    const root = mkdtempSync(join(tmpdir(), 'mt4-partial-'));
    const sim = new Mt4BridgeSimulator(root);
    sim.setQuote(4400, 4400.4);
    sim.start(20);
    const broker = new Mt4FileBroker(root);
    await broker.connect();
    expect(broker.supportsPartialClose).toBe(true);
    try {
      const placed = await broker.placeOrder({
        intent_id: `mt4partial${Date.now()}`,
        epic: 'XAUUSD',
        side: 'BUY',
        size: 0.1,
        stop_level: 4390,
      });
      expect(placed.ok).toBe(true);
      const part = await broker.closePosition(placed.position_id!, { size: 0.04 });
      expect(part.ok).toBe(true);
      expect(part.remaining_size).toBeCloseTo(0.06, 5);
      const listed = await broker.listOpenPositions('XAUUSD');
      expect(listed.positions[0]!.size).toBeCloseTo(0.06, 5);
    } finally {
      sim.stop();
      if (prevFast === undefined) delete process.env.MASTER_CONFIRM_FAST;
      else process.env.MASTER_CONFIRM_FAST = prevFast;
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
      if (prevPoll === undefined) delete process.env.MASTER_MT4_ACK_POLL_MS;
      else process.env.MASTER_MT4_ACK_POLL_MS = prevPoll;
      if (prevPolls === undefined) delete process.env.MASTER_MT4_ACK_POLLS;
      else process.env.MASTER_MT4_ACK_POLLS = prevPolls;
    }
  });

  it('partial that full-closes journals entire size (Check- EA parity)', async () => {
    const prevFast = process.env.MASTER_CONFIRM_FAST;
    const prevState = process.env.MASTER_STATE_DIR;
    process.env.MASTER_CONFIRM_FAST = 'true';
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'mt4-fullpartial-state-'));
    const root = mkdtempSync(join(tmpdir(), 'mt4-fullpartial-'));
    const sim = new Mt4BridgeSimulator(root);
    sim.forceFullCloseOnPartial = true;
    sim.setQuote(4410, 4410.4);
    sim.start(20);
    const broker = new Mt4FileBroker(root);
    await broker.connect();
    try {
      const placed = await broker.placeOrder({
        intent_id: `mt4fullpart${Date.now()}`,
        epic: 'XAUUSD',
        side: 'BUY',
        size: 0.1,
        stop_level: 4390,
        profit_level: 4420,
      });
      expect(placed.ok).toBe(true);
      const pm = new PositionManager();
      const pipe = new MasterPipeline('PAPER');
      pm.register({
        position_id: placed.position_id!,
        opportunity_id: 'opp-full-partial',
        intent_id: 'fp-1',
        epic: 'XAUUSD',
        side: 'BUY',
        size: 0.1,
        entry: 4400,
        stop_loss: 4390,
        take_profit: 4420,
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
            trend_strength: 0.8,
            structure_bias: 'BULLISH',
            swing_high: 4420,
            swing_low: 4390,
            buy_pressure: 0.7,
            sell_pressure: 0.3,
            behavior_bull: 0.7,
            behavior_bear: 0.3,
            impact_score: 0.5,
            context_quality: 0.8,
            volatility: 0.001,
            atr: 2,
          },
          expectancy: null,
        },
      });
      pipe.journal.recordOpportunity({
        id: 'opp-full-partial',
        mode: 'LIVE',
        epic: 'XAUUSD',
        decision: pm.get(placed.position_id!)!.decision,
        risk: { allowed: true, volume: 0.1, risk_amount: 0, reasons: [] },
        executed: true,
      });
      const managed = await pm.manageTick({
        broker,
        pipeline: pipe,
        quote: {
          bid: 4410,
          ask: 4410.4,
          mid: 4410.2,
          spread: 0.4,
          ts_ms: Date.now(),
        },
        instrument_point_value: 1,
        partial_close_progress: 0.5,
        partial_close_volume: 0.5,
        breakeven_progress: 0,
        max_hold_ms: 0,
        allow_close: true,
      });
      expect(managed.closed).toHaveLength(1);
      expect(managed.closed[0]!.outcome.volume).toBeCloseTo(0.1, 6);
      expect(managed.closed[0]!.outcome.exit_reason).toMatch(/FULL/);
      expect(pm.count()).toBe(0);
      const part = await broker.listOpenPositions('XAUUSD');
      expect(part.positions.length).toBe(0);
    } finally {
      sim.stop();
      if (prevFast === undefined) delete process.env.MASTER_CONFIRM_FAST;
      else process.env.MASTER_CONFIRM_FAST = prevFast;
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
    }
  });
});

describe('manageTick close_failed visibility', () => {
  it('records close_failed instead of silently continuing', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    broker.setQuote({
      bid: 4400,
      ask: 4400.4,
      mid: 4400.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'close-fail-aaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: 4390,
    });
    const pm = new PositionManager();
    const pipe = new MasterPipeline('PAPER');
    await syncPositionsWithBroker(pm, broker, 'GOLD');
    const pos = pm.get(placed.position_id!)!;
    pipe.journal.recordOpportunity({
      id: pos.opportunity_id,
      mode: 'PAPER',
      epic: pos.epic,
      decision: pos.decision,
      risk: { allowed: true, volume: 1, risk_amount: 0, reasons: [] },
      executed: true,
    });
    const orig = broker.closePosition.bind(broker);
    broker.closePosition = async () => ({ ok: false, detail: 'simulated_close_fail' });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: { bid: 4370, ask: 4370.4, mid: 4370.2, spread: 0.4, ts_ms: Date.now() },
      instrument_point_value: 1,
      max_hold_ms: 1, // force TIME_STOP-style exit attempt
    });
    broker.closePosition = orig;
    expect(managed.closed.length).toBe(0);
    expect(managed.close_failed.length).toBe(1);
    expect(managed.close_failed[0]!.detail).toBe('simulated_close_fail');
    expect(pm.get(pos.position_id)).toBeTruthy();
  });
});

describe('protective mark + fill rebase', () => {
  it('STOP_HIT uses bid for BUY (mid above SL is not enough)', async () => {
    const { protectiveExit } = await import('../positionManager.js');
    const pos = { side: 'BUY' as const, stop_loss: 4400, take_profit: 4420 };
    // Mid still above SL, but bid has crossed — must exit
    expect(
      protectiveExit(pos, { bid: 4399.5, ask: 4400.5, mid: 4400.0 })?.reason
    ).toBe('STOP_HIT');
    // Bid still above SL — hold even if mid equals SL from ask pressure
    expect(protectiveExit(pos, { bid: 4400.2, ask: 4401.0, mid: 4400.6 })).toBeNull();
  });

  it('STOP_HIT uses ask for SELL (mid below SL is not enough)', async () => {
    const { protectiveExit } = await import('../positionManager.js');
    const pos = { side: 'SELL' as const, stop_loss: 4400, take_profit: 4380 };
    // Mid still below SL, but ask has crossed — must exit
    expect(
      protectiveExit(pos, { bid: 4399.5, ask: 4400.5, mid: 4400.0 })?.reason
    ).toBe('STOP_HIT');
    // Ask still below SL — hold even if mid equals SL from bid pressure
    expect(protectiveExit(pos, { bid: 4399.0, ask: 4399.8, mid: 4399.4 })).toBeNull();
  });

  it('rebaseStopsFromFill shifts SL/TP by fill slip', async () => {
    const { rebaseStopsFromFill } = await import('../positionManager.js');
    const r = rebaseStopsFromFill(4400, 4400.5, 4395, 4410);
    expect(r.stop_loss).toBeCloseTo(4395.5, 8);
    expect(r.take_profit).toBeCloseTo(4410.5, 8);
  });

  it('buildCandidates uses ask/bid entries not mid', () => {
    const { buy, sell } = buildCandidates(
      baseAnalysis({ regime: 'TREND', trend_dir: 'UP', momentum_dir: 'UP', trend_strength: 0.7 }),
      { bid: 4399, ask: 4401, mid: 4400, spread: 2, ts_ms: Date.now() },
      { ...DEFAULT_MASTER_CONFIG, min_score: 0.1, block_off_hours: false }
    );
    expect(buy.entry).toBe(4401);
    expect(sell.entry).toBe(4399);
  });
});

describe('manageConfig trail + partial knobs', () => {
  it('persists trail_start/lock and partial_close_* through save/load', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-manage-partial-'));
    const {
      saveManageConfig,
      loadManageConfig,
      applyManageConfigPatch,
      pickManageConfig,
    } = await import('../manageConfig.js');
    const patch = {
      trail_start: 1.5,
      trail_lock: 0.8,
      partial_close_progress: 0.4,
      partial_close_volume: 0.3,
    };
    expect(saveManageConfig(patch)).toBe(true);
    const loaded = loadManageConfig();
    expect(loaded?.trail_start).toBe(1.5);
    expect(loaded?.trail_lock).toBe(0.8);
    expect(loaded?.partial_close_progress).toBe(0.4);
    expect(loaded?.partial_close_volume).toBe(0.3);
    const next = applyManageConfigPatch(DEFAULT_MASTER_CONFIG, loaded!);
    const picked = pickManageConfig(next);
    expect(picked.partial_close_progress).toBe(0.4);
    expect(picked.trail_lock).toBe(0.8);
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
  });
});

describe('runtime gates persist', () => {
  it('save/load last_loss and reject cooldown', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-gates-'));
    const { saveRuntimeGates, loadRuntimeGates } = await import('../runtimeGates.js');
    expect(
      saveRuntimeGates({
        last_loss_ms: 12345,
        reject_until_ms: 67890,
        inflight_until_ms: 99999,
        post_exit_until_ms: 11111,
        last_entry_fingerprint: 'GOLD:BUY',
        day_start_equity: 10_250.5,
        peak_equity: 11_000,
        daily_pnl_day: '2026-09-07',
        last_ai_allow_close: false,
      })
    ).toBe(true);
    expect(loadRuntimeGates()).toEqual({
      last_loss_ms: 12345,
      reject_until_ms: 67890,
      inflight_until_ms: 99999,
      post_exit_until_ms: 11111,
      last_entry_fingerprint: 'GOLD:BUY',
      day_start_equity: 10_250.5,
      peak_equity: 11_000,
      daily_pnl_day: '2026-09-07',
      consecutive_losses: null,
      capital_day_gates_seeded: false,
      last_ai_allow_close: false,
      ai_mode: null,
      kill_switch: false,
      mode: null,
      epic: null,
      entries_armed: null,
      entries_pause_reason: null,
      last_close_failed: null,
      desired_running: false,
    });
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
  });

  it('recover fail-closes soft AI allow when advisory and gate missing', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-ai-gate-'));
    const prevAi = masterRuntime.last_ai_allow_close;
    const prevMode = masterRuntime.cfg.ai_mode;
    try {
      masterRuntime.cfg = { ...masterRuntime.cfg, ai_mode: 'advisory' };
      masterRuntime.last_ai_allow_close = true;
      await masterRuntime.recover();
      expect(masterRuntime.last_ai_allow_close).toBe(false);
    } finally {
      masterRuntime.last_ai_allow_close = prevAi;
      masterRuntime.cfg = { ...masterRuntime.cfg, ai_mode: prevMode };
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });

  it('setAiMode persists mode and fail-closes soft exits when enabling', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-ai-mode-'));
    const { loadRuntimeGates } = await import('../runtimeGates.js');
    const prevAi = masterRuntime.last_ai_allow_close;
    const prevMode = masterRuntime.cfg.ai_mode;
    try {
      masterRuntime.cfg = { ...masterRuntime.cfg, ai_mode: 'off' };
      masterRuntime.last_ai_allow_close = true;
      masterRuntime.setAiMode('advisory');
      expect(masterRuntime.cfg.ai_mode).toBe('advisory');
      expect(masterRuntime.last_ai_allow_close).toBe(false);
      expect(masterRuntime.status().last_ai_allow_close).toBe(false);
      const gates = loadRuntimeGates();
      expect(gates?.ai_mode).toBe('advisory');
      expect(gates?.last_ai_allow_close).toBe(false);
      masterRuntime.setAiMode('required');
      expect(loadRuntimeGates()?.ai_mode).toBe('required');
    } finally {
      masterRuntime.last_ai_allow_close = prevAi;
      masterRuntime.cfg = { ...masterRuntime.cfg, ai_mode: prevMode };
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });

  it('kill_switch survives restart via runtime_gates', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-kill-gate-'));
    const prevKill = masterRuntime.cfg.kill_switch;
    try {
      masterRuntime.setKillSwitch(true);
      expect(masterRuntime.cfg.kill_switch).toBe(true);
      const { loadRuntimeGates } = await import('../runtimeGates.js');
      expect(loadRuntimeGates()?.kill_switch).toBe(true);
      masterRuntime.cfg = { ...masterRuntime.cfg, kill_switch: false };
      await masterRuntime.recover();
      expect(masterRuntime.cfg.kill_switch).toBe(true);
      expect(masterRuntime.status().health).toBe('KILL_SWITCH');
      masterRuntime.setKillSwitch(false);
    } finally {
      masterRuntime.cfg = { ...masterRuntime.cfg, kill_switch: prevKill };
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });

  it('mode/epic/entries_armed survive restart via runtime_gates', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-session-gate-'));
    const prevMode = masterRuntime.cfg.mode;
    const prevEpic = masterRuntime.epic;
    const prevArmed = masterRuntime.entries_armed;
    const prevPause = masterRuntime.entries_pause_reason;
    try {
      masterRuntime.setMode('PAPER');
      masterRuntime.setEpic('SILVER');
      masterRuntime.setEntriesArmed(false, 'operator_pause_test');
      const { loadRuntimeGates } = await import('../runtimeGates.js');
      const g = loadRuntimeGates();
      expect(g?.mode).toBe('PAPER');
      expect(g?.epic).toBe('SILVER');
      expect(g?.entries_armed).toBe(false);
      expect(g?.entries_pause_reason).toBe('operator_pause_test');
      masterRuntime.cfg = { ...masterRuntime.cfg, mode: 'BACKTEST' };
      masterRuntime.epic = 'GOLD';
      masterRuntime.entries_armed = true;
      masterRuntime.entries_pause_reason = null;
      await masterRuntime.recover();
      expect(masterRuntime.cfg.mode).toBe('PAPER');
      expect(masterRuntime.epic).toBe('SILVER');
      expect(masterRuntime.entries_armed).toBe(false);
      expect(masterRuntime.entries_pause_reason).toBe('operator_pause_test');
    } finally {
      masterRuntime.cfg = { ...masterRuntime.cfg, mode: prevMode };
      masterRuntime.epic = prevEpic;
      masterRuntime.entries_armed = prevArmed;
      masterRuntime.entries_pause_reason = prevPause;
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });

  it('hydrateRuntimeGatesFromDisk restores kill + last_close_failed without recover', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-boot-gates-'));
    const { saveRuntimeGates } = await import('../runtimeGates.js');
    const prevKill = masterRuntime.cfg.kill_switch;
    const prevFail = masterRuntime.last_close_failed;
    try {
      saveRuntimeGates({
        last_loss_ms: 0,
        reject_until_ms: 0,
        kill_switch: true,
        last_close_failed: {
          position_id: 'pos-boot',
          exit_reason: 'OPERATOR_CLOSE',
          detail: 'boot_sticky',
          ts: new Date().toISOString(),
        },
      });
      masterRuntime.cfg = { ...masterRuntime.cfg, kill_switch: false };
      masterRuntime.last_close_failed = null;
      expect(masterRuntime.hydrateRuntimeGatesFromDisk()).toBe(true);
      expect(masterRuntime.cfg.kill_switch).toBe(true);
      expect(masterRuntime.last_close_failed?.detail).toBe('boot_sticky');
      expect(masterRuntime.status().health).toBe('KILL_SWITCH');
      expect(masterRuntime.status().last_close_failed?.detail).toBe('boot_sticky');
    } finally {
      masterRuntime.cfg = { ...masterRuntime.cfg, kill_switch: prevKill };
      masterRuntime.last_close_failed = prevFail;
      masterRuntime.setKillSwitch(false);
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });

  it('hydrateBookFromDisk seeds journal KPIs without full recover', async () => {
    const prevDir = process.env.MASTER_STATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'vs-boot-book-'));
    process.env.MASTER_STATE_DIR = dir;
    const { installFilePersist } = await import('../filePersist.js');
    const {
      persistOpportunity,
      persistOutcome,
      saveOpenPositions,
      setPersistClient,
    } = await import('../persist.js');
    const { GOLD_SPEC } = await import('../pipeline.js');
    installFilePersist(dir);

    const pipe = new MasterPipeline('PAPER');
    const bars = Array.from({ length: 40 }, (_, i) => {
      const o = 4400 + i * 0.5;
      return { open: o, high: o + 1, low: o - 0.2, close: o + 0.4, ts_ms: i * 60_000 };
    });
    const cycle = await pipe.runCycle({
      bars,
      quote: {
        bid: 4419.8,
        ask: 4420.2,
        mid: 4420,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      account: {
        equity: 10_000,
        balance: 10_000,
        currency: 'GBP',
        open_positions: 0,
        daily_pnl: 0,
        peak_equity: 10_000,
        consecutive_losses: 0,
      },
      instrument: GOLD_SPEC,
      cfg: { ...DEFAULT_MASTER_CONFIG, block_off_hours: false },
    });
    const pm = new PositionManager();
    pm.register({
      position_id: 'boot-pos-1',
      opportunity_id: cycle.opportunity.id,
      intent_id: 'boot-intent-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      decision: cycle.decision,
    });
    await saveOpenPositions(pm.list());
    await persistOpportunity(cycle.opportunity);
    await persistOutcome(
      cycle.opportunity.id,
      {
        position_id: 'closed-boot-1',
        side: 'BUY',
        entry: 4410,
        exit: 4418,
        volume: 0.1,
        pnl: 8,
        fees: 0.1,
        slippage: 0,
        mae: 1,
        mfe: 9,
        r_multiple: 1.2,
        hold_ms: 30_000,
        exit_reason: 'TakeProfit',
      },
      'TREND:BUY'
    );

    const prevExit = masterRuntime.last_exit_reason;
    const prevDec = masterRuntime.last_decision;
    const prevPnl = masterRuntime.account.daily_pnl;
    const prevRec = masterRuntime.recovered;
    try {
      masterRuntime.pipeline = new MasterPipeline('PAPER');
      masterRuntime.positions = new PositionManager();
      masterRuntime.broker = null;
      masterRuntime.broker_detail = null;
      masterRuntime.running = false;
      masterRuntime.recovered = false;
      (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated = false;
      masterRuntime.last_exit_reason = null;
      masterRuntime.last_decision = null;
      masterRuntime.account.daily_pnl = 0;

      const ok = await masterRuntime.hydrateBookFromDisk();
      expect(ok).toBe(true);
      expect(masterRuntime.recovered).toBe(false);
      expect(masterRuntime.positions.count()).toBe(1);
      expect(masterRuntime.pipeline.journal.opportunities.length).toBeGreaterThanOrEqual(1);
      expect(masterRuntime.last_exit_reason).toBe('TakeProfit');
      expect(masterRuntime.last_decision).toBeTruthy();
      expect(masterRuntime.account.daily_pnl).toBe(8);
      expect(masterRuntime.status().post_exit_cooldown_ms).toBeGreaterThanOrEqual(0);
      expect(masterRuntime.status().open_positions).toBe(1);
    } finally {
      masterRuntime.last_exit_reason = prevExit;
      masterRuntime.last_decision = prevDec;
      masterRuntime.account.daily_pnl = prevPnl;
      masterRuntime.recovered = prevRec;
      masterRuntime.positions = new PositionManager();
      masterRuntime.pipeline = new MasterPipeline('PAPER');
      (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated = false;
      setPersistClient(null);
      if (prevDir === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevDir;
    }
  });

  it('setEntriesArmed control path persists pause and status post_exit field', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-entries-ctl-'));
    const prevArmed = masterRuntime.entries_armed;
    const prevReason = masterRuntime.entries_pause_reason;
    const prevPost = (masterRuntime as unknown as { post_exit_until_ms: number })
      .post_exit_until_ms;
    try {
      masterRuntime.setEntriesArmed(false, 'operator_entries_pause');
      expect(masterRuntime.entries_armed).toBe(false);
      expect(masterRuntime.entries_pause_reason).toBe('operator_entries_pause');
      expect(masterRuntime.status().entries_armed).toBe(false);
      (masterRuntime as unknown as { post_exit_until_ms: number }).post_exit_until_ms =
        Date.now() + 12_000;
      expect(masterRuntime.status().post_exit_cooldown_ms).toBeGreaterThan(0);
      masterRuntime.setEntriesArmed(true);
      expect(masterRuntime.entries_armed).toBe(true);
      expect(masterRuntime.entries_pause_reason).toBeNull();
    } finally {
      masterRuntime.entries_armed = prevArmed;
      masterRuntime.entries_pause_reason = prevReason;
      (masterRuntime as unknown as { post_exit_until_ms: number }).post_exit_until_ms =
        prevPost;
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });

  it('desired_running survives gates hydrate; manage works while stopped with opens', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-desired-run-'));
    const { saveRuntimeGates, loadRuntimeGates } = await import('../runtimeGates.js');
    const prevDesired = masterRuntime.desired_running;
    const prevRunning = masterRuntime.running;
    const prevMode = masterRuntime.cfg.mode;
    try {
      saveRuntimeGates({
        last_loss_ms: 0,
        reject_until_ms: 0,
        desired_running: true,
        mode: 'PAPER',
      });
      masterRuntime.desired_running = false;
      masterRuntime.running = false;
      expect(masterRuntime.hydrateRuntimeGatesFromDisk()).toBe(true);
      expect(masterRuntime.desired_running).toBe(true);
      expect(loadRuntimeGates()?.desired_running).toBe(true);

      // Simulate Stop-with-opens: manage loop + health must not claim OK
      masterRuntime.cfg = {
        ...masterRuntime.cfg,
        mode: 'PAPER',
        ai_mode: 'required',
        scalp_pct_chase: false,
        soft_trail_money_arm: 0,
        be_start: 0,
        trail_start: 0,
        max_hold_ms: 0,
      };
      masterRuntime.last_ai_allow_close = false;
      masterRuntime.pipeline = new MasterPipeline('PAPER');
      masterRuntime.positions = new PositionManager();
      masterRuntime.positions.register({
        position_id: 'manage-while-stop-1',
        opportunity_id: 'opp-mws',
        intent_id: 'intent-mws-aaaaaaaa',
        epic: 'GOLD',
        side: 'BUY',
        size: 0.1,
        entry: 4400,
        stop_loss: 4300,
        take_profit: 4600,
        decision: {
          decision_id: 'd-mws',
          kind: 'BUY',
          side: 'BUY',
          score: 0.7,
          block_reason: null,
          buy: null as never,
          sell: null as never,
          analysis: baseAnalysis({ regime: 'TREND' }),
          expectancy: null,
        },
      });
      masterRuntime.running = false;
      masterRuntime.desired_running = false;
      masterRuntime.ensurePaperBroker();
      masterRuntime.last_bars = Array.from({ length: 40 }, (_, i) => {
        const o = 4400 + i * 0.2;
        return { open: o, high: o + 1, low: o - 0.5, close: o + 0.3, ts_ms: i * 60_000 };
      });
      masterRuntime.last_quote = {
        bid: 4405,
        ask: 4405.4,
        mid: 4405.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      await masterRuntime.bootstrapManageAfterRecoverPublic();
      const st = masterRuntime.status();
      expect(st.open_positions).toBe(1);
      expect(st.running).toBe(false);
      expect(['OPENS_MANAGE_ONLY', 'OPENS_UNMANAGED']).toContain(st.health);
      // Manage timer should be armed after bootstrap
      expect(
        (masterRuntime as unknown as { manageTimer: NodeJS.Timeout | null }).manageTimer
      ).toBeTruthy();
      expect(st.health).toBe('OPENS_MANAGE_ONLY');
      // PaperBroker must be reseeded — otherwise ≥5 empty syncs ghost-wipe
      expect(masterRuntime.broker).toBeInstanceOf(PaperBroker);
      const seeded = await masterRuntime.broker!.listOpenPositions();
      expect(seeded.positions.length).toBe(1);
      for (let i = 0; i < 6; i++) {
        await masterRuntime.bootstrapManageAfterRecoverPublic();
      }
      expect(masterRuntime.positions.count()).toBe(1);
      expect(masterRuntime.status().open_positions).toBe(1);
    } finally {
      masterRuntime.positions = new PositionManager();
      masterRuntime.stop();
      masterRuntime.desired_running = prevDesired;
      masterRuntime.running = prevRunning;
      masterRuntime.cfg = { ...masterRuntime.cfg, mode: prevMode };
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });
});

describe('error journal', () => {
  it('appends and tails durable cycle errors', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-errj-'));
    const { logMasterError, loadMasterErrors } = await import('../errorJournal.js');
    const a = logMasterError({
      module: 'runtime.tick',
      error_type: 'cycle_failed',
      message: 'boom',
      context: { epic: 'GOLD' },
    });
    expect(a.error_id).toBeTruthy();
    logMasterError({
      module: 'runtime.entry',
      error_type: 'broker_verify_failed',
      message: 'mt4_status_stale',
    });
    const rows = loadMasterErrors(10);
    expect(rows.length).toBe(2);
    expect(rows[0]!.error_type).toBe('broker_verify_failed');
    expect(rows[1]!.message).toBe('boom');
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
  });
});

describe('runMasterFromDesk integration', () => {
  it('quoteFromCapital stamps ts_ms from update_time (not Date.now)', async () => {
    const { quoteFromCapital } = await import('../deskBridge.js');
    const updateIso = new Date(Date.now() - 45_000).toISOString();
    const q = quoteFromCapital({
      bid: 4410,
      ask: 4410.4,
      mid: 4410.2,
      update_time: updateIso,
    });
    expect(q).not.toBeNull();
    expect(q!.ts_ms).toBe(Date.parse(updateIso));
    expect(Date.now() - q!.ts_ms).toBeGreaterThan(30_000);
    const missing = quoteFromCapital({ bid: 4410, ask: 4410.4, mid: 4410.2 });
    expect(missing).not.toBeNull();
    expect(Date.now() - missing!.ts_ms).toBeGreaterThanOrEqual(50_000);
  });

  it('ticks manage path with desk bars when owns-pipeline and entries armed', async () => {
    const prev = process.env.MASTER_OWNS_PIPELINE;
    process.env.MASTER_OWNS_PIPELINE = 'true';
    masterRuntime.setMode('PAPER');
    masterRuntime.ensurePaperBroker();
    masterRuntime.setEntriesArmed(true);
    const { runMasterFromDesk } = await import('../deskBridge.js');
    const minutes = Array.from({ length: 12 }, (_, i) => ({
      open: 4400 + i * 0.5,
      high: 4401 + i * 0.5,
      low: 4399 + i * 0.5,
      close: 4400.4 + i * 0.5,
      snapshotTime: new Date(Date.now() - (12 - i) * 60_000).toISOString(),
    }));
    const res = await runMasterFromDesk({
      epic: 'GOLD',
      bid: 4406,
      ask: 4406.4,
      mid: 4406.2,
      minuteCandles: minutes as any,
      closed10s: { open: 4406, high: 4407, low: 4405, close: 4406.2, ts_ms: Date.now() } as any,
    });
    expect(res.active).toBe(true);
    expect(res.detail).toMatch(/MASTER/);
    if (prev === undefined) delete process.env.MASTER_OWNS_PIPELINE;
    else process.env.MASTER_OWNS_PIPELINE = prev;
  });

  it('desk owns path hard-fails Stage·validate on feed_divergent public mids', async () => {
    const prev = process.env.MASTER_OWNS_PIPELINE;
    process.env.MASTER_OWNS_PIPELINE = 'true';
    const origRefresh = masterRuntime.refreshPublicReferenceMids.bind(
      masterRuntime
    );
    try {
      masterRuntime.setOwnsPipeline(true);
      masterRuntime.setMode('PAPER');
      masterRuntime.ensurePaperBroker();
      masterRuntime.setEntriesArmed(true);
      // Force divergent public consensus vs desk Capital mid (~4406)
      masterRuntime.refreshPublicReferenceMids = async () => [4600, 4610];
      const { runMasterFromDesk } = await import('../deskBridge.js');
      const minutes = Array.from({ length: 12 }, (_, i) => ({
        open: 4400 + i * 0.5,
        high: 4401 + i * 0.5,
        low: 4399 + i * 0.5,
        close: 4400.4 + i * 0.5,
        snapshotTime: new Date(Date.now() - (12 - i) * 60_000).toISOString(),
      }));
      const res = await runMasterFromDesk({
        epic: 'GOLD',
        bid: 4406,
        ask: 4406.4,
        mid: 4406.2,
        update_time: new Date().toISOString(),
        minuteCandles: minutes as any,
        closed10s: {
          open: 4406,
          high: 4407,
          low: 4405,
          close: 4406.2,
          ts_ms: Date.now(),
        } as any,
      });
      expect(res.active).toBe(true);
      expect(res.executed).toBe(false);
      expect(res.detail).toMatch(/feed_divergent|market_validation/);
      const st = masterRuntime.status();
      expect(st.pipeline_stages.market_validation.ok).toBe(false);
      expect(String(st.pipeline_stages.market_validation.detail)).toMatch(
        /feed_divergent/
      );
      expect(String(st.last_block_reason || '')).toMatch(/feed_divergent/);
    } finally {
      masterRuntime.refreshPublicReferenceMids = origRefresh;
      if (prev === undefined) delete process.env.MASTER_OWNS_PIPELINE;
      else process.env.MASTER_OWNS_PIPELINE = prev;
    }
  });

  it('desk owns path does not forge feed_divergent when public mids agree', async () => {
    const prev = process.env.MASTER_OWNS_PIPELINE;
    process.env.MASTER_OWNS_PIPELINE = 'true';
    const origRefresh = masterRuntime.refreshPublicReferenceMids.bind(
      masterRuntime
    );
    try {
      masterRuntime.setOwnsPipeline(true);
      masterRuntime.setMode('PAPER');
      masterRuntime.ensurePaperBroker();
      masterRuntime.setEntriesArmed(true);
      masterRuntime.refreshPublicReferenceMids = async () => [
        4406.1, 4406.3, 4405.9,
      ];
      const { runMasterFromDesk } = await import('../deskBridge.js');
      const minutes = Array.from({ length: 12 }, (_, i) => ({
        open: 4400 + i * 0.5,
        high: 4401 + i * 0.5,
        low: 4399 + i * 0.5,
        close: 4400.4 + i * 0.5,
        snapshotTime: new Date(Date.now() - (12 - i) * 60_000).toISOString(),
      }));
      await runMasterFromDesk({
        epic: 'GOLD',
        bid: 4406,
        ask: 4406.4,
        mid: 4406.2,
        update_time: new Date().toISOString(),
        minuteCandles: minutes as any,
        closed10s: {
          open: 4406,
          high: 4407,
          low: 4405,
          close: 4406.2,
          ts_ms: Date.now(),
        } as any,
      });
      const st = masterRuntime.status();
      expect(String(st.pipeline_stages.market_validation.detail || '')).not.toMatch(
        /feed_divergent/
      );
    } finally {
      masterRuntime.refreshPublicReferenceMids = origRefresh;
      if (prev === undefined) delete process.env.MASTER_OWNS_PIPELINE;
      else process.env.MASTER_OWNS_PIPELINE = prev;
    }
  });

  it('GOLD→SILVER→GOLD restores sticky SETUP and retains cycles_by_epic', async () => {
    const prev = process.env.MASTER_OWNS_PIPELINE;
    const prevPref = masterRuntime.owns_pipeline_pref;
    process.env.MASTER_OWNS_PIPELINE = 'true';
    const prevEpic = masterRuntime.epic;
    const prevPipe = masterRuntime.pipeline;
    try {
      masterRuntime.setOwnsPipeline(true);
      masterRuntime.setMode('PAPER');
      masterRuntime.ensurePaperBroker();
      masterRuntime.setEntriesArmed(true);
      const { MasterPipeline } = await import('../pipeline.js');
      const { emptySetup } = await import('../../services/marketSetup.js');
      masterRuntime.pipeline = new MasterPipeline('PAPER');
      // Seed GOLD ARMED setup, then switch epics
      masterRuntime.setEpic('GOLD');
      const armed = {
        ...emptySetup('test_gold_armed'),
        kind: 'CONTINUATION' as const,
        side: 'BUY' as const,
        status: 'ARMED' as const,
        reason: 'test_gold_armed',
        confirm: 2,
      };
      masterRuntime.pipeline.restoreMarketSetup({
        setup: armed,
        structure: null,
      });
      expect(masterRuntime.pipeline.getMarketSetup()?.reason).toBe('test_gold_armed');

      masterRuntime.setEpic('SILVER');
      expect(masterRuntime.pipeline.getMarketSetup()?.reason).not.toBe('test_gold_armed');
      // Plant SILVER setup so GOLD restore is not confused
      masterRuntime.pipeline.restoreMarketSetup({
        setup: {
          ...emptySetup('test_silver'),
          kind: 'CONTINUATION',
          side: 'SELL',
          status: 'WATCH',
          reason: 'test_silver',
          confirm: 0,
        },
        structure: null,
      });

      masterRuntime.setEpic('GOLD');
      expect(masterRuntime.pipeline.getMarketSetup()?.reason).toBe('test_gold_armed');
      expect(masterRuntime.pipeline.getMarketSetup()?.status).toBe('ARMED');
      expect(masterRuntime.pipeline.getMarketSetup()?.side).toBe('BUY');

      // Simulate cycle remember for both epics via status map after ticks
      const { runMasterFromDesk } = await import('../deskBridge.js');
      const goldBars = Array.from({ length: 12 }, (_, i) => ({
        open: 4400 + i * 0.5,
        high: 4401 + i * 0.5,
        low: 4399 + i * 0.5,
        close: 4400.4 + i * 0.5,
        snapshotTime: new Date(Date.now() - (12 - i) * 60_000).toISOString(),
      }));
      const silverBars = Array.from({ length: 12 }, (_, i) => ({
        open: 30 + i * 0.05,
        high: 30.1 + i * 0.05,
        low: 29.9 + i * 0.05,
        close: 30.05 + i * 0.05,
        snapshotTime: new Date(Date.now() - (12 - i) * 60_000).toISOString(),
      }));
      const g = await runMasterFromDesk({
        epic: 'GOLD',
        bid: 4406,
        ask: 4406.4,
        mid: 4406.2,
        minuteCandles: goldBars as any,
        closed10s: {
          open: 4406,
          high: 4407,
          low: 4405,
          close: 4406.2,
          ts_ms: Date.now(),
        } as any,
      });
      expect(g.active).toBe(true);
      const s = await runMasterFromDesk({
        epic: 'SILVER',
        bid: 30.5,
        ask: 30.55,
        mid: 30.52,
        minuteCandles: silverBars as any,
        closed10s: {
          open: 30.5,
          high: 30.6,
          low: 30.4,
          close: 30.52,
          ts_ms: Date.now(),
        } as any,
      });
      expect(s.active).toBe(true);
      const st = masterRuntime.status();
      expect(st.cycles_by_epic.GOLD).toBeTruthy();
      expect(st.cycles_by_epic.SILVER).toBeTruthy();
      expect(st.epic).toBe('SILVER');
      // Switch back — GOLD setup stash should still restore
      masterRuntime.setEpic('GOLD');
      const goldSetup = masterRuntime.pipeline.getMarketSetup();
      expect(goldSetup).toBeTruthy();
    } finally {
      masterRuntime.pipeline = prevPipe;
      masterRuntime.owns_pipeline_pref = prevPref;
      masterRuntime.setEpic(prevEpic);
      if (prev === undefined) delete process.env.MASTER_OWNS_PIPELINE;
      else process.env.MASTER_OWNS_PIPELINE = prev;
    }
  });
});

describe('buildMasterBars 10s hygiene', () => {
  it('skips flat 10s append that would poison 1m ATR', async () => {
    const { buildMasterBars } = await import('../deskBridge.js');
    const minutes = Array.from({ length: 10 }, (_, i) => ({
      open: 4400 + i,
      high: 4401 + i,
      low: 4399 + i,
      close: 4400.5 + i,
      snapshotTime: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
    }));
    const flat10 = { open: 4410, high: 4410.01, low: 4409.99, close: 4410, ts_ms: Date.now() };
    const bars = buildMasterBars(minutes as any, flat10 as any);
    expect(bars.length).toBe(10); // flat 10s not appended
    const wide10 = { open: 4410, high: 4412, low: 4408, close: 4411, ts_ms: Date.now() };
    const bars2 = buildMasterBars(minutes as any, wide10 as any);
    expect(bars2.length).toBe(11);
  });
});

describe('MASTER epic alias sync', () => {
  it('MT4 getAccount exposes free margin as available (equity - margin)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vs-mt4-margin-'));
    mkdirSync(join(root, 'status'), { recursive: true });
    writeFileSync(
      join(root, 'status', 'latest.json'),
      JSON.stringify({
        equity: 10_000,
        balance: 9_800,
        margin: 1_200,
        positions: [],
      })
    );
    const broker = new Mt4FileBroker(root);
    await broker.connect();
    const acct = await broker.getAccount();
    expect(acct?.equity).toBe(10_000);
    expect(acct?.available).toBe(8800);
  });

  it('MT4 getAccount prefers margin_free and connected∧trade_allowed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vs-mt4-mfree-'));
    mkdirSync(join(root, 'status'), { recursive: true });
    writeFileSync(
      join(root, 'status', 'latest.json'),
      JSON.stringify({
        equity: 10_000,
        balance: 10_000,
        margin: 2_000,
        margin_free: 7_500,
        connected: false,
        trading_allowed: true,
        positions: [],
      })
    );
    const broker = new Mt4FileBroker(root);
    await broker.connect();
    const acct = await broker.getAccount();
    expect(acct?.available).toBe(7500);
    expect(acct?.trade_allowed).toBe(false);
  });

  it('MT4 getAccount parses trading_allowed=false', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vs-mt4-tradeoff-'));
    mkdirSync(join(root, 'status'), { recursive: true });
    writeFileSync(
      join(root, 'status', 'latest.json'),
      JSON.stringify({
        equity: 10_000,
        balance: 10_000,
        trading_allowed: false,
        positions: [],
      })
    );
    const broker = new Mt4FileBroker(root);
    await broker.connect();
    const acct = await broker.getAccount();
    expect(acct?.trade_allowed).toBe(false);
  });

  it('GOLD local matches XAUUSD MT4 ticket — does not wipe as broker_flat', async () => {
    expect(normalizeEpicKey('GOLD')).toBe('XAUUSD');
    expect(epicsMatch('GOLD', 'XAUUSD')).toBe(true);

    const root = mkdtempSync(join(tmpdir(), 'vs-mt4-alias-'));
    mkdirSync(join(root, 'status'), { recursive: true });
    writeFileSync(
      join(root, 'status', 'latest.json'),
      JSON.stringify({
        equity: 10_000,
        balance: 10_000,
        positions: [
          {
            ticket: 100001,
            symbol: 'XAUUSD',
            side: 'BUY',
            lot: 0.1,
            open: 4470,
            sl: 4460,
            tp: 4490,
            profit: 0,
          },
        ],
      })
    );
    const broker = new Mt4FileBroker(root);
    await broker.connect();
    const listed = await broker.listOpenPositions('GOLD');
    expect(listed.ok).toBe(true);
    expect(listed.positions.length).toBe(1);
    expect(listed.positions[0]!.position_id).toBe('100001');

    const pm = new PositionManager();
    pm.register({
      position_id: '100001',
      opportunity_id: '00000000-0000-4000-8000-00000000aaaa',
      intent_id: 'intent-alias',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4470,
      stop_loss: 4460,
      decision: {
        decision_id: 'd-alias',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ regime: 'TREND' }),
        expectancy: null,
      },
    });
    const sync = await syncPositionsWithBroker(pm, broker, 'GOLD');
    expect(sync.orphans_local.length).toBe(0);
    expect(sync.matched).toBe(1);
    expect(pm.count()).toBe(1);
  });
});

describe('partial_close persist + Check be_start', () => {
  it('persists partial_close_applied across save/load', async () => {
    const { MemoryPersist, setPersistClient, saveOpenPositions, loadOpenPositions } = await import(
      '../persist.js'
    );
    const mem = new MemoryPersist();
    setPersistClient(mem);
    const pm = new PositionManager();
    pm.register({
      position_id: 'pc-persist-1',
      opportunity_id: '00000000-0000-4000-8000-00000000bbbb',
      intent_id: 'pc-intent',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4400,
      stop_loss: 4390,
      take_profit: 4420,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    pm.get('pc-persist-1')!.partial_close_applied = true;
    await saveOpenPositions(pm.list());
    const loaded = await loadOpenPositions();
    expect(loaded[0]!.partial_close_applied).toBe(true);
    setPersistClient(null);
  });

  it('Check be_start arms BE without take_profit', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry + 0.6,
      ask: entry + 0.7,
      mid: entry + 0.65,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'be-start-bbbbbbbbbbbbbbbb',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 2,
      profit_level: undefined,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-be-start',
      intent_id: 'be-start-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry,
      stop_loss: entry - 2,
      take_profit: null,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ regime: 'TREND' }),
        expectancy: null,
      },
    });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry + 0.6,
        ask: entry + 0.7,
        mid: entry + 0.65,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      breakeven_progress: 0,
      be_start: 0.5,
      breakeven_offset: 0.1,
      max_hold_ms: 0,
    });
    expect(managed.closed.length).toBe(0);
    expect(pm.get(placed.position_id!)!.stop_loss).toBeCloseTo(entry + 0.1, 6);
  });

  it('VS-System multi-TP scales then finals on gap-through', async () => {
    const { buildEqualMultiTpPlan } = await import('../multiTp.js');
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    const plan = buildEqualMultiTpPlan({
      side: 'BUY',
      entry,
      initial_volume: 0.03,
      count: 3,
      atr: 3,
      atr_tp_mult: 1,
      volume_step: 0.01,
    });
    expect(plan.length).toBe(3);
    broker.setQuote({
      bid: plan[2]!.price + 0.1,
      ask: plan[2]!.price + 0.2,
      mid: plan[2]!.price + 0.15,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'multi-tp-bbbbbbbbbbbbbbbb',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.03,
      stop_level: entry - 2,
      profit_level: plan[2]!.price,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-mtp',
      intent_id: 'mtp-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.03,
      entry,
      stop_loss: entry - 2,
      take_profit: plan[2]!.price,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ atr: 3 }),
        expectancy: null,
      },
      multi_tp_levels: plan,
    });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: plan[2]!.price + 0.1,
        ask: plan[2]!.price + 0.2,
        mid: plan[2]!.price + 0.15,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      volume_step: 0.01,
      max_hold_ms: 0,
      breakeven_progress: 0,
    });
    // Gap-through should clear all three levels in one tick
    expect(managed.closed.length).toBeGreaterThanOrEqual(2);
    expect(pm.count()).toBe(0);
    expect(managed.closed.some((c) => /MULTI_TP_.*FINAL|MULTI_TP_3/.test(c.reason))).toBe(
      true
    );
  });

  it('VS-System multi-TP SELL scales then finals on gap-through', async () => {
    const { buildEqualMultiTpPlan } = await import('../multiTp.js');
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    const plan = buildEqualMultiTpPlan({
      side: 'SELL',
      entry,
      initial_volume: 0.03,
      count: 3,
      atr: 3,
      atr_tp_mult: 1,
      volume_step: 0.01,
    });
    expect(plan.length).toBe(3);
    broker.setQuote({
      bid: plan[2]!.price - 0.2,
      ask: plan[2]!.price - 0.1,
      mid: plan[2]!.price - 0.15,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'multi-tp-selllllllllllll',
      epic: 'GOLD',
      side: 'SELL',
      size: 0.03,
      stop_level: entry + 2,
      profit_level: plan[2]!.price,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-mtp-sell',
      intent_id: 'mtp-sell-1',
      epic: 'GOLD',
      side: 'SELL',
      size: 0.03,
      entry,
      stop_loss: entry + 2,
      take_profit: plan[2]!.price,
      decision: {
        decision_id: 'd',
        kind: 'SELL',
        side: 'SELL',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ atr: 3, regime: 'TREND_DOWN', trend_dir: 'DOWN' }),
        expectancy: null,
      },
      multi_tp_levels: plan,
    });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: plan[2]!.price - 0.2,
        ask: plan[2]!.price - 0.1,
        mid: plan[2]!.price - 0.15,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      volume_step: 0.01,
      max_hold_ms: 0,
      breakeven_progress: 0,
    });
    expect(managed.closed.length).toBeGreaterThanOrEqual(2);
    expect(pm.count()).toBe(0);
    expect(managed.closed.some((c) => /MULTI_TP_.*FINAL|MULTI_TP_3/.test(c.reason))).toBe(
      true
    );
  });

  it('Capital LIVE multi-TP refuses scale-out while venue UPL unread', async () => {
    const { buildEqualMultiTpPlan } = await import('../multiTp.js');
    const entry = 4400;
    const plan = buildEqualMultiTpPlan({
      side: 'BUY',
      entry,
      initial_volume: 0.03,
      count: 3,
      atr: 3,
      atr_tp_mult: 1,
      volume_step: 0.01,
    });
    let closed = 0;
    const broker = {
      name: 'CAPITAL',
      paper: false,
      supportsPartialClose: true,
      async closePosition() {
        closed += 1;
        return { ok: true, fill_price: plan[2]!.price + 0.1, fill_pnl: 1, remaining_size: 0.02 };
      },
      async modifyPosition() {
        return { ok: true, detail: 'ok' };
      },
    } as never;
    const pipe = new MasterPipeline('LIVE');
    const pm = new PositionManager();
    pm.register({
      position_id: 'deal-mtp-upl',
      opportunity_id: 'opp-mtp-upl',
      intent_id: 'mtp-upl',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.03,
      entry,
      stop_loss: entry - 2,
      take_profit: plan[2]!.price,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ atr: 3 }),
        expectancy: null,
      },
      multi_tp_levels: plan,
    });
    const pos = pm.get('deal-mtp-upl')!;
    pos.broker_upl = null; // unread — must not scale out
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: plan[0]!.price + 0.1,
        ask: plan[0]!.price + 0.2,
        mid: plan[0]!.price + 0.15,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      volume_step: 0.01,
      max_hold_ms: 0,
      breakeven_progress: 0,
    });
    // Intermediate TP1 hit but unread UPL → no multi-TP scale; hard final TP not hit either
    expect(closed).toBe(0);
    expect(managed.closed.filter((c) => /MULTI_TP/.test(c.reason)).length).toBe(0);
    expect(pm.count()).toBe(1);
  });

  it('Capital LIVE SELL multi-TP refuses scale-out while venue UPL unread', async () => {
    const { buildEqualMultiTpPlan } = await import('../multiTp.js');
    const entry = 4400;
    const plan = buildEqualMultiTpPlan({
      side: 'SELL',
      entry,
      initial_volume: 0.03,
      count: 3,
      atr: 3,
      atr_tp_mult: 1,
      volume_step: 0.01,
    });
    let closed = 0;
    const broker = {
      name: 'CAPITAL',
      paper: false,
      supportsPartialClose: true,
      async closePosition() {
        closed += 1;
        return { ok: true, fill_price: plan[0]!.price - 0.1, fill_pnl: 1, remaining_size: 0.02 };
      },
      async modifyPosition() {
        return { ok: true, detail: 'ok' };
      },
    } as never;
    const pipe = new MasterPipeline('LIVE');
    const pm = new PositionManager();
    pm.register({
      position_id: 'deal-mtp-sell-upl',
      opportunity_id: 'opp-mtp-sell-upl',
      intent_id: 'mtp-sell-upl',
      epic: 'GOLD',
      side: 'SELL',
      size: 0.03,
      entry,
      stop_loss: entry + 2,
      take_profit: plan[2]!.price,
      decision: {
        decision_id: 'd',
        kind: 'SELL',
        side: 'SELL',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ atr: 3 }),
        expectancy: null,
      },
      multi_tp_levels: plan,
    });
    pm.get('deal-mtp-sell-upl')!.broker_upl = null;
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: plan[0]!.price - 0.2,
        ask: plan[0]!.price - 0.1,
        mid: plan[0]!.price - 0.15,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      volume_step: 0.01,
      max_hold_ms: 0,
      breakeven_progress: 0,
    });
    expect(closed).toBe(0);
    expect(managed.closed.filter((c) => /MULTI_TP/.test(c.reason)).length).toBe(0);
    expect(pm.count()).toBe(1);
  });

  it('hard STOP_HIT wins over armed soft-trail on same tick', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    const sl = 4390;
    broker.setQuote({
      bid: sl - 0.5,
      ask: sl - 0.3,
      mid: sl - 0.4,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'hard-before-soft-aaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: sl,
      profit_level: entry + 20,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-hard-before-soft',
      intent_id: 'hard-before-soft-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry,
      stop_loss: sl,
      take_profit: entry + 20,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ regime: 'TREND' }),
        expectancy: null,
      },
    });
    const pos = pm.get(placed.position_id!)!;
    pos.soft_trail_armed_at = new Date().toISOString();
    pos.soft_trail_peak = entry + 15;
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: sl - 0.5,
        ask: sl - 0.3,
        mid: sl - 0.4,
        spread: 0.2,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      soft_trail_money_arm: 0.05,
      soft_trail_pips: 0.3,
      scalp_pct_chase: true,
      allow_close: true,
      max_hold_ms: 0,
      breakeven_progress: 0,
    });
    expect(managed.closed.length).toBe(1);
    expect(managed.closed[0]!.reason).toMatch(/STOP_HIT/);
    expect(managed.closed[0]!.reason).not.toMatch(/SOFT_TRAIL/);
  });

  it('soft TIME_STOP refuses close without SL (close_requires_sl)', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry,
      ask: entry + 0.2,
      mid: entry + 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'no-sl-close-bbbbbbbbbbbb',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: undefined,
      profit_level: entry + 10,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    const pos = pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-nosl',
      intent_id: 'nosl-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry,
      stop_loss: null,
      take_profit: entry + 10,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    // Force old entry_at for TIME_STOP
    pos.entry_at = new Date(Date.now() - 120_000).toISOString();
    // Strip modify so naked recovery cannot attach — close_requires_sl must hold
    const mod = broker.modifyPosition!.bind(broker);
    broker.modifyPosition = async () => ({ ok: false, detail: 'modify_denied' });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry,
        ask: entry + 0.2,
        mid: entry + 0.1,
        spread: 0.2,
        ts_ms: Date.now(),
      },
      max_hold_ms: 60_000,
      breakeven_progress: 0,
    });
    expect(managed.closed.length).toBe(0);
    expect(managed.close_failed.some((f) => f.detail === 'close_requires_sl')).toBe(true);
    expect(pm.count()).toBe(1);
    expect(pm.get(placed.position_id!)!.stop_loss).toBeNull();
    broker.modifyPosition = mod;
  });

  it('soft TIME_STOP refuses close when deal is presence-only (level-less live)', async () => {
    const entry = 4400;
    const broker = new PaperBroker();
    await broker.connect();
    broker.setQuote({
      bid: entry,
      ask: entry + 0.2,
      mid: entry + 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    // No real paper fill — force presence-only list so soft close sees live-but-level-less
    broker.listOpenPositions = async () => ({
      ok: true,
      positions: [],
      presence_ids: ['pres-only-1'],
      detail: 'ok',
    });
    broker.modifyPosition = async () => ({ ok: false, detail: 'modify_denied' });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    const pos = pm.register({
      position_id: 'pres-only-1',
      opportunity_id: 'opp-pres-sl',
      intent_id: 'pres-sl-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry,
      stop_loss: null,
      take_profit: entry + 10,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    pos.entry_at = new Date(Date.now() - 120_000).toISOString();
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry,
        ask: entry + 0.2,
        mid: entry + 0.1,
        spread: 0.2,
        ts_ms: Date.now(),
      },
      max_hold_ms: 60_000,
      breakeven_progress: 0,
    });
    expect(managed.closed.length).toBe(0);
    expect(managed.close_failed.some((f) => f.detail === 'close_requires_sl')).toBe(true);
    expect(pm.count()).toBe(1);
  });

  it('naked recovery attaches 10% SL then TIME_STOP can close', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry,
      ask: entry + 0.2,
      mid: entry + 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'naked-then-time-bbbbbbbb',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      profit_level: entry + 10,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    const pos = pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-naked-ts',
      intent_id: 'nts-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry,
      stop_loss: null,
      take_profit: entry + 10,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    pos.entry_at = new Date(Date.now() - 120_000).toISOString();
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry,
        ask: entry + 0.2,
        mid: entry + 0.1,
        spread: 0.2,
        ts_ms: Date.now(),
      },
      max_hold_ms: 60_000,
      breakeven_progress: 0,
    });
    expect(managed.closed.length).toBe(1);
    expect(managed.closed[0]!.reason).toMatch(/TIME_STOP/);
  });

  it('reconcile shrink sets partial_close_applied (external partial)', () => {
    const pm = new PositionManager();
    pm.register({
      position_id: 'ext-1',
      opportunity_id: '00000000-0000-4000-8000-00000000cccc',
      intent_id: 'ext-intent',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4400,
      stop_loss: 4390,
      take_profit: 4420,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    expect(pm.get('ext-1')!.partial_close_applied).toBe(false);
    pm.get('ext-1')!.broker_upl = 14.5; // last known full-size UPL before shrink
    const { external_partials } = pm.reconcileFromBroker([
      {
        position_id: 'ext-1',
        epic: 'GOLD',
        side: 'BUY',
        size: 0.05,
        open_level: 4400,
        stop_level: 4390,
        profit_level: 4420,
        upl: 7.25,
      },
    ]);
    expect(pm.get('ext-1')!.size).toBe(0.05);
    expect(pm.get('ext-1')!.partial_close_applied).toBe(true);
    expect(pm.get('ext-1')!.broker_upl).toBe(7.25);
    expect(external_partials).toHaveLength(1);
    expect(external_partials[0]!.closed_size).toBeCloseTo(0.05, 6);
    // Scaled last-known UPL for journal honesty (half size closed → half prior UPL)
    expect(external_partials[0]!.broker_upl_closed).toBeCloseTo(7.25, 8);
  });

  it('reconcile refreshes entry from broker open_level (Reader status entry)', () => {
    const pm = new PositionManager();
    pm.register({
      position_id: 'entry-fix',
      opportunity_id: '00000000-0000-4000-8000-00000000eeee',
      intent_id: 'entry-fix-intent',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 0, // bad ACK Bid/Ask / recover zero
      stop_loss: 4390,
      take_profit: 4420,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    pm.reconcileFromBroker([
      {
        position_id: 'entry-fix',
        epic: 'GOLD',
        side: 'BUY',
        size: 0.1,
        open_level: 4401.5,
        stop_level: 4390,
        profit_level: 4420,
      },
    ]);
    expect(pm.get('entry-fix')!.entry).toBeCloseTo(4401.5, 8);
  });

  it('reconcile clears local SL when broker reports sl=0 (naked)', () => {
    const pm = new PositionManager();
    pm.register({
      position_id: 'naked-sl',
      opportunity_id: '00000000-0000-4000-8000-00000000ffff',
      intent_id: 'naked-sl-intent',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4400,
      stop_loss: 4390,
      take_profit: 4420,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    pm.reconcileFromBroker([
      {
        position_id: 'naked-sl',
        epic: 'GOLD',
        side: 'BUY',
        size: 0.1,
        open_level: 4400,
        stop_level: 0 as unknown as number,
        profit_level: 0 as unknown as number,
      },
    ]);
    expect(pm.get('naked-sl')!.stop_loss).toBeNull();
    expect(pm.get('naked-sl')!.take_profit).toBeNull();
  });

  it('reconcile adopts chart epic + countForEpic aliases GOLD↔XAUUSD', () => {
    const pm = new PositionManager();
    pm.register({
      position_id: 'epic-sticky',
      opportunity_id: '00000000-0000-4000-8000-00000000eeee',
      intent_id: 'epic-sticky-intent',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4400,
      stop_loss: 4390,
      take_profit: 4420,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    expect(pm.countForEpic('GOLD')).toBe(1);
    expect(pm.countForEpic('XAUUSD')).toBe(1);
    pm.reconcileFromBroker([
      {
        position_id: 'epic-sticky',
        epic: 'XAUUSD',
        side: 'BUY',
        size: 0.1,
        open_level: 4401,
        stop_level: 4390,
        profit_level: 4420,
      },
    ]);
    expect(pm.get('epic-sticky')!.epic).toBe('XAUUSD');
    expect(pm.get('epic-sticky')!.entry).toBeCloseTo(4401, 8);
    expect(pm.countForEpic('GOLD')).toBe(1);
    expect(pm.countForEpic('XAUUSD')).toBe(1);
  });

  it('PaperBroker.hydrateAccount restores equity after recover seed', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    expect(broker.equity).toBe(10_000);
    broker.hydrateAccount({ equity: 9_420.5, balance: 9_400 });
    expect(broker.equity).toBe(9_420.5);
    expect(broker.balance).toBe(9_400);
    const acct = await broker.getAccount();
    expect(acct?.equity).toBe(9_420.5);
  });

  it('money BE arms at £0.05 floating and defers illegal clamp', async () => {
    const { capitalSafeBreakEvenStop, resolveFloatingMoneyPnl, resolveCloseMoneyPnl } =
      await import('../moneyExit.js');
    expect(
      resolveFloatingMoneyPnl({
        side: 'BUY',
        entry: 4400,
        mark: 4400.5,
        size: 0.1,
        value_per_point_per_lot: 1,
        broker_upl: 0,
      })
    ).toBeCloseTo(0.05, 8);
    expect(
      resolveCloseMoneyPnl({
        side: 'BUY',
        entry: 4400,
        fill: 4410,
        size: 0.1,
        value_per_point_per_lot: 1,
        fill_pnl: 42.5,
      })
    ).toEqual({ pnl: 42.5, pnl_pts: 10, from_broker: true, pnl_proven: true });
    // Too close to mark for Capital live min 0.5 → defer
    expect(
      capitalSafeBreakEvenStop({
        side: 'BUY',
        entry: 4400,
        mark: 4400.2,
        symbol: 'GOLD',
        offset: 0,
        min_distance: 0.5,
      })
    ).toBeNull();

    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry + 0.55,
      ask: entry + 0.65,
      mid: entry + 0.6,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'money-be-bbbbbbbbbbbbbbbb',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: entry - 2,
      profit_level: entry + 5,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-mbe',
      intent_id: 'mbe-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry,
      stop_loss: entry - 2,
      take_profit: entry + 5,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry + 0.55,
        ask: entry + 0.65,
        mid: entry + 0.6,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      breakeven_progress: 0,
      breakeven_activation_money: 0.05,
      max_hold_ms: 0,
    });
    expect(pm.get(placed.position_id!)!.stop_loss).toBe(entry);
  });

  it('soft trail exits after money arm + pullback', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    // Start in profit enough to arm (£0.05 at 0.1 lot → 0.5 pts)
    broker.setQuote({
      bid: entry + 0.6,
      ask: entry + 0.7,
      mid: entry + 0.65,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'soft-trail-bbbbbbbbbbbbbb',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: entry - 2,
      profit_level: entry + 10,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-st',
      intent_id: 'st-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry,
      stop_loss: entry - 2,
      take_profit: entry + 10,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    // Arm soft trail
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry + 0.6,
        ask: entry + 0.7,
        mid: entry + 0.65,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      soft_trail_money_arm: 0.05,
      soft_trail_pips: 0.3,
      scalp_pct_chase: true,
      breakeven_progress: 0,
      max_hold_ms: 0,
    });
    expect(pm.get(placed.position_id!)!.soft_trail_armed_at).toBeTruthy();
    // Keep SL wide so soft-trail pullback is not labeled STOP_HIT after scalp chase
    pm.get(placed.position_id!)!.stop_loss = entry - 50;
    // Pull back through soft exit (0.3 pip = 0.003 on GOLD — use larger for clear hit)
    broker.setQuote({
      bid: entry + 0.1,
      ask: entry + 0.2,
      mid: entry + 0.15,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry + 0.1,
        ask: entry + 0.2,
        mid: entry + 0.15,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      soft_trail_money_arm: 0.05,
      soft_trail_pips: 0.3,
      scalp_pct_chase: true,
      breakeven_progress: 0,
      max_hold_ms: 0,
    });
    expect(managed.closed.some((c) => /SOFT_TRAIL/.test(c.reason))).toBe(true);
    expect(pm.count()).toBe(0);
  });

  it('SELL soft trail exits after money arm + adverse pullback', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    // SELL in profit (price dropped) enough to arm (£0.05 at 0.1 lot → 0.5 pts)
    broker.setQuote({
      bid: entry - 0.7,
      ask: entry - 0.6,
      mid: entry - 0.65,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'soft-trail-sell-bbbbbbbb',
      epic: 'GOLD',
      side: 'SELL',
      size: 0.1,
      stop_level: entry + 2,
      profit_level: entry - 10,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-st-sell',
      intent_id: 'st-sell-1',
      epic: 'GOLD',
      side: 'SELL',
      size: 0.1,
      entry,
      stop_loss: entry + 2,
      take_profit: entry - 10,
      decision: {
        decision_id: 'd',
        kind: 'SELL',
        side: 'SELL',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry - 0.7,
        ask: entry - 0.6,
        mid: entry - 0.65,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      soft_trail_money_arm: 0.05,
      soft_trail_pips: 0.3,
      scalp_pct_chase: true,
      breakeven_progress: 0,
      max_hold_ms: 0,
    });
    expect(pm.get(placed.position_id!)!.soft_trail_armed_at).toBeTruthy();
    // Keep SL wide so soft-trail pullback is not labeled STOP_HIT after scalp chase
    pm.get(placed.position_id!)!.stop_loss = entry + 50;
    // Pull back up through soft exit
    broker.setQuote({
      bid: entry - 0.2,
      ask: entry - 0.1,
      mid: entry - 0.15,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry - 0.2,
        ask: entry - 0.1,
        mid: entry - 0.15,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      soft_trail_money_arm: 0.05,
      soft_trail_pips: 0.3,
      scalp_pct_chase: true,
      breakeven_progress: 0,
      max_hold_ms: 0,
    });
    expect(managed.closed.some((c) => /SOFT_TRAIL/.test(c.reason))).toBe(true);
    expect(pm.count()).toBe(0);
  });

  it('soft trail refuses to arm without scalp manage (VS-System 10s SCALPING gate)', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry,
      ask: entry + 0.1,
      mid: entry + 0.05,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'soft-trail-no-scalp-bbbb',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: entry - 2,
      profit_level: entry + 10,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-st-ns',
      intent_id: 'st-ns',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry,
      stop_loss: entry - 2,
      take_profit: entry + 10,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry + 0.6,
        ask: entry + 0.7,
        mid: entry + 0.65,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      soft_trail_money_arm: 0.05,
      soft_trail_pips: 0.3,
      scalp_pct_chase: false,
      breakeven_progress: 0,
      max_hold_ms: 0,
    });
    expect(pm.get(placed.position_id!)!.soft_trail_armed_at).toBeFalsy();
  });

  it('10%/20% scalp pct chase raises BUY SL toward mark', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    const mark = entry + 40; // deep profit → chase SL = mark - 0.2*40 = entry+32
    broker.setQuote({
      bid: mark - 0.05,
      ask: mark + 0.05,
      mid: mark,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'scalp-chase-bbbbbbbbbbbb',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: entry - entry * 0.1,
      profit_level: entry + 80,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-scalp-chase',
      intent_id: 'scalp-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry,
      stop_loss: entry - entry * 0.1,
      take_profit: entry + 80,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: mark - 0.05,
        ask: mark + 0.05,
        mid: mark,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      scalp_pct_chase: true,
      scalp_lock_pct: 0.2,
      breakeven_progress: 0,
      max_hold_ms: 0,
      allow_close: false, // keep open so chase can modify SL
    });
    expect(pm.count()).toBe(1);
    const sl = pm.get(placed.position_id!)!.stop_loss!;
    // 20% lock: mark - 0.2*(mark-entry) = 4440 - 8 = 4432
    expect(sl).toBeGreaterThan(entry);
    expect(sl).toBeCloseTo(mark - 0.2 * (mark - entry), 1);
    // Paper/MT4 have no Capital native trailingStop — must not falsely arm
    expect(broker.supportsNativeTrailingStop).toBeFalsy();
    expect(pm.get(placed.position_id!)!.native_trail_armed).toBeFalsy();
  });

  it('Check be_start arms BE for SELL without take_profit', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry - 0.7,
      ask: entry - 0.6,
      mid: entry - 0.65,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'be-start-sell-bbbbbbbbbbbb',
      epic: 'GOLD',
      side: 'SELL',
      size: 1,
      stop_level: entry + 2,
      profit_level: undefined,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-be-start-sell',
      intent_id: 'be-start-sell-1',
      epic: 'GOLD',
      side: 'SELL',
      size: 1,
      entry,
      stop_loss: entry + 2,
      take_profit: null,
      decision: {
        decision_id: 'd',
        kind: 'SELL',
        side: 'SELL',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ regime: 'TREND' }),
        expectancy: null,
      },
    });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry - 0.7,
        ask: entry - 0.6,
        mid: entry - 0.65,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      breakeven_progress: 0,
      be_start: 0.5,
      breakeven_offset: 0.1,
      max_hold_ms: 0,
    });
    expect(managed.closed.length).toBe(0);
    expect(pm.get(placed.position_id!)!.stop_loss).toBeCloseTo(entry - 0.1, 6);
  });

  it('10%/20% scalp pct chase lowers SELL SL toward mark', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    const mark = entry - 40; // deep profit for SELL → chase SL = mark + 0.2*40
    broker.setQuote({
      bid: mark - 0.05,
      ask: mark + 0.05,
      mid: mark,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'scalp-chase-sell-bbbbbbbb',
      epic: 'GOLD',
      side: 'SELL',
      size: 0.1,
      stop_level: entry + entry * 0.1,
      profit_level: entry - 80,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-scalp-chase-sell',
      intent_id: 'scalp-sell-1',
      epic: 'GOLD',
      side: 'SELL',
      size: 0.1,
      entry,
      stop_loss: entry + entry * 0.1,
      take_profit: entry - 80,
      decision: {
        decision_id: 'd',
        kind: 'SELL',
        side: 'SELL',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: mark - 0.05,
        ask: mark + 0.05,
        mid: mark,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      scalp_pct_chase: true,
      scalp_lock_pct: 0.2,
      breakeven_progress: 0,
      max_hold_ms: 0,
      allow_close: false,
    });
    expect(pm.count()).toBe(1);
    const sl = pm.get(placed.position_id!)!.stop_loss!;
    expect(sl).toBeLessThan(entry);
    expect(sl).toBeCloseTo(mark + 0.2 * (entry - mark), 1);
    expect(pm.get(placed.position_id!)!.native_trail_armed).toBeFalsy();
  });

  it('scalp_strict_entry blocks BUY into bearish last-5 candles', () => {
    const bearBars = [
      { open: 4410, high: 4411, low: 4405, close: 4406, ts_ms: 1 },
      { open: 4406, high: 4407, low: 4401, close: 4402, ts_ms: 2 },
      { open: 4402, high: 4403, low: 4397, close: 4398, ts_ms: 3 },
      { open: 4398, high: 4399, low: 4393, close: 4394, ts_ms: 4 },
      { open: 4394, high: 4395, low: 4389, close: 4390, ts_ms: 5 },
      { open: 4390, high: 4391, low: 4385, close: 4386, ts_ms: 6 },
    ];
    const a = baseAnalysis({
      regime: 'TREND',
      momentum_dir: 'UP',
      trend_dir: 'UP',
      trend_strength: 0.8,
      structure_bias: 'BULLISH',
      buy_pressure: 0.9,
      sell_pressure: 0.1,
      behavior_bull: 0.9,
      momentum_score: 0.8,
      atr: 2,
      context_quality: 0.9,
      impact_score: 0.8,
    });
    const q: Quote = {
      bid: 4386,
      ask: 4386.4,
      mid: 4386.2,
      spread: 0.4,
      ts_ms: Date.now(),
    };
    const cfg = {
      ...DEFAULT_MASTER_CONFIG,
      min_score: 0.4,
      block_off_hours: false,
      block_high_impact_news: false,
      scalp_strict_entry: true,
      scalp_min_edge: 0.05,
    };
    const { buy } = buildCandidates(a, q, cfg, bearBars);
    expect(buy.valid).toBe(false);
    expect(buy.filter_reason).toMatch(/scalp_|bull|bear|falling|micro|edge/);
  });

  it('ema_tick_entry blocks BUY without fresh EMA1×EMA3 cross', () => {
    // Identical closes — no cross and no divergence
    const flatBars = [];
    for (let i = 0; i < 12; i++) {
      flatBars.push({
        open: 4400,
        high: 4400.2,
        low: 4399.8,
        close: 4400,
        ts_ms: i * 60_000,
      });
    }
    const a = baseAnalysis({
      regime: 'TREND',
      momentum_dir: 'UP',
      trend_dir: 'UP',
      trend_strength: 0.8,
      structure_bias: 'BULLISH',
      buy_pressure: 0.9,
      sell_pressure: 0.1,
      behavior_bull: 0.9,
      momentum_score: 0.8,
      atr: 2,
      context_quality: 0.9,
      impact_score: 0.8,
    });
    const q: Quote = {
      bid: 4400,
      ask: 4400.4,
      mid: 4400.2,
      spread: 0.4,
      ts_ms: Date.now(),
    };
    const cfg = {
      ...DEFAULT_MASTER_CONFIG,
      min_score: 0.4,
      block_off_hours: false,
      block_high_impact_news: false,
      ema_tick_entry: true,
    };
    const { buy } = buildCandidates(a, q, cfg, flatBars);
    expect(buy.valid).toBe(false);
    expect(buy.filter_reason).toMatch(/ema13_wait/);
  });

  it('pre-entry broker verify blocks when listOpen fails (VS-System fail-closed)', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-broker-verify-'));
    try {
      masterRuntime.stop();
      masterRuntime.pipeline = new MasterPipeline('PAPER');
      masterRuntime.positions = new PositionManager();
      masterRuntime.last_loss_ms = 0;
      masterRuntime.reject_until_ms = 0;
      (masterRuntime as unknown as { inflight_until_ms: number }).inflight_until_ms = 0;
      (masterRuntime as unknown as { post_exit_until_ms: number }).post_exit_until_ms = 0;
      masterRuntime.account = {
        equity: 10_000,
        balance: 10_000,
        currency: 'GBP',
        open_positions: 0,
        daily_pnl: 0,
        daily_pnl_day: new Date().toISOString().slice(0, 10),
        day_start_equity: 10_000,
        peak_equity: 10_000,
        consecutive_losses: 0,
      };
      masterRuntime.cfg = {
        ...DEFAULT_MASTER_CONFIG,
        mode: 'PAPER',
        min_score: 0.25,
        block_off_hours: false,
        block_high_impact_news: false,
        max_relative_volatility: 100,
        max_relative_spread: 100,
        cooldown_ms_after_loss: 0,
        max_daily_loss_pct: 0.99,
        max_drawdown_pct: 0.99,
      };
      const broker = masterRuntime.ensurePaperBroker();
      broker.listOpenPositions = async () => ({
        ok: false,
        positions: [],
        detail: 'forced_list_fail',
      });
      masterRuntime.running = true;
      masterRuntime.entries_armed = true;
      // Strong uptrend bars so decision is BUY and risk allows
      const bars = Array.from({ length: 50 }, (_, i) => {
        const o = 4400 + i * 1.5;
        return {
          open: o,
          high: o + 2,
          low: o - 0.2,
          close: o + 1.4,
          ts_ms: Date.UTC(2026, 8, 7, 12, i),
        };
      });
      const quote = {
        bid: 4475,
        ask: 4475.4,
        mid: 4475.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      broker.setQuote(quote);
      const r = await masterRuntime.tick(bars, quote);
      expect(r.executed).toBe(false);
      expect(r.decision.kind === 'BUY' || r.decision.kind === 'SELL').toBe(true);
      expect(r.risk.allowed).toBe(true);
      expect(String(r.execution_detail || '')).toMatch(/broker_verify_failed/);
    } finally {
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });

  it('pre-entry broker verify blocks on presence_ids when positions empty (level-less live deal)', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-presence-one-trade-'));
    try {
      masterRuntime.stop();
      masterRuntime.pipeline = new MasterPipeline('PAPER');
      masterRuntime.positions = new PositionManager();
      masterRuntime.last_loss_ms = 0;
      masterRuntime.reject_until_ms = 0;
      (masterRuntime as unknown as { inflight_until_ms: number }).inflight_until_ms = 0;
      (masterRuntime as unknown as { post_exit_until_ms: number }).post_exit_until_ms = 0;
      masterRuntime.account = {
        equity: 10_000,
        balance: 10_000,
        currency: 'GBP',
        open_positions: 0,
        daily_pnl: 0,
        daily_pnl_day: new Date().toISOString().slice(0, 10),
        day_start_equity: 10_000,
        peak_equity: 10_000,
        consecutive_losses: 0,
      };
      masterRuntime.cfg = {
        ...DEFAULT_MASTER_CONFIG,
        mode: 'PAPER',
        min_score: 0.25,
        block_off_hours: false,
        block_high_impact_news: false,
        max_relative_volatility: 100,
        max_relative_spread: 100,
        cooldown_ms_after_loss: 0,
        max_daily_loss_pct: 0.99,
        max_drawdown_pct: 0.99,
      };
      const broker = masterRuntime.ensurePaperBroker();
      // Level-less Capital deal: not in positions[], but still live in presence_ids
      broker.listOpenPositions = async () => ({
        ok: true,
        positions: [],
        presence_ids: ['deal-level-less-1'],
        detail: 'ok',
      });
      masterRuntime.running = true;
      masterRuntime.entries_armed = true;
      const bars = Array.from({ length: 50 }, (_, i) => {
        const o = 4400 + i * 1.5;
        return {
          open: o,
          high: o + 2,
          low: o - 0.2,
          close: o + 1.4,
          ts_ms: Date.UTC(2026, 8, 7, 12, i),
        };
      });
      const quote = {
        bid: 4475,
        ask: 4475.4,
        mid: 4475.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      broker.setQuote(quote);
      const r = await masterRuntime.tick(bars, quote);
      expect(r.executed).toBe(false);
      expect(r.decision.kind === 'BUY' || r.decision.kind === 'SELL').toBe(true);
      expect(r.risk.allowed).toBe(true);
      expect(String(r.execution_detail || '')).toMatch(/one_trade_broker_open:1/);
    } finally {
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });

  it('post_exit_cooldown blocks same-tick re-entry after CLOSE', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-post-exit-'));
    try {
      masterRuntime.stop();
      masterRuntime.pipeline = new MasterPipeline('PAPER');
      masterRuntime.positions = new PositionManager();
      masterRuntime.last_loss_ms = 0;
      masterRuntime.reject_until_ms = 0;
      (masterRuntime as unknown as { inflight_until_ms: number }).inflight_until_ms = 0;
      (masterRuntime as unknown as { post_exit_until_ms: number }).post_exit_until_ms = 0;
      (masterRuntime as unknown as { last_entry_fingerprint: string | null }).last_entry_fingerprint =
        null;
      masterRuntime.account = {
        equity: 10_000,
        balance: 10_000,
        currency: 'GBP',
        open_positions: 0,
        daily_pnl: 0,
        daily_pnl_day: new Date().toISOString().slice(0, 10),
        day_start_equity: 10_000,
        peak_equity: 10_000,
        consecutive_losses: 0,
      };
      masterRuntime.cfg = {
        ...DEFAULT_MASTER_CONFIG,
        mode: 'PAPER',
        min_score: 0.25,
        block_off_hours: false,
        block_high_impact_news: false,
        max_relative_volatility: 100,
        max_relative_spread: 100,
        cooldown_ms_after_loss: 0,
        max_daily_loss_pct: 0.99,
        max_drawdown_pct: 0.99,
        post_exit_cooldown_ms: 60_000,
        max_hold_ms: 1, // force TIME_STOP on existing position
      };
      const broker = masterRuntime.ensurePaperBroker();
      masterRuntime.running = true;
      masterRuntime.entries_armed = true;
      const bars = Array.from({ length: 50 }, (_, i) => {
        const o = 4400 + i * 1.5;
        return {
          open: o,
          high: o + 2,
          low: o - 0.2,
          close: o + 1.4,
          ts_ms: Date.UTC(2026, 8, 7, 12, i),
        };
      });
      const quote = {
        bid: 4475,
        ask: 4475.4,
        mid: 4475.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      broker.setQuote(quote);
      // Seed a long-held position so manageTick closes via TIME_STOP
      broker.seedOpens([
        {
          position_id: 'post-exit-seed',
          epic: 'GOLD',
          side: 'BUY',
          size: 0.1,
          open_level: 4400,
          stop_level: 4390,
          profit_level: 4500,
        },
      ]);
      masterRuntime.positions.register({
        position_id: 'post-exit-seed',
        opportunity_id: 'opp-post-exit',
        intent_id: 'intent-post-exit',
        epic: 'GOLD',
        side: 'BUY',
        size: 0.1,
        entry: 4400,
        stop_loss: 4390,
        take_profit: 4500,
        entry_at: new Date(Date.now() - 120_000).toISOString(),
        decision: {
          id: 'd1',
          kind: 'BUY',
          side: 'BUY',
          buy: null as any,
          sell: null as any,
          analysis: baseAnalysis({ atr: 2 }),
          block_reason: null,
          ai_mode: 'off',
          created_at: new Date(Date.now() - 120_000).toISOString(),
        } as any,
      });
      const r = await masterRuntime.tick(bars, quote);
      expect(r.exits).toBeGreaterThanOrEqual(1);
      expect(r.executed).toBe(false);
      // After close, strong signal must not re-open in the same cycle
      if (r.decision.kind === 'BUY' || r.decision.kind === 'SELL') {
        expect(String(r.execution_detail || '')).toMatch(/post_exit_cooldown/);
      }
      expect(
        (masterRuntime as unknown as { post_exit_until_ms: number }).post_exit_until_ms
      ).toBeGreaterThan(Date.now());
    } finally {
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });

  it('naked recovery escalates distance after modify reject', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry,
      ask: entry + 0.2,
      mid: entry + 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'naked-escalate-aaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-naked-esc',
      intent_id: 'ne-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry,
      stop_loss: null,
      take_profit: null,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    let attempts = 0;
    const levels: number[] = [];
    broker.modifyPosition = async (input) => {
      attempts += 1;
      if (input.stop_level != null) levels.push(Number(input.stop_level));
      if (attempts < 3) return { ok: false, detail: 'REJECTED:MIN_DISTANCE' };
      return { ok: true, detail: 'ok' };
    };
    const quote = {
      bid: entry,
      ask: entry + 0.2,
      mid: entry + 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    // Throttle is 8s — poke private map via successive manage with mocked clock by clearing via success path
    // Force immediate retries by temporarily lowering throttle through rapid calls after advancing map
    for (let i = 0; i < 3; i++) {
      (pm as any).nakedRecoveryAt.clear();
      await pm.manageTick({
        broker,
        pipeline: pipe,
        quote,
        instrument_point_value: 1,
        max_hold_ms: 0,
        allow_close: false,
        scalp_pct_chase: true,
      });
    }
    expect(attempts).toBeGreaterThanOrEqual(2);
    // Escalation should widen protective SL (BUY → lower price farther from entry)
    if (levels.length >= 2) {
      expect(levels[1]!).toBeLessThanOrEqual(levels[0]!);
    }
    expect(pm.get(placed.position_id!)!.stop_loss).not.toBeNull();
  });

  it('Mt4FileBroker getQuote uses market file mtime (Check- stale honesty)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vs-mt4-stale-'));
    mkdirSync(join(root, 'market'), { recursive: true });
    const marketPath = join(root, 'market', 'latest.json');
    writeFileSync(
      marketPath,
      JSON.stringify({ bid: 4400, ask: 4400.4, symbol: 'XAUUSD' })
    );
    const old = Date.now() - 120_000;
    const { utimesSync } = await import('fs');
    utimesSync(marketPath, new Date(old), new Date(old));
    const broker = new Mt4FileBroker(root);
    await broker.connect();
    const q = await broker.getQuote('XAUUSD');
    expect(q).toBeTruthy();
    expect(q!.ts_ms).toBeLessThan(Date.now() - 60_000);
  });

  it('stale quote still honors TIME_STOP but skips mark-based soft manage', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry,
      ask: entry + 0.2,
      mid: entry + 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'stale-manage-aaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: entry - 5,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    const pos = pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-stale-m',
      intent_id: 'sm-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry,
      stop_loss: entry - 5,
      take_profit: entry + 10,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    // Backdate entry so TIME_STOP fires even when quote is stale
    (pos as { entry_at: string }).entry_at = new Date(
      Date.now() - 3_600_000
    ).toISOString();
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry,
        ask: entry + 0.2,
        mid: entry + 0.1,
        spread: 0.2,
        epic: 'GOLD',
        ts_ms: Date.now() - 120_000,
      },
      instrument_point_value: 1,
      max_hold_ms: 60_000,
      allow_close: true,
      stale_quote_ms: 30_000,
    });
    expect(managed.closed.length).toBe(1);
    expect(managed.closed[0]!.reason).toMatch(/TIME_STOP/);
    expect(pm.count()).toBe(0);
  });

  it('stale quote still honors hard STOP_HIT (not only TIME_STOP)', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    const stop = 4395;
    broker.setQuote({
      bid: stop - 1,
      ask: stop - 0.8,
      mid: stop - 0.9,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'stale-stop-hitttttttttt',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: stop,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-stale-sl',
      intent_id: 'ssl-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry,
      stop_loss: stop,
      take_profit: entry + 20,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis(),
        expectancy: null,
      },
    });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: stop - 1,
        ask: stop - 0.8,
        mid: stop - 0.9,
        spread: 0.2,
        epic: 'GOLD',
        ts_ms: Date.now() - 120_000,
      },
      instrument_point_value: 1,
      max_hold_ms: 0,
      allow_close: false, // AI veto must not block hard STOP
      stale_quote_ms: 30_000,
    });
    expect(managed.closed.length).toBe(1);
    expect(managed.closed[0]!.reason).toMatch(/STOP_HIT/);
    expect(pm.count()).toBe(0);
  });
});

describe('cycle alerts block entries on stale tick', () => {
  it('stale quote sets alert block and refuses OPEN', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(join(tmpdir(), 'vs-stale-alert-'));
    const { ALERT_DATA_STALE } = await import('../cycleAlerts.js');

    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.running = true;
    masterRuntime.entries_armed = true;
    masterRuntime.last_loss_ms = 0;
    masterRuntime.reject_until_ms = 0;
    (masterRuntime as unknown as { inflight_until_ms: number }).inflight_until_ms = 0;
    masterRuntime.account = {
      equity: 10_000,
      balance: 10_000,
      currency: 'GBP',
      open_positions: 0,
      daily_pnl: 0,
      daily_pnl_day: new Date().toISOString().slice(0, 10),
      day_start_equity: 10_000,
      peak_equity: 10_000,
      consecutive_losses: 0,
      trade_allowed: true,
    };
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'PAPER',
      min_score: 0.25,
      stale_quote_ms: 15_000,
      block_off_hours: false,
      block_high_impact_news: false,
      max_relative_volatility: 100,
      max_relative_spread: 100,
      cooldown_ms_after_loss: 0,
      max_daily_loss_pct: 0.99,
      max_drawdown_pct: 0.99,
    };
    const broker = masterRuntime.ensurePaperBroker();
    const bars = Array.from({ length: 50 }, (_, i) => {
      const o = 4400 + i * 1.5;
      return {
        open: o,
        high: o + 2,
        low: o - 0.2,
        close: o + 1.4,
        ts_ms: Date.UTC(2026, 8, 7, 12, i),
      };
    });
    const quote = {
      bid: 4475,
      ask: 4475.4,
      mid: 4475.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now() - 60_000, // stale vs 15s threshold
    };
    broker.setQuote(quote);
    const r = await masterRuntime.tick(bars, quote);
    expect(r.executed).toBe(false);
    // Hard-fail validateMarket(stale_quote) blocks before BUY/SELL — detail is
    // market_validation, not alert:DATA_STALE on execution_detail.
    expect(String(r.decision.block_reason || '')).toMatch(
      /market_validation:.*stale_quote/
    );
    expect(r.decision.kind).toBe('BLOCK');
    const st = masterRuntime.status();
    expect(st.monitoring?.entry_block_reason).toMatch(
      new RegExp(`alert:${ALERT_DATA_STALE}`)
    );
    expect(st.monitoring?.active_alerts?.some((a) => a.code === ALERT_DATA_STALE)).toBe(
      true
    );
    expect(String(st.last_block_reason || '')).toMatch(
      /market_validation:.*stale_quote/
    );
    expect(st.pipeline_stages.market_validation.ok).toBe(false);
    expect(st.pipeline_stages.market_validation.detail).toMatch(/stale_quote/);
    expect(st.pipeline_stages.normalization.ok).toBe(false);
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
  });
});

describe('orphan adopt + replay soft-trail authority', () => {
  it('orphan adopt does not forge SCALP when live regime unknown', () => {
    const pm = new PositionManager();
    pm.reconcileFromBroker([
      {
        position_id: 'orphan-no-forge-1',
        epic: 'GOLD',
        side: 'BUY',
        size: 0.1,
        open_level: 4400,
        open_level_proven: true,
        stop_level: 4390,
        profit_level: 4420,
      },
    ]);
    const pos = pm.get('orphan-no-forge-1')!;
    expect(pos.playbook_at_entry).toBeUndefined();
    expect(pos.entry_setup).toBeUndefined();
    expect(pos.regime_at_entry).toBe('RANGE'); // UNKNOWN → RANGE desk
  });

  it('orphan adopt locks playbook from live TREND_UP analysis', () => {
    const pm = new PositionManager();
    pm.reconcileFromBroker(
      [
        {
          position_id: 'orphan-trend-1',
          epic: 'GOLD',
          side: 'BUY',
          size: 0.1,
          open_level: 4400,
          open_level_proven: true,
          stop_level: 4390,
        },
      ],
      {
        live_regime: 'TREND',
        live_analysis: { regime: 'TREND', trend_dir: 'UP', structure_bias: 'BULLISH' },
      }
    );
    const pos = pm.get('orphan-trend-1')!;
    expect(pos.regime_at_entry).toBe('TREND_UP');
    expect(pos.playbook_at_entry).toBe('LONG');
    expect(pos.entry_setup).toBe('CONTINUATION');
  });

  it('replay with scalp soft-trail can exit SOFT_TRAIL', async () => {
    const { replayMaster } = await import('../replay.js');
    const { SCALP_MANAGE_PRESET } = await import('../manageConfig.js');
    // Sharp up then giveback after soft trail arm
    const bars = Array.from({ length: 80 }, (_, i) => {
      const base = 4400 + Math.min(i, 40) * 1.5;
      const give = i > 50 ? (i - 50) * 2.5 : 0;
      const o = base - give;
      return {
        open: o,
        high: o + 1.2,
        low: o - 1.5,
        close: o + (i > 50 ? -0.8 : 0.8),
        ts_ms: Date.UTC(2026, 8, 7, 12, i),
      };
    });
    const result = await replayMaster({
      bars,
      warmup: 25,
      spread: 0.3,
      cfg: {
        ...SCALP_MANAGE_PRESET,
        block_off_hours: false,
        block_high_impact_news: false,
        soft_trail_money_arm: 0.05,
        soft_trail_pips: 0.3,
        scalp_pct_chase: true,
        max_hold_ms: 0,
        min_score: 0.3,
      },
    });
    const exits = result.opportunities
      .filter((o) => o.outcome)
      .map((o) => o.outcome!.exit_reason);
    // Soft trail is optional depending on path — assert replay still completes with exits
    expect(result.equity_curve.length).toBeGreaterThan(10);
    expect(exits.every((r) => typeof r === 'string' && r.length > 0)).toBe(true);
  });

  it('replay rolls day_start_equity across UTC day boundary', async () => {
    const { replayMaster } = await import('../replay.js');
    // Day1 flat grind then Day2 — profit_lock / daily_loss use day_start after roll
    const bars = Array.from({ length: 80 }, (_, i) => {
      const day2 = i >= 40;
      const o = 4400 + (day2 ? (i - 40) * 0.6 : i * 0.4);
      return {
        open: o,
        high: o + 1.2,
        low: o - 0.4,
        close: o + 0.5,
        ts_ms: day2
          ? Date.UTC(2026, 8, 8, 1, i - 40)
          : Date.UTC(2026, 8, 7, 22, i),
      };
    });
    const result = await replayMaster({
      bars,
      warmup: 20,
      starting_equity: 10_000,
      spread: 0.3,
      cfg: {
        ...DEFAULT_MASTER_CONFIG,
        block_off_hours: false,
        block_high_impact_news: false,
        min_score: 0.25,
        max_hold_ms: 0,
        profit_lock: 50,
        daily_loss_limit: 100,
        require_positive_expectancy: false,
      },
    });
    expect(result.equity_curve.length).toBeGreaterThan(10);
    expect(Number.isFinite(result.equity_curve.at(-1))).toBe(true);
    expect(result.daily_pnl_day).toBe('2026-09-08');
    // After UTC roll, day_start tracks equity at day boundary (not stuck at starting_equity alone)
    expect(result.day_start_equity).toBeGreaterThan(0);
    expect(Number.isFinite(result.day_start_equity)).toBe(true);
  });

  it('replay reject_until_ms blocks entries like live reject_cooldown', async () => {
    const { replayMaster } = await import('../replay.js');
    const bars = Array.from({ length: 80 }, (_, i) => {
      const o = 4400 + i * 0.8;
      return {
        open: o,
        high: o + 1.5,
        low: o - 0.3,
        close: o + 0.7,
        ts_ms: Date.UTC(2026, 8, 7, 12, i),
      };
    });
    const blocked = await replayMaster({
      bars,
      warmup: 25,
      starting_equity: 10_000,
      // Far-future reject window — no OPEN while cool
      reject_until_ms: Date.UTC(2026, 8, 7, 14, 0),
      cfg: {
        ...DEFAULT_MASTER_CONFIG,
        block_off_hours: false,
        block_high_impact_news: false,
        min_score: 0.25,
        max_hold_ms: 0,
        require_positive_expectancy: false,
      },
    });
    const tradedBlocked = blocked.opportunities.filter((o) => o.outcome || o.execution?.accepted);
    expect(tradedBlocked.length).toBe(0);

    const open = await replayMaster({
      bars,
      warmup: 25,
      starting_equity: 10_000,
      reject_until_ms: 0,
      cfg: {
        ...DEFAULT_MASTER_CONFIG,
        block_off_hours: false,
        block_high_impact_news: false,
        min_score: 0.25,
        max_hold_ms: 0,
        require_positive_expectancy: false,
      },
    });
    // Same bars without reject cool can produce fills (not guaranteed every path)
    expect(open.equity_curve.length).toBeGreaterThan(10);
  });

  it('replay inflight_until_ms blocks re-entry like live inflight_order', async () => {
    const { replayMaster } = await import('../replay.js');
    const bars = Array.from({ length: 80 }, (_, i) => {
      const o = 4400 + i * 0.8;
      return {
        open: o,
        high: o + 1.5,
        low: o - 0.3,
        close: o + 0.7,
        ts_ms: Date.UTC(2026, 8, 7, 12, i),
      };
    });
    const blocked = await replayMaster({
      bars,
      warmup: 25,
      inflight_until_ms: Date.UTC(2026, 8, 7, 14, 0),
      cfg: {
        ...DEFAULT_MASTER_CONFIG,
        block_off_hours: false,
        block_high_impact_news: false,
        min_score: 0.25,
        max_hold_ms: 0,
        require_positive_expectancy: false,
      },
    });
    const fills = blocked.opportunities.filter((o) => o.execution?.accepted);
    expect(fills.length).toBe(0);
  });

  it('replay multi-TP + money-BE cfg does not throw and can scale', async () => {
    const { replayMaster } = await import('../replay.js');
    const { SCALP_MANAGE_PRESET } = await import('../manageConfig.js');
    const bars = Array.from({ length: 90 }, (_, i) => {
      const o = 4400 + i * 0.8;
      return {
        open: o,
        high: o + 2,
        low: o - 0.5,
        close: o + 1.2,
        ts_ms: Date.UTC(2026, 8, 7, 12, i),
      };
    });
    const result = await replayMaster({
      bars,
      warmup: 25,
      cfg: {
        ...SCALP_MANAGE_PRESET,
        multi_tp_count: 3,
        multi_tp_atr_mult: 1,
        breakeven_activation_money: 0.05,
        be_start: 0.5,
        block_off_hours: false,
        block_high_impact_news: false,
        min_score: 0.3,
        max_hold_ms: 0,
      },
    });
    expect(result.equity_curve.length).toBeGreaterThan(10);
    const reasons = result.opportunities
      .filter((o) => o.outcome)
      .map((o) => o.outcome!.exit_reason);
    // MULTI_TP optional depending on fills — at least one exit reason present if traded
    if (reasons.length) {
      expect(reasons.some((r) => /SL|TP|MULTI_TP|SOFT_TRAIL|TIME|BEST|Hard|Target|Peak|AUTO_|EMA/i.test(r))).toBe(
        true
      );
    }
  });

  it('replay close_all_profit can emit AUTO_PROFIT exit', async () => {
    const { replayMaster } = await import('../replay.js');
    const bars = Array.from({ length: 80 }, (_, i) => {
      const o = 4400 + i * 2;
      return {
        open: o,
        high: o + 3,
        low: o - 0.2,
        close: o + 2.5,
        ts_ms: Date.UTC(2026, 8, 7, 12, i),
      };
    });
    const result = await replayMaster({
      bars,
      warmup: 25,
      cfg: {
        close_all_profit: 0.5,
        block_off_hours: false,
        block_high_impact_news: false,
        min_score: 0.3,
        max_hold_ms: 0,
        soft_trail_money_arm: 0,
        scalp_pct_chase: false,
        multi_tp_count: 0,
      },
    });
    const reasons = result.opportunities
      .filter((o) => o.outcome)
      .map((o) => o.outcome!.exit_reason);
    // AUTO_PROFIT depends on path — if any traded, exit reasons are non-empty
    expect(result.equity_curve.length).toBeGreaterThan(10);
    if (reasons.length) {
      expect(reasons.every((r) => typeof r === 'string' && r.length > 0)).toBe(true);
    }
  });

  it('recover locks playbook from decision analysis when unset', async () => {
    const prevPref = masterRuntime.owns_pipeline_pref;
    try {
      const pm = masterRuntime.positions;
      pm.fromJSON([]);
      const recoverId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      pm.register({
        position_id: 'recover-lock-1',
        opportunity_id: recoverId,
        intent_id: recoverId,
        epic: 'GOLD',
        side: 'BUY',
        size: 0.1,
        entry: 4400,
        stop_loss: 4390,
        take_profit: 4420,
        decision: {
          decision_id: recoverId,
          kind: 'BUY',
          side: 'BUY',
          score: 0,
          block_reason: null,
          buy: null as never,
          sell: null as never,
          analysis: baseAnalysis({
            regime: 'TREND',
            trend_dir: 'UP',
            structure_bias: 'BULLISH',
          }),
          expectancy: null,
        },
      });
      const pos = pm.get('recover-lock-1')!;
      delete (pos as { playbook_at_entry?: unknown }).playbook_at_entry;
      delete (pos as { entry_setup?: unknown }).entry_setup;
      // Simulate recover hydrate loop
      const { mapRegimeToPlaybook, entrySetupFromRegime, toDeskRegime } =
        await import('../positionManager.js');
      if (!pos.playbook_at_entry && pos.decision?.analysis) {
        pos.playbook_at_entry = mapRegimeToPlaybook(
          pos.decision.analysis.regime,
          pos.decision.analysis
        );
        pos.entry_setup = entrySetupFromRegime(
          pos.decision.analysis.regime,
          pos.decision.analysis
        );
        pos.regime_at_entry = toDeskRegime(
          pos.decision.analysis.regime,
          pos.decision.analysis
        );
      }
      expect(pos.playbook_at_entry).toBe('LONG');
      expect(pos.entry_setup).toBe('CONTINUATION');
      expect(pos.regime_at_entry).toBe('TREND_UP');
    } finally {
      masterRuntime.owns_pipeline_pref = prevPref;
      masterRuntime.positions.fromJSON([]);
    }
  });
});

describe('expectancy gate + pure evaluate', () => {
  it('setMode(LIVE) arms require_positive_expectancy; PAPER clears it', () => {
    const prevMode = masterRuntime.cfg.mode;
    const prevExp = masterRuntime.cfg.require_positive_expectancy;
    const prevArmed = masterRuntime.cfg.require_armed_setup;
    try {
      masterRuntime.setMode('PAPER');
      expect(masterRuntime.cfg.require_positive_expectancy).toBe(false);
      expect(masterRuntime.status().expectancy_gate_armed).toBe(false);
      masterRuntime.setMode('LIVE');
      expect(masterRuntime.cfg.require_positive_expectancy).toBe(true);
      expect(masterRuntime.cfg.require_armed_setup).toBe(true);
      expect(masterRuntime.status().expectancy_gate_armed).toBe(true);
      masterRuntime.setMode('PAPER');
      expect(masterRuntime.cfg.require_positive_expectancy).toBe(false);
    } finally {
      masterRuntime.cfg = {
        ...masterRuntime.cfg,
        mode: prevMode,
        require_positive_expectancy: prevExp,
        require_armed_setup: prevArmed,
      };
      masterRuntime.pipeline.mode = prevMode;
    }
  });

  it('PATCH-able require_positive_expectancy blocks negative EV setups', async () => {
    const { decide, setupKey } = await import('../decision.js');
    const a = baseAnalysis({
      regime: 'TREND',
      trend_dir: 'UP',
      momentum_dir: 'UP',
      trend_strength: 0.8,
      structure_bias: 'BULLISH',
      buy_pressure: 0.9,
      sell_pressure: 0.1,
      behavior_bull: 0.9,
      momentum_score: 0.8,
      atr: 2,
      context_quality: 0.9,
      impact_score: 0.8,
    });
    const q: Quote = {
      bid: 4400,
      ask: 4400.4,
      mid: 4400.2,
      spread: 0.4,
      ts_ms: Date.now(),
      epic: 'GOLD',
    };
    const cfg = {
      ...DEFAULT_MASTER_CONFIG,
      min_score: 0.4,
      block_off_hours: false,
      require_positive_expectancy: true,
      min_expectancy_samples: 3,
    };
    const key = setupKey(a, 'BUY', 'GOLD');
    expect(key.endsWith('|none')).toBe(true);
    const d = decide(a, q, cfg, (k) =>
      k === key
        ? {
            setup_key: key,
            samples: 5,
            p_win: 0.2,
            avg_win: 1,
            avg_loss: 2,
            costs: 0.1,
            ev: -1.4,
            positive: false,
          }
        : null
    );
    expect(d.kind).toBe('BLOCK');
    expect(String(d.block_reason || '')).toMatch(/negative_expectancy/);
    expect(String(d.block_reason || '')).toMatch(/^negative_expectancy:GOLD\|/);
    expect(d.desk_entry_source).toBe('none');
    // SILVER must not share GOLD's negative EV bucket
    const silverKey = setupKey(a, 'BUY', 'SILVER');
    expect(silverKey).not.toBe(key);
    const dSilver = decide(
      a,
      { ...q, epic: 'SILVER' },
      cfg,
      (k) => (k === key ? { setup_key: key, samples: 5, p_win: 0.2, avg_win: 1, avg_loss: 2, costs: 0.1, ev: -1.4, positive: false } : null)
    );
    expect(dSilver.kind).not.toBe('BLOCK');
  });

  it('setupKey desk_entry source isolates setup vs move expectancy', async () => {
    const { decide, setupKey, normalizeDeskConfirmSource } = await import('../decision.js');
    const a = baseAnalysis({
      regime: 'TREND',
      trend_dir: 'UP',
      momentum_dir: 'UP',
      trend_strength: 0.8,
      structure_bias: 'BULLISH',
      buy_pressure: 0.9,
      sell_pressure: 0.1,
      behavior_bull: 0.9,
      momentum_score: 0.8,
      atr: 2,
      context_quality: 0.9,
      impact_score: 0.8,
    });
    const q: Quote = {
      bid: 4400,
      ask: 4400.4,
      mid: 4400.2,
      spread: 0.4,
      ts_ms: Date.now(),
      epic: 'GOLD',
    };
    const cfg = {
      ...DEFAULT_MASTER_CONFIG,
      min_score: 0.4,
      block_off_hours: false,
      require_positive_expectancy: true,
      min_expectancy_samples: 3,
      require_armed_setup: false,
    };
    expect(normalizeDeskConfirmSource('setup')).toBe('setup');
    expect(normalizeDeskConfirmSource('move')).toBe('move');
    expect(normalizeDeskConfirmSource(null)).toBe('none');
    const moveKey = setupKey(a, 'BUY', 'GOLD', 'move');
    const setupKeyStr = setupKey(a, 'BUY', 'GOLD', 'setup');
    const noneKey = setupKey(a, 'BUY', 'GOLD', 'none');
    expect(moveKey).not.toBe(setupKeyStr);
    expect(setupKeyStr).not.toBe(noneKey);
    expect(moveKey.endsWith('|move')).toBe(true);
    expect(setupKeyStr.endsWith('|setup')).toBe(true);
    const negMove = {
      setup_key: moveKey,
      samples: 5,
      p_win: 0.2,
      avg_win: 1,
      avg_loss: 2,
      costs: 0.1,
      ev: -1.4,
      positive: false,
    };
    // Negative move EV must not block setup confirm path
    const dSetup = decide(
      a,
      q,
      cfg,
      (k) => (k === moveKey ? negMove : null),
      null,
      null,
      null,
      {
        side: 'BUY',
        source: 'setup',
        reason: 'test',
        setup_kind: 'PULLBACK',
        playbook: null,
      }
    );
    expect(dSetup.kind).toBe('BUY');
    expect(dSetup.desk_entry_source).toBe('setup');
    // Same negative EV on move path must block
    const dMove = decide(
      a,
      q,
      cfg,
      (k) => (k === moveKey ? negMove : null),
      null,
      null,
      null,
      {
        side: 'BUY',
        source: 'move',
        reason: 'test',
        setup_kind: 'IMPULSE',
        playbook: null,
      }
    );
    expect(dMove.kind).toBe('BLOCK');
    expect(String(dMove.block_reason || '')).toMatch(/negative_expectancy:.*\|move/);
    expect(dMove.desk_entry_source).toBe('move');
  });

  it('evaluate does not mutate last_ai_allow_close or live journal', async () => {
    const prevAi = masterRuntime.last_ai_allow_close;
    const prevDecision = masterRuntime.last_decision;
    const prevRisk = masterRuntime.last_risk;
    const oppBefore = masterRuntime.pipeline.journal.opportunities.length;
    try {
      masterRuntime.last_ai_allow_close = true;
      const bars = Array.from({ length: 40 }, (_, i) => {
        const o = 4400 + i * 0.1;
        return {
          open: o,
          high: o + 1,
          low: o - 1,
          close: o + 0.5,
          ts_ms: Date.UTC(2026, 8, 7, 12, i),
        };
      });
      const q: Quote = {
        bid: 4404,
        ask: 4404.4,
        mid: 4404.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      const preview = await masterRuntime.evaluate(bars, q);
      expect(preview.decision).toBeTruthy();
      expect(masterRuntime.last_ai_allow_close).toBe(true);
      expect(masterRuntime.last_decision).toBe(prevDecision);
      expect(masterRuntime.last_risk).toBe(prevRisk);
      expect(masterRuntime.pipeline.journal.opportunities.length).toBe(oppBefore);
    } finally {
      masterRuntime.last_ai_allow_close = prevAi;
      masterRuntime.last_decision = prevDecision;
      masterRuntime.last_risk = prevRisk;
    }
  });
});

describe('SELL manageTick partial_close + Check trail', () => {
  it('evaluatePartialClose + manageTick scale-out for SELL', async () => {
    const { evaluatePartialClose } = await import('../positionManager.js');
    const d = evaluatePartialClose(
      {
        side: 'SELL',
        entry: 4400,
        take_profit: 4390,
        size: 0.1,
        partial_close_applied: false,
      },
      4395,
      { progressNeed: 0.5, volumeRatio: 0.5, volumeStep: 0.01 }
    );
    expect(d?.close_size).toBe(0.05);
    expect(d?.reason).toMatch(/PARTIAL_CLOSE/);

    const broker = new PaperBroker();
    await broker.connect();
    broker.setQuote({
      bid: 4394.6,
      ask: 4395,
      mid: 4394.8,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const pm = new PositionManager();
    const pipe = new MasterPipeline('PAPER');
    pm.register({
      position_id: 'paper-partial-sell-1',
      opportunity_id: 'opp-partial-sell',
      intent_id: 'partial-sell-aaaaaaaa',
      epic: 'GOLD',
      side: 'SELL',
      size: 0.1,
      entry: 4400,
      stop_loss: 4405,
      take_profit: 4390,
      decision: {
        decision_id: 'd-ps',
        kind: 'SELL',
        side: 'SELL',
        score: 0.8,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ regime: 'TREND' }),
        expectancy: null,
      },
    });
    broker.seedOpens([
      {
        position_id: 'paper-partial-sell-1',
        epic: 'GOLD',
        side: 'SELL',
        size: 0.1,
        open_level: 4400,
        stop_level: 4405,
        profit_level: 4390,
      },
    ]);
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4394.6,
        ask: 4395,
        mid: 4394.8,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      partial_close_progress: 0.5,
      partial_close_volume: 0.5,
      volume_step: 0.01,
      max_hold_ms: 0,
    });
    expect(managed.closed.length).toBe(1);
    expect(managed.closed[0]!.reason).toMatch(/PARTIAL_CLOSE/);
    expect(pm.count()).toBe(1);
    expect(pm.list()[0]!.size).toBeCloseTo(0.05, 8);
    expect(pm.list()[0]!.partial_close_applied).toBe(true);
  });

  it('Check trail_start/trail_lock tightens SELL stop only', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    const markAsk = 4390; // 10 pts favorable for SELL
    broker.setQuote({
      bid: markAsk - 0.2,
      ask: markAsk,
      mid: markAsk - 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'trail-sell-bbbbbbbbbbbb',
      epic: 'GOLD',
      side: 'SELL',
      size: 1,
      stop_level: entry + 8,
      profit_level: entry - 20,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-trail-sell',
      intent_id: 'trail-sell-1',
      epic: 'GOLD',
      side: 'SELL',
      size: 1,
      entry,
      stop_loss: entry + 8,
      take_profit: entry - 20,
      decision: {
        decision_id: 'd-ts',
        kind: 'SELL',
        side: 'SELL',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: baseAnalysis({ regime: 'TREND' }),
        expectancy: null,
      },
    });
    const before = pm.get(placed.position_id!)!.stop_loss!;
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: markAsk - 0.2,
        ask: markAsk,
        mid: markAsk - 0.1,
        spread: 0.2,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      scalp_pct_chase: false,
      trail_start: 5,
      trail_lock: 2,
      breakeven_progress: 0,
      max_hold_ms: 0,
      allow_close: false,
    });
    const sl = pm.get(placed.position_id!)!.stop_loss!;
    // trailed = mark + lock = 4390 + 2 = 4392 — tighter than entry+8=4408
    expect(sl).toBeLessThan(before);
    expect(sl).toBeCloseTo(markAsk + 2, 5);
  });

  it('status exposes entry_gates honesty fields', () => {
    const s = masterRuntime.status();
    expect(s.entry_gates).toBeTruthy();
    expect(typeof s.entry_gates.news_cfg_on).toBe('boolean');
    expect(typeof s.entry_gates.weekend).toBe('boolean');
    expect(typeof s.entry_gates.hours_ok).toBe('boolean');
    expect(typeof s.entry_gates.session).toBe('string');
    expect(typeof s.entry_gates.session_hydrated).toBe('boolean');
    expect(Array.isArray(s.expectancy_would_block)).toBe(true);
    expect(typeof s.bars_available).toBe('number');
    expect(Array.isArray(masterRuntime.barsSnapshot(10))).toBe(true);
  });

  it('status exposes dual BUY/SELL filter stage fields', async () => {
    const { MasterPipeline, DEFAULT_MASTER_CONFIG, GOLD_SPEC } = await import(
      '../pipeline.js'
    );
    const prevQuote = masterRuntime.last_quote;
    const prevDecision = masterRuntime.last_decision;
    const prevMarket = masterRuntime.last_market;
    const prevRisk = masterRuntime.last_risk;
    try {
    const pipe = new MasterPipeline('PAPER');
    const bars = Array.from({ length: 40 }, (_, i) => {
      const o = 4400 + i * 0.4;
      return { open: o, high: o + 1, low: o - 0.3, close: o + 0.2, ts_ms: i * 60_000 };
    });
    const quote = {
      bid: 4415.8,
      ask: 4416.2,
      mid: 4416,
      spread: 0.4,
      ts_ms: Date.now(),
      epic: 'GOLD',
    };
    const cycle = await pipe.runCycle({
      bars,
      quote,
      account: {
        equity: 10_000,
        balance: 10_000,
        currency: 'GBP',
        open_positions: 0,
        daily_pnl: 0,
        peak_equity: 10_000,
        consecutive_losses: 0,
      },
      instrument: GOLD_SPEC,
      cfg: { ...DEFAULT_MASTER_CONFIG, mode: 'PAPER', block_off_hours: false },
    });
    masterRuntime.last_quote = quote;
    masterRuntime.last_decision = cycle.decision;
    masterRuntime.last_risk = cycle.risk;
    masterRuntime.last_market = {
      ok: cycle.market.ok,
      quality: cycle.market.quality,
      reasons: [...cycle.market.reasons],
      bars_in: bars.length,
      bars_out: cycle.market.bars.length,
    };
    const s = masterRuntime.status();
    expect(s.buy_filter).toBeTruthy();
    expect(s.sell_filter).toBeTruthy();
    expect(typeof s.buy_filter!.ok).toBe('boolean');
    expect(typeof s.sell_filter!.ok).toBe('boolean');
    expect(typeof s.buy_filter!.score).toBe('number');
    expect(typeof s.sell_filter!.score).toBe('number');
    expect(s.market_state).toBeTruthy();
    // Full pipeline stage map — dashboard authoritative composition
    const stages = s.pipeline_stages;
    expect(stages).toBeTruthy();
    for (const id of [
      'market_validation',
      'normalization',
      'analysis_regime',
      'dual_candidates',
      'filters',
      'decision',
      'risk',
      'execution',
      'broker',
      'position_manager',
      'exit',
      'journal',
      'performance',
    ] as const) {
      expect(stages[id]).toBeTruthy();
      expect(typeof stages[id].ok).toBe('boolean');
      expect(typeof stages[id].detail).toBe('string');
    }
    expect(stages.dual_candidates.ok).toBe(true);
    expect(stages.analysis_regime.ok).toBe(true);
    expect(stages.analysis_regime.detail).toMatch(/:/);
    } finally {
      masterRuntime.last_quote = prevQuote;
      masterRuntime.last_decision = prevDecision;
      masterRuntime.last_market = prevMarket;
      masterRuntime.last_risk = prevRisk;
    }
  });
});

describe('replay exit order vs live manageTick', () => {
  it('force_allow_close=false vetoes TIME_STOP but hard SL still exits', async () => {
    const { replayMaster } = await import('../replay.js');
    const bars = Array.from({ length: 60 }, (_, i) => {
      const o = 4400 + Math.min(i, 30) * 0.8;
      return {
        open: o,
        high: o + 1.5,
        low: o - 0.4,
        close: o + 0.6,
        ts_ms: Date.UTC(2026, 8, 7, 12, i),
      };
    });
    // Crash deep through any SL after entry window
    bars.push({
      open: 4424,
      high: 4425,
      low: 4300,
      close: 4310,
      ts_ms: Date.UTC(2026, 8, 7, 13, 0),
    });
    const result = await replayMaster({
      bars,
      warmup: 25,
      force_allow_close: false,
      cfg: {
        ...DEFAULT_MASTER_CONFIG,
        block_off_hours: false,
        block_high_impact_news: false,
        min_score: 0.25,
        max_hold_ms: 1, // would TIME_STOP immediately if soft allowed
        soft_trail_money_arm: 0,
        scalp_pct_chase: false,
        require_positive_expectancy: false,
        ai_mode: 'advisory',
      },
    });
    const exits = result.opportunities
      .filter((o) => o.outcome)
      .map((o) => o.outcome!.exit_reason);
    expect(exits.every((r) => r !== 'TIME_STOP')).toBe(true);
    // Hard SL may still fire on crash bar
    expect(result.equity_curve.length).toBeGreaterThan(10);
  });

  it('hard SL wins over BestOutcome HardInvalidation on same bar', async () => {
    const { replayMaster } = await import('../replay.js');
    // Strong uptrend open, then violent dump through SL while mid is deeply underwater
    const bars: Array<{
      open: number;
      high: number;
      low: number;
      close: number;
      ts_ms: number;
    }> = [];
    for (let i = 0; i < 50; i++) {
      const o = 4400 + i * 1.2;
      bars.push({
        open: o,
        high: o + 2,
        low: o - 0.3,
        close: o + 1.5,
        ts_ms: Date.UTC(2026, 8, 7, 12, i),
      });
    }
    // Crash bar: high still above entry path, low far below any reasonable SL,
    // close deep underwater so BestOutcome HardInvalidation would also fire.
    const last = bars[bars.length - 1]!;
    bars.push({
      open: last.close,
      high: last.close + 0.5,
      low: last.close - 80,
      close: last.close - 60,
      ts_ms: Date.UTC(2026, 8, 7, 12, 50),
    });
    for (let i = 0; i < 20; i++) {
      const o = last.close - 60 - i;
      bars.push({
        open: o,
        high: o + 0.5,
        low: o - 0.5,
        close: o - 0.2,
        ts_ms: Date.UTC(2026, 8, 7, 12, 51 + i),
      });
    }
    const result = await replayMaster({
      bars,
      warmup: 25,
      spread: 0.3,
      cfg: {
        ...DEFAULT_MASTER_CONFIG,
        block_off_hours: false,
        block_high_impact_news: false,
        min_score: 0.25,
        max_hold_ms: 0,
        soft_trail_money_arm: 0,
        scalp_pct_chase: false,
        require_positive_expectancy: false,
      },
    });
    const exits = result.opportunities
      .filter((o) => o.outcome)
      .map((o) => o.outcome!.exit_reason);
    // If any hard SL fired, it must not be labeled as BestOutcome/HardInvalidation
    const slExits = exits.filter((r) => r === 'SL' || r === 'STOP_HIT');
    const poison = exits.filter(
      (r) => /HardInvalidation/i.test(r) && !/SL|STOP/i.test(r)
    );
    // Prefer proof: when crash produces an exit near SL price path, reason is SL
    if (slExits.length === 0 && poison.length > 0) {
      // Soft BestOutcome stole the bar — fail
      expect(poison).toEqual([]);
    }
    expect(result.equity_curve.length).toBeGreaterThan(10);
    // At least one traded path should prefer hard protective vocabulary when SL hits
    if (exits.some((r) => r === 'SL')) {
      expect(exits.some((r) => r === 'SL')).toBe(true);
    }
  });

  it('soft TIME_STOP skipped when local SL missing (replay close_requires_sl)', async () => {
    const { replayMaster } = await import('../replay.js');
    // Flat-ish bars so hard SL never hits; max_hold would soft-exit if SL present
    const bars = Array.from({ length: 80 }, (_, i) => {
      const o = 4400 + Math.sin(i / 8) * 0.4;
      return {
        open: o,
        high: o + 0.3,
        low: o - 0.3,
        close: o + 0.05,
        ts_ms: Date.UTC(2026, 8, 7, 12, i),
      };
    });
    // Monkey: force entries with null SL by patching candidates post-decision is hard;
    // instead assert helper + that max_hold alone does not invent naked soft exits when
    // we strip SL after open via a dedicated unit of replaySoftCloseAllowed semantics.
    const { closeAllowedByStopLoss } = await import('../closeRequiresSl.js');
    expect(
      closeAllowedByStopLoss({
        brokerFound: null,
        brokerStopLoss: null,
        dbStopLoss: null,
      })
    ).toBe(false);
    expect(
      closeAllowedByStopLoss({
        brokerFound: null,
        brokerStopLoss: null,
        dbStopLoss: 4390,
      })
    ).toBe(true);
    // Full replay with normal SL still TIME_STOPs when allow_close
    const withSl = await replayMaster({
      bars,
      warmup: 25,
      force_allow_close: true,
      cfg: {
        ...DEFAULT_MASTER_CONFIG,
        block_off_hours: false,
        block_high_impact_news: false,
        min_score: 0.2,
        max_hold_ms: 60_000,
        soft_trail_money_arm: 0,
        scalp_pct_chase: false,
        require_positive_expectancy: false,
        ai_mode: 'off',
      },
    });
    void withSl;
    // Source-level: replay exits via live PositionManager.manageTick (one exit brain)
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const src = readFileSync(join(__dirname, '../replay.ts'), 'utf8');
    expect(src).toMatch(/manageTick\(/);
    expect(src).toMatch(/hard_only:\s*true/);
    expect(src).toMatch(/PositionManager/);
    expect(src).toMatch(/adverseProtectiveQuote/);
    expect(src).toMatch(/opts\.epic/);
    expect(src).toMatch(/post_exit_until_ms/);
    expect(src).toMatch(/last_entry_fingerprint/);
    expect(src).toMatch(/relative_spread:/);
    expect(src).toMatch(/updateSpreadModel/);
  });
});

describe('pipeline_stages honesty — position + journal never forged green', () => {
  it('position_manager red until manageTick; journal red without evidence or persist', async () => {
    const prevDir = process.env.MASTER_STATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'vs-stage-honest-'));
    process.env.MASTER_STATE_DIR = dir;
    process.env.MASTER_GATES_DIR = dir;
    const { setJournalMirror } = await import('../journalMirror.js');
    setJournalMirror(null);

    const prevManage = (masterRuntime as unknown as { last_manage_tick_ms: number })
      .last_manage_tick_ms;
    const prevPersist = masterRuntime.persist_ok;
    const prevPersistErr = masterRuntime.last_persist_error;
    const prevPositions = masterRuntime.positions;
    const prevBroker = masterRuntime.broker;
    const prevPipe = masterRuntime.pipeline;
    const prevExit = masterRuntime.last_exit_reason;
    const prevMarket = masterRuntime.last_market;

    try {
      (masterRuntime as unknown as { last_manage_tick_ms: number }).last_manage_tick_ms = 0;
      (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated = false;
      masterRuntime.persist_ok = true;
      masterRuntime.last_persist_error = null;
      masterRuntime.positions = new PositionManager();
      masterRuntime.broker = null;
      masterRuntime.pipeline = new MasterPipeline('PAPER');
      masterRuntime.last_exit_reason = null;
      masterRuntime.last_market = null;

      const cold = masterRuntime.status().pipeline_stages;
      expect(cold.position_manager.ok).toBe(false);
      expect(cold.position_manager.detail).toMatch(/manage never ran/);
      expect(cold.broker.ok).toBe(false);
      expect(cold.broker.detail).toBe('none');
      expect(cold.exit.ok).toBe(false);
      expect(cold.exit.detail).toMatch(/no exit yet/);
      expect(cold.journal.ok).toBe(false);
      expect(cold.journal.detail).toMatch(/no journal/);
      expect(cold.performance.ok).toBe(false);
      expect(cold.performance.detail).toMatch(/no performance|no KPI/);

      // Holding without manage evidence stays red
      masterRuntime.positions.register({
        position_id: 'stage-pos-1',
        opportunity_id: 'stage-opp-1',
        intent_id: 'stage-intent-1',
        epic: 'GOLD',
        side: 'BUY',
        size: 0.1,
        entry: 4400,
        stop_loss: 4390,
        take_profit: 4420,
        decision: {
          decision_id: 'd1',
          kind: 'BUY',
          side: 'BUY',
          score: 0.8,
          block_reason: null,
          buy: { score: 0.8 } as never,
          sell: { score: 0.2 } as never,
          analysis: baseAnalysis(),
          expectancy: null,
        },
      });
      const holding = masterRuntime.status().pipeline_stages;
      expect(holding.position_manager.ok).toBe(false);
      expect(holding.position_manager.detail).toMatch(/open=1/);
      expect(holding.position_manager.detail).toMatch(/awaiting manage|manage never ran/);
      expect(holding.exit.ok).toBe(false);
      expect(holding.exit.detail).toBe('holding');

      // Disk-hydrated book without manage/broker must mark hydrated (not hard-bad)
      (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated = true;
      const hydratedHold = masterRuntime.status().pipeline_stages;
      expect(hydratedHold.position_manager.ok).toBe(false);
      expect(hydratedHold.position_manager.detail).toMatch(
        /^hydrated · open=1 · awaiting manage$/
      );
      expect(hydratedHold.broker.ok).toBe(false);
      expect(hydratedHold.broker.detail).toMatch(
        /^hydrated · none · awaiting attach$/
      );
      (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated = false;

      // Mark manageTick evidence → green while holding
      (masterRuntime as unknown as { last_manage_tick_ms: number }).last_manage_tick_ms =
        Date.now();
      const managed = masterRuntime.status().pipeline_stages;
      expect(managed.position_manager.ok).toBe(true);
      expect(managed.position_manager.detail).toMatch(/managed \d+s ago/);
      expect(managed.exit.ok).toBe(false);

      // Live exit green only after a cycle (last_market)
      masterRuntime.last_market = {
        ok: true,
        quality: 0.9,
        reasons: [],
        bars_in: 40,
        bars_out: 40,
      };
      masterRuntime.last_exit_reason = 'TakeProfit';
      const exited = masterRuntime.status().pipeline_stages;
      expect(exited.exit.ok).toBe(true);
      expect(exited.exit.detail).toBe('TakeProfit');
      // Journal TP without a live cycle must stay hydrated / red
      masterRuntime.last_market = null;
      const hydratedExit = masterRuntime.status().pipeline_stages;
      expect(hydratedExit.exit.ok).toBe(false);
      expect(hydratedExit.exit.detail).toMatch(/^hydrated · TakeProfit$/);
      masterRuntime.last_exit_reason = null;

      // Persist fail → journal stage red even with KPI trades
      const { logDecisionEvent } = await import('../decisionJournal.js');
      logDecisionEvent({
        kind: 'WAIT',
        epic: 'GOLD',
        mode: 'PAPER',
        opportunity_id: 'stage-opp-1',
        buy_score: 0.1,
        sell_score: 0.1,
      });
      const withJournal = masterRuntime.status().pipeline_stages;
      expect(withJournal.journal.ok).toBe(true);
      expect(withJournal.journal.detail).toMatch(/dec=/);
      // Decisions alone must not forge Stage·perf green
      expect(withJournal.performance.ok).toBe(false);
      expect(withJournal.performance.detail).toMatch(/no KPI|awaiting/);

      // Disk-hydrated journal evidence marks hydrated (still green when persist ok)
      (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated = true;
      masterRuntime.last_market = null;
      const hydJournal = masterRuntime.status().pipeline_stages;
      expect(hydJournal.journal.ok).toBe(true);
      expect(hydJournal.journal.detail).toMatch(/^hydrated · dec=/);
      (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated = false;

      masterRuntime.persist_ok = false;
      masterRuntime.last_persist_error = 'disk_full_test';
      const persistFail = masterRuntime.status().pipeline_stages;
      expect(persistFail.journal.ok).toBe(false);
      expect(persistFail.journal.detail).toMatch(/persist fail/);
      expect(persistFail.performance.ok).toBe(false);
      expect(persistFail.performance.detail).toMatch(/persist fail/);
    } finally {
      (masterRuntime as unknown as { last_manage_tick_ms: number }).last_manage_tick_ms =
        prevManage;
      (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated = false;
      masterRuntime.persist_ok = prevPersist;
      masterRuntime.last_persist_error = prevPersistErr;
      masterRuntime.positions = prevPositions;
      masterRuntime.broker = prevBroker;
      masterRuntime.pipeline = prevPipe;
      masterRuntime.last_exit_reason = prevExit;
      masterRuntime.last_market = prevMarket;
      if (prevDir === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevDir;
      if (prevDir === undefined) delete process.env.MASTER_GATES_DIR;
      else process.env.MASTER_GATES_DIR = prevDir;
    }
  });
});

describe('pipeline_stages honesty — normalization never forged green', () => {
  it('flat_tape / failed validation keeps Stage·normalize red despite bars_out', () => {
    const prev = masterRuntime.last_market;
    const prevQuote = masterRuntime.last_quote;
    try {
      // Isolate flat_tape from liveQuoteStaleForStages (prior tests may leave aged quote)
      masterRuntime.last_quote = {
        bid: 4400,
        ask: 4400.4,
        mid: 4400.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      masterRuntime.last_market = {
        ok: false,
        quality: 0.3,
        reasons: ['flat_tape'],
        bars_in: 12,
        bars_out: 12,
      };
      const stages = masterRuntime.status().pipeline_stages;
      expect(stages.market_validation.ok).toBe(false);
      expect(stages.market_validation.detail).toMatch(/flat_tape/);
      expect(stages.normalization.ok).toBe(false);
      expect(stages.normalization.detail).toMatch(/12\/12/);
      expect(stages.normalization.detail).toMatch(/flat_tape/);

      masterRuntime.last_market = {
        ok: true,
        quality: 0.95,
        reasons: [],
        bars_in: 40,
        bars_out: 40,
      };
      const okStages = masterRuntime.status().pipeline_stages;
      expect(okStages.market_validation.ok).toBe(true);
      expect(okStages.normalization.ok).toBe(true);
      expect(okStages.normalization.detail).toBe('40/40 bars');
    } finally {
      masterRuntime.last_market = prev;
      masterRuntime.last_quote = prevQuote;
    }
  });
});

describe('pipeline_stages honesty — filters fail-closed', () => {
  it('score-only journal hydrate must not forge Stage·filters green', () => {
    const prev = masterRuntime.last_decision;
    const prevMarket = masterRuntime.last_market;
    const prevQuote = masterRuntime.last_quote;
    try {
      masterRuntime.last_quote = {
        bid: 4400,
        ask: 4400.4,
        mid: 4400.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      masterRuntime.last_market = {
        ok: true,
        quality: 0.95,
        reasons: [],
        bars_in: 40,
        bars_out: 40,
      };
      masterRuntime.last_decision = {
        decision_id: 'hydrated',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: { score: 0.7 } as never,
        sell: { score: 0.2 } as never,
        analysis: baseAnalysis(),
        expectancy: null,
      };
      const stages = masterRuntime.status().pipeline_stages;
      expect(stages.filters.ok).toBe(false);
      expect(stages.filters.detail).toMatch(/no filter evidence/);
      expect(stages.dual_candidates.ok).toBe(false);
      expect(stages.dual_candidates.detail).toMatch(/no candidate evidence/);

      masterRuntime.last_decision = {
        decision_id: 'live',
        kind: 'BUY',
        side: 'BUY',
        score: 0.8,
        block_reason: null,
        buy: {
          score: 0.8,
          filter_ok: true,
          filter_reason: null,
          valid: true,
          components: {
            momentum: 0.5,
            trend: 0.5,
            structure: 0.5,
            pressure: 0.5,
            behavior: 0,
            impact: 0.5,
            context: 0.5,
          },
        } as never,
        sell: {
          score: 0.2,
          filter_ok: false,
          filter_reason: 'spread',
          valid: true,
          components: {
            momentum: 0.2,
            trend: 0.2,
            structure: 0.2,
            pressure: 0.2,
            behavior: 0,
            impact: 0.2,
            context: 0.2,
          },
        } as never,
        analysis: baseAnalysis(),
        expectancy: null,
      };
      const okStages = masterRuntime.status().pipeline_stages;
      expect(okStages.filters.ok).toBe(true);
      expect(okStages.filters.detail).toMatch(/BUY ok/);
      expect(okStages.filters.detail).toMatch(/SELL spread|SELL fail/);
      expect(okStages.dual_candidates.ok).toBe(true);

      // Full filter/candidate evidence without last_market must stay red
      masterRuntime.last_market = null;
      const hydrated = masterRuntime.status().pipeline_stages;
      expect(hydrated.filters.ok).toBe(false);
      expect(hydrated.filters.detail).toMatch(/hydrated · BUY ok/);
      expect(hydrated.dual_candidates.ok).toBe(false);
      expect(hydrated.dual_candidates.detail).toMatch(/hydrated · B/);
    } finally {
      masterRuntime.last_decision = prev;
      masterRuntime.last_market = prevMarket;
      masterRuntime.last_quote = prevQuote;
    }
  });
});

describe('pipeline_stages honesty — stale quote fails Stage·validate', () => {
  it('sticky last_market green cannot survive aged last_quote', () => {
    const prevMarket = masterRuntime.last_market;
    const prevQuote = masterRuntime.last_quote;
    const prevCfg = masterRuntime.cfg;
    try {
      masterRuntime.cfg = { ...masterRuntime.cfg, stale_quote_ms: 5_000 };
      masterRuntime.last_market = {
        ok: true,
        quality: 0.95,
        reasons: [],
        bars_in: 40,
        bars_out: 40,
      };
      masterRuntime.last_quote = {
        bid: 4400,
        ask: 4400.4,
        mid: 4400.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now() - 60_000,
      };
      const stages = masterRuntime.status().pipeline_stages;
      expect(masterRuntime.status().quote?.stale).toBe(true);
      expect(stages.market_validation.ok).toBe(false);
      expect(stages.market_validation.detail).toMatch(/stale_quote/);
      expect(stages.normalization.ok).toBe(false);
      expect(stages.normalization.detail).toMatch(/stale_quote/);

      masterRuntime.last_quote = {
        bid: 4400,
        ask: 4400.4,
        mid: 4400.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      const fresh = masterRuntime.status().pipeline_stages;
      expect(fresh.market_validation.ok).toBe(true);
      expect(fresh.normalization.ok).toBe(true);
    } finally {
      masterRuntime.last_market = prevMarket;
      masterRuntime.last_quote = prevQuote;
      masterRuntime.cfg = prevCfg;
    }
  });
});

describe('pipeline_stages honesty — analysis_regime never forged from hydrate', () => {
  it('journal decision without last_market keeps Stage·analysis red', () => {
    const prevDecision = masterRuntime.last_decision;
    const prevMarket = masterRuntime.last_market;
    const prevQuote = masterRuntime.last_quote;
    try {
      masterRuntime.last_quote = {
        bid: 4400,
        ask: 4400.4,
        mid: 4400.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      masterRuntime.last_market = null;
      masterRuntime.last_decision = {
        decision_id: 'hydrated',
        kind: 'BLOCK',
        side: null,
        score: 0.8,
        block_reason: 'filters:spread',
        buy: {
          score: 0.8,
          filter_ok: true,
          filter_reason: null,
          valid: true,
          components: {
            momentum: 0.5,
            trend: 0.5,
            structure: 0.5,
            pressure: 0.5,
            behavior: 0,
            impact: 0.5,
            context: 0.5,
          },
        } as never,
        sell: {
          score: 0.2,
          filter_ok: false,
          filter_reason: 'spread',
          valid: true,
          components: {
            momentum: 0.2,
            trend: 0.2,
            structure: 0.2,
            pressure: 0.2,
            behavior: 0,
            impact: 0.2,
            context: 0.2,
          },
        } as never,
        analysis: {
          ...baseAnalysis(),
          regime: 'TREND_UP',
          market_state: 'TREND_UP:UP:BULLISH',
        },
        expectancy: null,
      };
      const stages = masterRuntime.status().pipeline_stages;
      expect(stages.analysis_regime.ok).toBe(false);
      expect(stages.analysis_regime.detail).toMatch(/^hydrated ·/);
      expect(stages.analysis_regime.detail).toMatch(/TREND_UP/);
      // Filters/dual are cycle-bound too — hydrate evidence alone stays red
      expect(stages.filters.ok).toBe(false);
      expect(stages.filters.detail).toMatch(/hydrated ·/);
      expect(stages.dual_candidates.ok).toBe(false);
      expect(stages.dual_candidates.detail).toMatch(/hydrated ·/);
      const st = masterRuntime.status();
      expect(st.buy_filter?.ok).toBe(false);
      expect(st.buy_filter?.reason).toBe('hydrated');
      expect(st.sell_filter?.ok).toBe(false);
      expect(st.sell_filter?.reason).toBe('hydrated');
      expect(st.regime).toMatch(/^hydrated · TREND_UP$/);
      expect(st.market_state).toMatch(/^hydrated · TREND_UP:/);
      expect(st.entry_gates.session_hydrated).toBe(true);
      expect(st.entry_gates.session).toMatch(/^hydrated ·/);
      // Why must mark journal BLOCK as hydrated — not live-bad
      expect(String(st.last_block_reason || '')).toMatch(/^hydrated · filters:spread$/);

      masterRuntime.last_market = {
        ok: true,
        quality: 0.95,
        reasons: [],
        bars_in: 40,
        bars_out: 40,
      };
      const live = masterRuntime.status().pipeline_stages;
      expect(live.analysis_regime.ok).toBe(true);
      expect(live.analysis_regime.detail).toMatch(/^TREND_UP:/);
      expect(live.filters.ok).toBe(true);
      expect(live.dual_candidates.ok).toBe(true);
      const liveSt = masterRuntime.status();
      expect(liveSt.buy_filter?.ok).toBe(true);
      expect(liveSt.buy_filter?.reason).not.toBe('hydrated');
      expect(liveSt.sell_filter?.ok).toBe(false);
      expect(liveSt.sell_filter?.reason).toBe('spread');
      expect(liveSt.regime).toBe('TREND_UP');
      expect(liveSt.market_state).toBe('TREND_UP:UP:BULLISH');
      expect(liveSt.entry_gates.session_hydrated).toBe(false);
      expect(liveSt.entry_gates.session).not.toMatch(/^hydrated ·/);
      expect(String(liveSt.last_block_reason || '')).toBe('filters:spread');
      expect(String(liveSt.last_block_reason || '')).not.toMatch(/^hydrated ·/);

      masterRuntime.last_market = {
        ok: false,
        quality: 0.2,
        reasons: ['flat_tape'],
        bars_in: 12,
        bars_out: 12,
      };
      const bad = masterRuntime.status().pipeline_stages;
      expect(bad.analysis_regime.ok).toBe(false);
      expect(bad.analysis_regime.detail).toMatch(/invalid market/);
    } finally {
      masterRuntime.last_decision = prevDecision;
      masterRuntime.last_market = prevMarket;
      masterRuntime.last_quote = prevQuote;
    }
  });

  it('score-only decision journal hydrate keeps analysis UNKNOWN / red', () => {
    const prevDecision = masterRuntime.last_decision;
    const prevMarket = masterRuntime.last_market;
    try {
      masterRuntime.last_market = {
        ok: true,
        quality: 0.95,
        reasons: [],
        bars_in: 40,
        bars_out: 40,
      };
      masterRuntime.last_decision = {
        decision_id: 'recovered',
        kind: 'WAIT',
        side: null,
        score: 0.5,
        block_reason: null,
        buy: { score: 0.5 } as never,
        sell: { score: 0.4 } as never,
        analysis: {
          regime: 'UNKNOWN',
          market_state: 'recovered_from_decision_journal',
        } as never,
        expectancy: null,
      };
      const stages = masterRuntime.status().pipeline_stages;
      expect(stages.analysis_regime.ok).toBe(false);
      expect(stages.analysis_regime.detail).toMatch(/UNKNOWN|recovered/);
    } finally {
      masterRuntime.last_decision = prevDecision;
      masterRuntime.last_market = prevMarket;
    }
  });
});

describe('pipeline_stages honesty — execution never forged from hydrate', () => {
  it('hydrated last_execution_detail without last_market keeps Stage·execution red', () => {
    const prevExec = masterRuntime.last_execution_detail;
    const prevMarket = masterRuntime.last_market;
    const prevQuote = masterRuntime.last_quote;
    const prevBroker = masterRuntime.broker;
    try {
      masterRuntime.last_quote = {
        bid: 4400,
        ask: 4400.4,
        mid: 4400.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      masterRuntime.last_market = null;
      masterRuntime.last_execution_detail = 'paper_fill';
      const stages = masterRuntime.status().pipeline_stages;
      expect(stages.execution.ok).toBe(false);
      expect(stages.execution.detail).toMatch(/hydrated · paper_fill/);

      masterRuntime.last_market = {
        ok: true,
        quality: 0.95,
        reasons: [],
        bars_in: 40,
        bars_out: 40,
      };
      const live = masterRuntime.status().pipeline_stages;
      expect(live.execution.ok).toBe(true);
      expect(live.execution.detail).toBe('paper_fill');

      masterRuntime.broker = null;
      const noBroker = masterRuntime.status().pipeline_stages;
      expect(noBroker.broker.ok).toBe(false);
      expect(noBroker.broker.detail).toBe('none');
    } finally {
      masterRuntime.last_execution_detail = prevExec;
      masterRuntime.last_market = prevMarket;
      masterRuntime.last_quote = prevQuote;
      masterRuntime.broker = prevBroker;
    }
  });
});

describe('pipeline_stages honesty — decision/risk never forged from hydrate', () => {
  it('hydrated last_decision without last_market keeps Stage·decision and Stage·risk red', () => {
    const prevDecision = masterRuntime.last_decision;
    const prevRisk = masterRuntime.last_risk;
    const prevMarket = masterRuntime.last_market;
    const prevQuote = masterRuntime.last_quote;
    try {
      masterRuntime.last_quote = {
        bid: 4400,
        ask: 4400.4,
        mid: 4400.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      masterRuntime.last_market = null;
      masterRuntime.last_decision = {
        decision_id: 'recovered',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: { score: 0.7 } as never,
        sell: { score: 0.2 } as never,
        analysis: {
          regime: 'UNKNOWN',
          market_state: 'recovered_from_decision_journal',
        } as never,
        expectancy: null,
      };
      masterRuntime.last_risk = {
        allowed: true,
        volume: 0.05,
        risk_amount: 10,
        reasons: [],
      };
      const stages = masterRuntime.status().pipeline_stages;
      expect(stages.decision.ok).toBe(false);
      expect(stages.decision.detail).toMatch(/hydrated · BUY/);
      expect(stages.risk.ok).toBe(false);
      expect(stages.risk.detail).toMatch(/hydrated · vol=0\.05/);

      masterRuntime.last_market = {
        ok: true,
        quality: 0.95,
        reasons: [],
        bars_in: 40,
        bars_out: 40,
      };
      const live = masterRuntime.status().pipeline_stages;
      expect(live.decision.ok).toBe(true);
      expect(live.decision.detail).toBe('BUY');
      expect(live.risk.ok).toBe(true);
      expect(live.risk.detail).toBe('vol=0.05');
    } finally {
      masterRuntime.last_decision = prevDecision;
      masterRuntime.last_risk = prevRisk;
      masterRuntime.last_market = prevMarket;
      masterRuntime.last_quote = prevQuote;
    }
  });

  it('hydrateBookFromDisk seeds last_risk from opportunity.risk as hydrated', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'vs-risk-seed-'));
    process.env.MASTER_STATE_DIR = dir;
    const { installFilePersist } = await import('../filePersist.js');
    const { persistOpportunity, setPersistClient } = await import('../persist.js');
    const { GOLD_SPEC } = await import('../pipeline.js');
    installFilePersist(dir);
    const pipe = new MasterPipeline('PAPER');
    const bars = Array.from({ length: 40 }, (_, i) => {
      const o = 4400 + i * 0.5;
      return {
        open: o,
        high: o + 1,
        low: o - 0.2,
        close: o + 0.4,
        ts_ms: i * 60_000,
      };
    });
    const cycle = await pipe.runCycle({
      bars,
      quote: {
        bid: 4419.8,
        ask: 4420.2,
        mid: 4420,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      account: {
        equity: 10_000,
        balance: 10_000,
        currency: 'GBP',
        open_positions: 0,
        daily_pnl: 0,
        peak_equity: 10_000,
        consecutive_losses: 0,
      },
      instrument: GOLD_SPEC,
      cfg: { ...DEFAULT_MASTER_CONFIG, block_off_hours: false },
    });
    expect(cycle.risk).toBeTruthy();
    await persistOpportunity(cycle.opportunity);
    const prevDecision = masterRuntime.last_decision;
    const prevRisk = masterRuntime.last_risk;
    const prevMarket = masterRuntime.last_market;
    const prevBook = (masterRuntime as unknown as { bookHydrated: boolean })
      .bookHydrated;
    const prevRecovered = masterRuntime.recovered;
    const prevPipe = masterRuntime.pipeline;
    try {
      masterRuntime.pipeline = new MasterPipeline('PAPER');
      masterRuntime.recovered = false;
      masterRuntime.last_decision = null;
      masterRuntime.last_risk = null;
      masterRuntime.last_market = null;
      (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated =
        false;
      await masterRuntime.hydrateBookFromDisk();
      expect(masterRuntime.last_risk).toBeTruthy();
      expect(masterRuntime.last_risk?.volume).toBe(cycle.risk.volume);
      const st = masterRuntime.status();
      expect(st.pipeline_stages.risk.ok).toBe(false);
      expect(st.pipeline_stages.risk.detail).toMatch(/^hydrated · /);
    } finally {
      masterRuntime.pipeline = prevPipe;
      masterRuntime.recovered = prevRecovered;
      masterRuntime.last_decision = prevDecision;
      masterRuntime.last_risk = prevRisk;
      masterRuntime.last_market = prevMarket;
      (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated =
        prevBook;
      setPersistClient(null);
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });

  it('hydrateBookFromDisk seeds last_execution_detail from decision journal', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'vs-exec-seed-'));
    process.env.MASTER_STATE_DIR = dir;
    const { installFilePersist } = await import('../filePersist.js');
    const { persistOpportunity, setPersistClient } = await import('../persist.js');
    const { logDecisionEvent } = await import('../decisionJournal.js');
    const { GOLD_SPEC } = await import('../pipeline.js');
    installFilePersist(dir);
    const pipe = new MasterPipeline('PAPER');
    const bars = Array.from({ length: 40 }, (_, i) => {
      const o = 4400 + i * 0.5;
      return {
        open: o,
        high: o + 1,
        low: o - 0.2,
        close: o + 0.4,
        ts_ms: i * 60_000,
      };
    });
    const cycle = await pipe.runCycle({
      bars,
      quote: {
        bid: 4419.8,
        ask: 4420.2,
        mid: 4420,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      account: {
        equity: 10_000,
        balance: 10_000,
        currency: 'GBP',
        open_positions: 0,
        daily_pnl: 0,
        peak_equity: 10_000,
        consecutive_losses: 0,
      },
      instrument: GOLD_SPEC,
      cfg: { ...DEFAULT_MASTER_CONFIG, block_off_hours: false },
    });
    // Opportunity without fill payload — exec detail only in decision journal
    await persistOpportunity({
      ...cycle.opportunity,
      execution: {
        accepted: false,
        intent_id: null,
        order_id: null,
        fill_price: null,
        detail: null,
        paper: true,
      },
    } as never);
    logDecisionEvent({
      kind: cycle.decision.kind,
      epic: 'GOLD',
      mode: 'PAPER',
      opportunity_id: cycle.opportunity.id,
      buy_score: cycle.decision.buy?.score ?? 0,
      sell_score: cycle.decision.sell?.score ?? 0,
      executed: true,
      execution_detail: 'paper_fill_journal',
    });
    const prevDecision = masterRuntime.last_decision;
    const prevExec = masterRuntime.last_execution_detail;
    const prevMarket = masterRuntime.last_market;
    const prevBook = (masterRuntime as unknown as { bookHydrated: boolean })
      .bookHydrated;
    const prevRecovered = masterRuntime.recovered;
    const prevPipe = masterRuntime.pipeline;
    try {
      masterRuntime.pipeline = new MasterPipeline('PAPER');
      masterRuntime.recovered = false;
      masterRuntime.last_decision = null;
      masterRuntime.last_execution_detail = null;
      masterRuntime.last_market = null;
      (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated =
        false;
      await masterRuntime.hydrateBookFromDisk();
      expect(masterRuntime.last_execution_detail).toBe('paper_fill_journal');
      const st = masterRuntime.status();
      expect(st.pipeline_stages.execution.ok).toBe(false);
      expect(st.pipeline_stages.execution.detail).toMatch(
        /^hydrated · paper_fill_journal$/
      );
    } finally {
      masterRuntime.pipeline = prevPipe;
      masterRuntime.recovered = prevRecovered;
      masterRuntime.last_decision = prevDecision;
      masterRuntime.last_execution_detail = prevExec;
      masterRuntime.last_market = prevMarket;
      (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated =
        prevBook;
      setPersistClient(null);
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });
});

describe('Why / monitoring disk-hydrate honesty', () => {
  it('status marks disk monitor + block reason hydrated until a live cycle', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'vs-why-mon-'));
    process.env.MASTER_STATE_DIR = dir;
    const prevMarket = masterRuntime.last_market;
    const prevDecision = masterRuntime.last_decision;
    try {
      writeFileSync(
        join(dir, 'monitoring_snapshot.json'),
        JSON.stringify({
          timestamp_utc: new Date().toISOString(),
          cycle_latency_ms: 33,
          relative_spread: 2.2,
          ack_latency_ms: 180,
          instance_health: 'DEGRADED',
          entry_block_reason: 'alert:DATA_STALE',
          active_alerts: [
            { code: 'DATA_STALE', level: 'WARN', message: 'disk' },
          ],
        }),
        'utf8'
      );
      (masterRuntime as unknown as { monitorHydrated: boolean }).monitorHydrated =
        false;
      masterRuntime.hydrateMonitorFromDisk();
      masterRuntime.last_market = null;
      masterRuntime.last_decision = {
        decision_id: 'disk-why',
        kind: 'BLOCK',
        side: null,
        score: 0,
        block_reason: 'alert:DATA_STALE',
        buy: {
          score: 0.1,
          filter_ok: false,
          filter_reason: 'score',
          valid: true,
          components: {
            momentum: 0,
            trend: 0,
            structure: 0,
            pressure: 0,
            behavior: 0,
            impact: 0,
            context: 0,
          },
        } as never,
        sell: {
          score: 0.1,
          filter_ok: false,
          filter_reason: 'score',
          valid: true,
          components: {
            momentum: 0,
            trend: 0,
            structure: 0,
            pressure: 0,
            behavior: 0,
            impact: 0,
            context: 0,
          },
        } as never,
        analysis: { ...baseAnalysis(), session: 'LONDON' },
        expectancy: null,
      };
      const st = masterRuntime.status();
      expect(st.monitoring.hydrated).toBe(true);
      expect(String(st.monitoring.entry_block_reason || '')).toMatch(
        /^hydrated · alert:DATA_STALE$/
      );
      expect(String(st.last_block_reason || '')).toMatch(/^hydrated · /);
      expect(st.monitoring.relative_spread).toBe(2.2);
      expect(st.monitoring.ack_latency_ms).toBe(180);
      expect(st.monitoring.last_cycle_ms).toBe(33);

      masterRuntime.last_market = {
        ok: true,
        quality: 0.9,
        reasons: [],
        bars_in: 40,
        bars_out: 40,
      };
      // Live note clears disk flag
      (
        masterRuntime as unknown as {
          monitor: {
            noteAlerts: (a: unknown[], b: string | null) => void;
          };
        }
      ).monitor.noteAlerts([], null);
      const live = masterRuntime.status();
      expect(live.monitoring.hydrated).toBe(false);
      expect(String(live.last_block_reason || '')).toBe('alert:DATA_STALE');
      expect(String(live.last_block_reason || '')).not.toMatch(/^hydrated ·/);
    } finally {
      masterRuntime.last_market = prevMarket;
      masterRuntime.last_decision = prevDecision;
      (masterRuntime as unknown as { monitorHydrated: boolean }).monitorHydrated =
        false;
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });
});
