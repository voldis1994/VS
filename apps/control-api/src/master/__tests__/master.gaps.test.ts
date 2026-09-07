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
import { syncPositionsWithBroker } from '../positionSync.js';
import { masterRuntime } from '../runtime.js';
import type { AnalysisSnapshot, Quote } from '../types.js';

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
  it('allows UNKNOWN regime through shared filters (no dual-starve)', () => {
    const v = applyMarketFilters(baseAnalysis({ regime: 'UNKNOWN' }), quote, DEFAULT_MASTER_CONFIG);
    expect(v.ok).toBe(true);
    expect(v.checks.regime_stable).toBe(true);
  });

  it('still hard-blocks UNSTABLE', () => {
    const v = applyMarketFilters(baseAnalysis({ regime: 'UNSTABLE' }), quote, DEFAULT_MASTER_CONFIG);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/regime/);
  });

  it('hard-blocks OFF_HOURS session (Reader-style)', () => {
    const v = applyMarketFilters(
      baseAnalysis({ session: 'OFF_HOURS' }),
      quote,
      DEFAULT_MASTER_CONFIG
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('session_off_hours');
  });

  it('allows OFF_HOURS when block_off_hours disabled', () => {
    const v = applyMarketFilters(baseAnalysis({ session: 'OFF_HOURS' }), quote, {
      ...DEFAULT_MASTER_CONFIG,
      block_off_hours: false,
    });
    expect(v.ok).toBe(true);
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
    expect(managed.closed[0]!.outcome.exit).toBe(4405);
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
    process.env.MASTER_OWNS_PIPELINE = 'true';
    masterRuntime.setMode('PAPER');
    masterRuntime.ensurePaperBroker();
    expect(masterOwnsPipeline()).toBe(true);
    expect(masterOwnsManageSafely(true)).toBe(false);
    expect(masterOwnsManageSafely(false)).toBe(true);
    if (prev === undefined) delete process.env.MASTER_OWNS_PIPELINE;
    else process.env.MASTER_OWNS_PIPELINE = prev;
  });

  it('pauses MASTER entries when desk owns live manage (no dual-brain)', () => {
    const prev = process.env.MASTER_OWNS_PIPELINE;
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
    masterRuntime.setEntriesArmed(true);
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
