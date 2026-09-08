import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildCandidates } from '../candidates.js';
import { masterOwnsManageSafely, masterOwnsPipeline, syncMasterEntryOwnership } from '../deskBridge.js';
import { applyMarketFilters } from '../filters.js';
import { DEFAULT_MASTER_CONFIG, MasterPipeline } from '../pipeline.js';
import { PositionManager } from '../positionManager.js';
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
  it('defers when owns-pipeline but live Capital position and no CAPITAL broker', () => {
    const prev = process.env.MASTER_OWNS_PIPELINE;
    const prevPref = masterRuntime.owns_pipeline_pref;
    masterRuntime.owns_pipeline_pref = null;
    process.env.MASTER_OWNS_PIPELINE = 'true';
    masterRuntime.setMode('PAPER');
    masterRuntime.ensurePaperBroker();
    expect(masterOwnsPipeline()).toBe(true);
    expect(masterOwnsManageSafely(true)).toBe(false);
    expect(masterOwnsManageSafely(false)).toBe(true);
    if (prev === undefined) delete process.env.MASTER_OWNS_PIPELINE;
    else process.env.MASTER_OWNS_PIPELINE = prev;
    masterRuntime.owns_pipeline_pref = prevPref;
  });

  it('pauses MASTER entries when desk owns live manage (no dual-brain)', () => {
    const prev = process.env.MASTER_OWNS_PIPELINE;
    const prevPref = masterRuntime.owns_pipeline_pref;
    masterRuntime.owns_pipeline_pref = null;
    process.env.MASTER_OWNS_PIPELINE = 'true';
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
    });
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
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
    ).toEqual({ pnl: 42.5, pnl_pts: 10, from_broker: true });
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

  it('stale quote skips soft manage (TIME_STOP) but keeps position', async () => {
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
    // Backdate entry so TIME_STOP would fire if soft manage ran
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
    expect(managed.closed.length).toBe(0);
    expect(pm.count()).toBe(1);
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
    expect(String(r.execution_detail || '')).toMatch(
      new RegExp(`alert:${ALERT_DATA_STALE}`)
    );
    const st = masterRuntime.status();
    expect(st.monitoring?.entry_block_reason).toMatch(
      new RegExp(`alert:${ALERT_DATA_STALE}`)
    );
    expect(String(st.last_block_reason || '')).toMatch(
      new RegExp(`alert:${ALERT_DATA_STALE}`)
    );
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
  });
});
