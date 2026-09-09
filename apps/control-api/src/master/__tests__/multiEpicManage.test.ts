import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PaperBroker } from '../broker.js';
import { MasterPipeline, specForEpic } from '../pipeline.js';
import {
  PositionManager,
  floatingUnrealizedPnl,
  quoteMatchesPosition,
} from '../positionManager.js';
import { masterRuntime } from '../runtime.js';
import type { AnalysisSnapshot, Quote } from '../types.js';

function baseAnalysis(over: Partial<AnalysisSnapshot> = {}): AnalysisSnapshot {
  return {
    regime: 'TREND',
    market_state: 'test',
    momentum_score: 0.2,
    momentum_dir: 'UP',
    trend_dir: 'UP',
    trend_strength: 0.5,
    structure_bias: 'BULL',
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

function buyDecision(id: string) {
  return {
    decision_id: id,
    kind: 'BUY' as const,
    side: 'BUY' as const,
    score: 0.7,
    block_reason: null,
    buy: null as never,
    sell: null as never,
    analysis: baseAnalysis(),
  };
}

describe('quoteMatchesPosition', () => {
  it('allows legacy quotes without epic', () => {
    expect(quoteMatchesPosition({ epic: undefined as never }, 'GOLD')).toBe(true);
    expect(quoteMatchesPosition({} as Quote, 'SILVER')).toBe(true);
  });

  it('matches GOLD/XAUUSD aliases and rejects SILVER', () => {
    expect(quoteMatchesPosition({ epic: 'GOLD' }, 'XAUUSD')).toBe(true);
    expect(quoteMatchesPosition({ epic: 'GOLD' }, 'SILVER')).toBe(false);
  });
});

describe('multi-epic manageTick fail-closed', () => {
  it('soft path skips SILVER when quote is GOLD and reports skipped_epics', async () => {
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
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: 'gold-1',
      opportunity_id: 'opp-g',
      intent_id: 'i-g',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: 4400,
      stop_loss: 4390,
      take_profit: 4420,
      decision: buyDecision('d-g'),
    });
    pm.register({
      position_id: 'sil-1',
      opportunity_id: 'opp-s',
      intent_id: 'i-s',
      epic: 'SILVER',
      side: 'BUY',
      size: 1,
      entry: 30,
      stop_loss: 28,
      take_profit: 35,
      decision: buyDecision('d-s'),
    });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4401,
        ask: 4401.4,
        mid: 4401.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      },
      max_hold_ms: 0,
    });
    expect(managed.skipped_wrong_epic).toBe(1);
    expect(managed.skipped_epics).toContain('SILVER');
    expect(pm.get('sil-1')).toBeTruthy();
    expect(pm.get('gold-1')).toBeTruthy();
    // GOLD MFE may move; SILVER mfe must stay 0 (never marked with GOLD mid)
    expect(pm.get('sil-1')!.mfe).toBe(0);
  });

  it('hard_only does not STOP_HIT SILVER with a GOLD quote', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: 'sil-hard',
      opportunity_id: 'opp-sh',
      intent_id: 'i-sh',
      epic: 'SILVER',
      side: 'BUY',
      size: 1,
      entry: 30,
      stop_loss: 4400, // would trip if GOLD mid applied wrongly
      take_profit: 50,
      decision: buyDecision('d-sh'),
    });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4390,
        ask: 4390.4,
        mid: 4390.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      },
      hard_only: true,
    });
    expect(managed.closed.length).toBe(0);
    expect(managed.skipped_wrong_epic).toBe(1);
    expect(pm.count()).toBe(1);
  });

  it('stale path TIME_STOP only for matching epic', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    broker.setQuote({
      bid: 4401,
      ask: 4401.4,
      mid: 4401.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    const placed = await broker.placeOrder({
      intent_id: 'gold-stale-aaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: 4390,
      profit_level: 4420,
    });
    const goldId = placed.position_id!;
    const silId = 'sil-stale';
    pm.register({
      position_id: goldId,
      opportunity_id: 'opp-gs',
      intent_id: 'i-gs',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: 4400,
      stop_loss: 4390,
      take_profit: 4420,
      decision: buyDecision('d-gs'),
    });
    pm.register({
      position_id: silId,
      opportunity_id: 'opp-ss',
      intent_id: 'i-ss',
      epic: 'SILVER',
      side: 'BUY',
      size: 1,
      entry: 30,
      stop_loss: 28,
      take_profit: 35,
      decision: buyDecision('d-ss'),
    });
    pm.get(goldId)!.entry_at = new Date(Date.now() - 120_000).toISOString();
    pm.get(silId)!.entry_at = new Date(Date.now() - 120_000).toISOString();
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4401,
        ask: 4401.4,
        mid: 4401.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now() - 60_000,
      },
      max_hold_ms: 30_000,
      stale_quote_ms: 15_000,
    });
    expect(managed.closed.some((c) => c.position.position_id === goldId)).toBe(
      true
    );
    expect(managed.closed.some((c) => c.position.position_id === silId)).toBe(
      false
    );
    expect(pm.get(silId)).toBeTruthy();
    expect(managed.skipped_epics).toContain('SILVER');
  });

  it('portfolio close-all prices/closes only quote-matching opens', async () => {
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
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    const goldPlaced = await broker.placeOrder({
      intent_id: 'port-gold-aaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: 4390,
      profit_level: 4450,
    });
    // SILVER is local-only (not on paper broker) so close would not remove broker state
    pm.register({
      position_id: goldPlaced.position_id!,
      opportunity_id: 'opp-pg',
      intent_id: 'i-pg',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: 4400,
      stop_loss: 4390,
      take_profit: 4450,
      decision: buyDecision('d-pg'),
    });
    pm.register({
      position_id: 'sil-port',
      opportunity_id: 'opp-ps',
      intent_id: 'i-ps',
      epic: 'SILVER',
      side: 'BUY',
      size: 1,
      entry: 30,
      stop_loss: 28,
      take_profit: 40,
      decision: buyDecision('d-ps'),
    });
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4410,
        ask: 4410.4,
        mid: 4410.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      },
      close_all_profit: 1,
      instrument_point_value: 1,
    });
    expect(managed.closed.some((c) => c.position.epic === 'GOLD')).toBe(true);
    expect(managed.closed.some((c) => c.position.epic === 'SILVER')).toBe(false);
    expect(pm.get('sil-port')).toBeTruthy();
  });
});

describe('PaperBroker getQuote epic isolation', () => {
  it('does not return GOLD mid for SILVER getQuote', async () => {
    const broker = new PaperBroker();
    broker.setQuote({
      bid: 4400,
      ask: 4400.4,
      mid: 4400.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    expect(await broker.getQuote('GOLD')).toBeTruthy();
    expect(await broker.getQuote('SILVER')).toBeNull();
    broker.setQuote({
      bid: 31,
      ask: 31.05,
      mid: 31.025,
      spread: 0.05,
      epic: 'SILVER',
      ts_ms: Date.now(),
    });
    const sil = await broker.getQuote('SILVER');
    expect(sil?.mid).toBeCloseTo(31.025, 5);
    expect((await broker.getQuote('GOLD'))?.mid).toBeCloseTo(4400.2, 5);
  });
});

describe('runtime multi-epic manage + float honesty', () => {
  it('manages SILVER with its own quote and epic-scopes Float UPL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-multi-epic-manage-'));
    process.env.MASTER_STATE_DIR = dir;
    const prevEpic = masterRuntime.epic;
    const prevCfg = masterRuntime.cfg;
    const prevPositions = masterRuntime.positions;
    try {
      masterRuntime.positions = new PositionManager();
      masterRuntime.setMode('PAPER');
      masterRuntime.setEpic('GOLD');
      const broker = masterRuntime.ensurePaperBroker();
      expect(broker).toBeInstanceOf(PaperBroker);
      const paper = broker as PaperBroker;
      paper.setQuote({
        bid: 4400,
        ask: 4400.4,
        mid: 4400.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      });

      const goldPlaced = await paper.placeOrder({
        intent_id: 'rt-gold-aaaaaaaaaaaaaa',
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        stop_level: 4390,
        profit_level: 4420,
      });
      paper.setQuote({
        bid: 31.0,
        ask: 31.05,
        mid: 31.025,
        spread: 0.05,
        epic: 'SILVER',
        ts_ms: Date.now(),
      });
      const silPlaced = await paper.placeOrder({
        intent_id: 'rt-sil-aaaaaaaaaaaaaaa',
        epic: 'SILVER',
        side: 'BUY',
        size: 1,
        stop_level: 29,
        profit_level: 35,
      });
      // Keep both epics' marks available for manage-across + status
      paper.setQuote({
        bid: 31.2,
        ask: 31.25,
        mid: 31.225,
        spread: 0.05,
        epic: 'SILVER',
        ts_ms: Date.now(),
      });
      paper.setQuote({
        bid: 4405,
        ask: 4405.4,
        mid: 4405.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      });

      masterRuntime.positions.register({
        position_id: goldPlaced.position_id!,
        opportunity_id: 'opp-rt-g',
        intent_id: 'rt-gold-aaaaaaaaaaaaaa',
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        entry: 4400.4,
        stop_loss: 4390,
        take_profit: 4420,
        decision: buyDecision('d-rt-g'),
      });
      masterRuntime.positions.register({
        position_id: silPlaced.position_id!,
        opportunity_id: 'opp-rt-s',
        intent_id: 'rt-sil-aaaaaaaaaaaaaaa',
        epic: 'SILVER',
        side: 'BUY',
        size: 1,
        entry: 31.05,
        stop_loss: 29,
        take_profit: 35,
        decision: buyDecision('d-rt-s'),
      });

      const bars = Array.from({ length: 50 }, (_, i) => ({
        open: 4390 + i * 0.1,
        high: 4391 + i * 0.1,
        low: 4389 + i * 0.1,
        close: 4390.5 + i * 0.1,
        ts_ms: Date.now() - (50 - i) * 10_000,
      }));
      const goldQuote: Quote = {
        bid: 4405,
        ask: 4405.4,
        mid: 4405.2,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };

      await masterRuntime.tick(bars, goldQuote);

      const sil = masterRuntime.positions.get(silPlaced.position_id!);
      expect(sil).toBeTruthy();
      // Secondary manage used SILVER mid (~31.2), not GOLD (~4405)
      expect(sil!.mfe).toBeGreaterThan(0);
      expect(sil!.mfe).toBeLessThan(5);

      const st = masterRuntime.status();
      expect(st.floating_pnl_epic_scoped).toBe(true);
      expect(st.manage_epics.managed).toEqual(
        expect.arrayContaining(['GOLD', 'SILVER'])
      );
      expect(st.manage_epics.unmanaged_open).toEqual([]);
      const goldOnly = floatingUnrealizedPnl(
        masterRuntime.positions.list().filter((p) => p.epic === 'GOLD'),
        goldQuote,
        specForEpic('GOLD').value_per_point_per_lot,
        false
      );
      expect(st.floating_pnl).toBeCloseTo(goldOnly, 5);
    } finally {
      masterRuntime.cfg = prevCfg;
      masterRuntime.positions = prevPositions;
      masterRuntime.setEpic(prevEpic);
    }
  });
});
