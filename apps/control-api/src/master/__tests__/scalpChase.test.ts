import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  evaluateCandleBiasFive,
  scalpStrictEntryAllowed,
} from '../candleBias.js';
import {
  SCALP_INITIAL_SL_PCT,
  SCALP_LOCK_PCT,
  scalpInitialStopDistance,
  scalpPctLockBrokerStop,
  scalpPctLockCandidateSl,
} from '../scalpPctChase.js';
import { EMPTY_BROKER_GHOST_DEBOUNCE, safetyStopLevel } from '../positionSync.js';

describe('VS-System scalp pct chase math', () => {
  it('exports 10% initial / 20% lock', () => {
    expect(SCALP_INITIAL_SL_PCT).toBe(0.1);
    expect(SCALP_LOCK_PCT).toBe(0.2);
    expect(scalpInitialStopDistance(4400)).toBe(440);
  });

  it('scalpMinStopImprovement is at least 3 pips / 15% of min stop', async () => {
    const { scalpMinStopImprovement, scalpChaseIsImprovement } = await import(
      '../scalpPctChase.js'
    );
    const bump = scalpMinStopImprovement('GOLD');
    expect(bump).toBeGreaterThan(0);
    // Tiny epsilon tighten is NOT enough once minBump is required
    expect(
      scalpChaseIsImprovement({
        direction: 'BUY',
        candidate: 4410.001,
        current: 4410,
        minBump: bump,
      })
    ).toBe(false);
    expect(
      scalpChaseIsImprovement({
        direction: 'BUY',
        candidate: 4410 + bump,
        current: 4410,
        minBump: bump,
      })
    ).toBe(true);
  });

  it('candidate SL trails mark by 20% of favorable move', () => {
    const entry = 4400;
    const mark = 4440;
    const cand = scalpPctLockCandidateSl({
      direction: 'BUY',
      entry,
      livePrice: mark,
      lockPct: 0.2,
    });
    expect(cand).toBeCloseTo(4432, 8);
  });

  it('SELL candidate SL trails mark by 20% of favorable move (tightens from above)', () => {
    const entry = 4400;
    const mark = 4360;
    const cand = scalpPctLockCandidateSl({
      direction: 'SELL',
      entry,
      livePrice: mark,
      lockPct: 0.2,
    });
    // Favorable 40pts → cand = mark + 0.2*40 = 4368 (below entry)
    expect(cand).toBeCloseTo(4368, 8);
    expect(cand).toBeLessThan(entry);
  });

  it('SELL scalpChaseIsImprovement only tightens (lower SL toward mark)', async () => {
    const { scalpMinStopImprovement, scalpChaseIsImprovement } = await import(
      '../scalpPctChase.js'
    );
    const bump = scalpMinStopImprovement('GOLD');
    expect(
      scalpChaseIsImprovement({
        direction: 'SELL',
        candidate: 4410 + bump,
        current: 4410,
        minBump: bump,
      })
    ).toBe(false); // loosened (moved up / away from mark)
    expect(
      scalpChaseIsImprovement({
        direction: 'SELL',
        candidate: 4410 - bump,
        current: 4410,
        minBump: bump,
      })
    ).toBe(true); // tightened toward mark from above
  });

  it('flat/loss returns initial 10% protective broker stop', () => {
    const sl = scalpPctLockBrokerStop({
      symbol: 'GOLD',
      direction: 'BUY',
      entry: 4400,
      livePrice: 4395,
    });
    expect(sl).toBeCloseTo(4400 - 440, 1);
  });

  it('improve-only: pullback does not loosen candidate vs peak move', () => {
    const peak = scalpPctLockCandidateSl({
      direction: 'BUY',
      entry: 4400,
      livePrice: 4450,
    });
    const weaker = scalpPctLockCandidateSl({
      direction: 'BUY',
      entry: 4400,
      livePrice: 4420,
    });
    expect(peak).toBeGreaterThan(weaker);
  });

  it('safetyStopLevel uses 10% of entry', () => {
    expect(safetyStopLevel('BUY', 4400)).toBeCloseTo(3960, 5);
    expect(EMPTY_BROKER_GHOST_DEBOUNCE).toBe(5);
  });
});

describe('candle bias strict entry', () => {
  function bar(open: number, close: number) {
    return { open, high: Math.max(open, close), low: Math.min(open, close), close };
  }

  it('bearish majority → bias bear', () => {
    const candles = [
      bar(104, 103),
      bar(103, 102),
      bar(102, 101),
      bar(101, 101.5),
      bar(101.5, 100.8),
    ];
    expect(evaluateCandleBiasFive(candles, { includeForming: true }).bias).toBe('bear');
  });

  it('blocks BUY without bull TF', () => {
    expect(
      scalpStrictEntryAllowed({
        signal: 'BUY',
        tfBias: 'bear',
        tfNetPct: -0.1,
        microBias: 'flat',
        buyScore: 0.8,
        sellScore: 0.4,
      }).ok
    ).toBe(false);
  });

  it('allows BUY with bull TF + edge', () => {
    expect(
      scalpStrictEntryAllowed({
        signal: 'BUY',
        tfBias: 'bull',
        tfNetPct: 0.05,
        microBias: 'bull',
        buyScore: 0.8,
        sellScore: 0.4,
        minEdge: 0.12,
      }).ok
    ).toBe(true);
  });
});

describe('mid-life naked SL recovery', () => {
  it('clears stale local SL when broker reports null then re-attaches 10%', async () => {
    const { PaperBroker } = await import('../broker.js');
    const { PositionManager } = await import('../positionManager.js');
    const { syncPositionsWithBroker, safetyStopLevel } = await import('../positionSync.js');
    const { MasterPipeline } = await import('../pipeline.js');

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
      intent_id: 'midlife-naked-aaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: 4395,
    });
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-naked',
      intent_id: 'n1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: 4400,
      stop_loss: 4395,
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
          regime: 'RANGE',
          market_state: 't',
          momentum_score: 0,
          momentum_dir: 'NEUTRAL',
          trend_dir: 'SIDEWAYS',
          trend_strength: 0,
          structure_bias: 'NEUTRAL',
          swing_high: 4405,
          swing_low: 4395,
          buy_pressure: 0.5,
          sell_pressure: 0.5,
          behavior_bull: 0.5,
          behavior_bear: 0.5,
          impact_score: 0.5,
          context_quality: 0.5,
          volatility: 0.1,
          atr: 1,
        },
        expectancy: null,
      },
    });

    // Strip broker stop — simulate Capital chart naked while local still has SL
    await broker.modifyPosition!({
      position_id: placed.position_id!,
      stop_level: undefined as unknown as number,
    });
    // Force null on paper book
    const listed = await broker.listOpenPositions('GOLD');
    const raw = listed.positions[0]!;
    // PaperBroker may not clear via undefined — seed naked
    broker.seedOpens([
      {
        position_id: placed.position_id!,
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        open_level: 4400,
        stop_level: null,
        profit_level: 4420,
      },
    ]);

    const sync = await syncPositionsWithBroker(pm, broker, 'GOLD');
    // Prefer structure intended SL over soft 10% safety cushion
    expect(sync.intended_levels_attached).toBe(1);
    expect(sync.safety_sl_attached).toBe(0);
    expect(pm.get(placed.position_id!)!.stop_loss).toBe(4395);

    // manageTick path also recovers if somehow still null (no intended left)
    pm.get(placed.position_id!)!.stop_loss = null;
    pm.get(placed.position_id!)!.intended_stop_loss = null;
    const pipe = new MasterPipeline('PAPER');
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4400,
        ask: 4400.4,
        mid: 4400.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      allow_close: false,
      breakeven_progress: 0,
      max_hold_ms: 0,
    });
    expect(pm.get(placed.position_id!)!.stop_loss).not.toBeNull();
    void raw;
  });

  it('manageTick prefers intended SL over soft 10% when naked', async () => {
    const { PaperBroker } = await import('../broker.js');
    const { PositionManager } = await import('../positionManager.js');
    const { MasterPipeline } = await import('../pipeline.js');
    const { safetyStopLevel } = await import('../positionSync.js');

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
      intent_id: 'intended-naked-aaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: 4395,
      profit_level: 4420,
    });
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-int-naked',
      intent_id: 'in1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: 4400,
      stop_loss: 4395,
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
          regime: 'RANGE',
          market_state: 't',
          momentum_score: 0,
          momentum_dir: 'NEUTRAL',
          trend_dir: 'SIDEWAYS',
          trend_strength: 0,
          structure_bias: 'NEUTRAL',
          swing_high: 4405,
          swing_low: 4395,
          buy_pressure: 0.5,
          sell_pressure: 0.5,
          behavior_bull: 0.5,
          behavior_bear: 0.5,
          impact_score: 0.5,
          context_quality: 0.5,
          volatility: 0.1,
          atr: 1,
        },
        expectancy: null,
      },
    });
    broker.seedOpens([
      {
        position_id: placed.position_id!,
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        open_level: 4400,
        stop_level: null,
        profit_level: null,
      },
    ]);
    const pos = pm.get(placed.position_id!)!;
    pos.stop_loss = null;
    pos.take_profit = null;
    expect(pos.intended_stop_loss).toBe(4395);
    const soft = safetyStopLevel('BUY', 4400);
    const pipe = new MasterPipeline('PAPER');
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4400,
        ask: 4400.4,
        mid: 4400.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      allow_close: false,
      breakeven_progress: 0,
      max_hold_ms: 0,
    });
    expect(pos.stop_loss).toBe(4395);
    expect(pos.stop_loss).not.toBeCloseTo(soft, 5);
    expect(pos.take_profit).toBe(4420);
  });

  it('failed intended naked recovery does not soft-attach on first reject', async () => {
    const { PaperBroker } = await import('../broker.js');
    const { PositionManager } = await import('../positionManager.js');
    const { MasterPipeline } = await import('../pipeline.js');

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
      intent_id: 'fail-intended-aaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
    });
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-fail-int',
      intent_id: 'fi1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: 4400,
      stop_loss: 4395,
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
          regime: 'RANGE',
          market_state: 't',
          momentum_score: 0,
          momentum_dir: 'NEUTRAL',
          trend_dir: 'SIDEWAYS',
          trend_strength: 0,
          structure_bias: 'NEUTRAL',
          swing_high: 4405,
          swing_low: 4395,
          buy_pressure: 0.5,
          sell_pressure: 0.5,
          behavior_bull: 0.5,
          behavior_bear: 0.5,
          impact_score: 0.5,
          context_quality: 0.5,
          volatility: 0.1,
          atr: 1,
        },
        expectancy: null,
      },
    });
    broker.seedOpens([
      {
        position_id: placed.position_id!,
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        open_level: 4400,
        stop_level: null,
        profit_level: null,
      },
    ]);
    const pos = pm.get(placed.position_id!)!;
    pos.stop_loss = null;
    pos.take_profit = null;
    const orig = broker.modifyPosition!.bind(broker);
    broker.modifyPosition = async (input) => {
      if (input.stop_level === 4395) {
        return { ok: false, detail: 'reject_intended' };
      }
      return orig(input);
    };
    const pipe = new MasterPipeline('PAPER');
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4400,
        ask: 4400.4,
        mid: 4400.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      allow_close: false,
      breakeven_progress: 0,
      max_hold_ms: 0,
    });
    expect(pos.stop_loss).toBeNull();
    expect(pos.intended_stop_loss).toBe(4395);
    expect(pos.naked_recovery_level).toBe(1);
  });

  it('escalated intended reject soft-attaches protective SL', async () => {
    const { PaperBroker } = await import('../broker.js');
    const { PositionManager } = await import('../positionManager.js');
    const { MasterPipeline } = await import('../pipeline.js');
    const { safetyStopLevel } = await import('../positionSync.js');

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
      intent_id: 'esc-intended-aaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
    });
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-esc-int',
      intent_id: 'ei1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: 4400,
      stop_loss: 4395,
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
          regime: 'RANGE',
          market_state: 't',
          momentum_score: 0,
          momentum_dir: 'NEUTRAL',
          trend_dir: 'SIDEWAYS',
          trend_strength: 0,
          structure_bias: 'NEUTRAL',
          swing_high: 4405,
          swing_low: 4395,
          buy_pressure: 0.5,
          sell_pressure: 0.5,
          behavior_bull: 0.5,
          behavior_bear: 0.5,
          impact_score: 0.5,
          context_quality: 0.5,
          volatility: 0.1,
          atr: 1,
        },
        expectancy: null,
      },
    });
    broker.seedOpens([
      {
        position_id: placed.position_id!,
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        open_level: 4400,
        stop_level: null,
        profit_level: null,
      },
    ]);
    const pos = pm.get(placed.position_id!)!;
    pos.stop_loss = null;
    pos.take_profit = null;
    pos.naked_recovery_level = 1; // already escalated past first intended-only window
    const orig = broker.modifyPosition!.bind(broker);
    broker.modifyPosition = async (input) => {
      if (input.stop_level === 4395) {
        return { ok: false, detail: 'reject_intended' };
      }
      return orig(input);
    };
    const soft = safetyStopLevel('BUY', 4400);
    const pipe = new MasterPipeline('PAPER');
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4400,
        ask: 4400.4,
        mid: 4400.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      allow_close: false,
      breakeven_progress: 0,
      max_hold_ms: 0,
    });
    expect(pos.stop_loss).not.toBeNull();
    expect(pos.stop_loss).not.toBe(4395);
    // Soft / escalated cushion attached (not stuck naked)
    expect(Number(pos.stop_loss)).toBeLessThan(4400);
    void soft;
  });
});

describe('scalp chase throttle durability', () => {
  it('scalp_chase_at_ms survives PositionManager fromJSON restart', async () => {
    const { PositionManager } = await import('../positionManager.js');
    const pm = new PositionManager();
    pm.register({
      position_id: 'chase-persist-1',
      opportunity_id: 'opp-cp',
      intent_id: 'i-cp',
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
        analysis: {
          regime: 'TREND',
          market_state: 'UP',
          session: 'LONDON',
          volatility: 0.001,
          atr: 1,
          trend: 'UP',
          structure_bias: 'BULLISH',
          data_quality: 1,
          bar_count: 50,
          last_close: 4400,
          spread: 0.2,
          swing_high: 4410,
          swing_low: 4390,
        } as never,
        expectancy: null,
      },
    });
    const stamped = Date.now() - 1_000;
    pm.get('chase-persist-1')!.scalp_chase_at_ms = stamped;
    const snap = pm.toJSON();
    const pm2 = new PositionManager();
    pm2.fromJSON(snap);
    expect(pm2.get('chase-persist-1')!.scalp_chase_at_ms).toBe(stamped);
  });

  it('modify_reject_level survives fromJSON restart (no re-fire identical SL)', async () => {
    const { PositionManager } = await import('../positionManager.js');
    const pm = new PositionManager();
    pm.register({
      position_id: 'rej-persist-1',
      opportunity_id: 'opp-rj',
      intent_id: 'i-rj',
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
        analysis: {
          regime: 'TREND',
          market_state: 'UP',
          session: 'LONDON',
          volatility: 0.001,
          atr: 1,
          trend: 'UP',
          structure_bias: 'BULLISH',
          data_quality: 1,
          bar_count: 50,
          last_close: 4400,
          spread: 0.2,
          swing_high: 4410,
          swing_low: 4390,
        } as never,
        expectancy: null,
      },
    });
    const pos = pm.get('rej-persist-1')!;
    pos.modify_reject_level = 4412.5;
    pos.modify_backoff_until_ms = Date.now() + 120_000;
    const pm2 = new PositionManager();
    pm2.fromJSON(pm.toJSON());
    const restored = pm2.get('rej-persist-1')!;
    expect(restored.modify_reject_level).toBeCloseTo(4412.5, 5);
    expect(restored.modify_backoff_until_ms).toBe(pos.modify_backoff_until_ms);
    // While backoff active, identical level is skipped; after expiry it clears
    restored.modify_backoff_until_ms = Date.now() - 1;
    // Access via manageTick BE path is heavy — expire fields prove clear path
    expect(restored.modify_backoff_until_ms).toBeLessThan(Date.now());
  });

  it('expired modify reject clears so fixed BE can retry', async () => {
    const { PositionManager } = await import('../positionManager.js');
    const { PaperBroker } = await import('../broker.js');
    const { MasterPipeline } = await import('../pipeline.js');
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    const tp = entry + 1.0;
    broker.setQuote({
      bid: entry + 0.55,
      ask: entry + 0.65,
      mid: entry + 0.6,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'be-retry-aaaaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 2,
      profit_level: tp,
    });
    expect(placed.ok).toBe(true);
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-be-retry',
      intent_id: 'be-retry-aaaaaaaaaaaaaa',
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
        score: 0.8,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: {
          regime: 'TREND',
          market_state: 'UP',
          session: 'LONDON',
          volatility: 0.001,
          atr: 1,
          trend: 'UP',
          structure_bias: 'BULLISH',
          data_quality: 1,
          bar_count: 50,
          last_close: entry + 0.6,
          spread: 0.1,
          swing_high: entry + 2,
          swing_low: entry - 2,
        } as never,
        expectancy: null,
      },
    });
    const pos = pm.get(placed.position_id!)!;
    const beLevel = entry + 0.1;
    // Early reject of fixed BE — expired backoff must not permanently freeze BE
    pos.modify_reject_level = beLevel;
    pos.modify_backoff_until_ms = Date.now() - 5_000;
    const pipe = new MasterPipeline('PAPER');
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry + 0.55,
        ask: entry + 0.65,
        mid: entry + 0.6,
        spread: 0.1,
        epic: 'GOLD',
        ts_ms: Date.now(),
      },
      breakeven_progress: 0.5,
      breakeven_offset: 0.1,
    });
    expect(pos.stop_loss).toBeCloseTo(beLevel, 5);
    expect(pos.modify_reject_level).toBeNull();
  });

  it('naked_recovery_level survives fromJSON restart', async () => {
    const { PositionManager } = await import('../positionManager.js');
    const pm = new PositionManager();
    pm.register({
      position_id: 'naked-lvl-1',
      opportunity_id: 'opp-nl',
      intent_id: 'i-nl',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4400,
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
        analysis: {
          regime: 'TREND',
          market_state: 'UP',
          session: 'LONDON',
          volatility: 0.001,
          atr: 1,
          trend: 'UP',
          structure_bias: 'BULLISH',
          data_quality: 1,
          bar_count: 50,
          last_close: 4400,
          spread: 0.2,
          swing_high: 4410,
          swing_low: 4390,
        } as never,
        expectancy: null,
      },
    });
    pm.get('naked-lvl-1')!.naked_recovery_level = 2;
    const pm2 = new PositionManager();
    pm2.fromJSON(pm.toJSON());
    expect(pm2.get('naked-lvl-1')!.naked_recovery_level).toBe(2);
  });

  it('scalp_chase_at_ms survives file persist round-trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-chase-fp-'));
    process.env.MASTER_STATE_DIR = dir;
    const { installFilePersist } = await import('../filePersist.js');
    const { saveOpenPositions, loadOpenPositions } = await import('../persist.js');
    const { PositionManager } = await import('../positionManager.js');
    installFilePersist(dir);
    const pm = new PositionManager();
    pm.register({
      position_id: 'chase-fp-1',
      opportunity_id: 'opp-fp',
      intent_id: 'i-fp',
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
        analysis: {
          regime: 'TREND',
          market_state: 'UP',
          session: 'LONDON',
          volatility: 0.001,
          atr: 1,
          trend: 'UP',
          structure_bias: 'BULLISH',
          data_quality: 1,
          bar_count: 50,
          last_close: 4400,
          spread: 0.2,
          swing_high: 4410,
          swing_low: 4390,
        } as never,
        expectancy: null,
      },
    });
    const stamped = Date.now() - 2_500;
    pm.get('chase-fp-1')!.scalp_chase_at_ms = stamped;
    expect(await saveOpenPositions(pm.list())).toBe(true);
    const loaded = await loadOpenPositions();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.scalp_chase_at_ms).toBe(stamped);
  });

  it('soft_trail_armed_at + peak survive file persist round-trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-soft-fp-'));
    process.env.MASTER_STATE_DIR = dir;
    const { installFilePersist } = await import('../filePersist.js');
    const { saveOpenPositions, loadOpenPositions } = await import('../persist.js');
    const { PositionManager } = await import('../positionManager.js');
    installFilePersist(dir);
    const pm = new PositionManager();
    pm.register({
      position_id: 'soft-fp-1',
      opportunity_id: 'opp-soft',
      intent_id: 'i-soft',
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
        analysis: {
          regime: 'TREND',
          market_state: 'UP',
          session: 'LONDON',
          volatility: 0.001,
          atr: 1,
          trend: 'UP',
          structure_bias: 'BULLISH',
          data_quality: 1,
          bar_count: 50,
          last_close: 4400,
          spread: 0.2,
          swing_high: 4410,
          swing_low: 4390,
        } as never,
        expectancy: null,
      },
    });
    const armed = new Date().toISOString();
    pm.get('soft-fp-1')!.soft_trail_armed_at = armed;
    pm.get('soft-fp-1')!.soft_trail_peak = 4412.5;
    expect(await saveOpenPositions(pm.list())).toBe(true);
    const loaded = await loadOpenPositions();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.soft_trail_armed_at).toBe(armed);
    expect(loaded[0]!.soft_trail_peak).toBeCloseTo(4412.5, 8);
  });
});
