import { describe, expect, it } from 'vitest';
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
    expect(sync.safety_sl_attached).toBe(1);
    const expected = safetyStopLevel('BUY', 4400);
    expect(pm.get(placed.position_id!)!.stop_loss).toBeCloseTo(expected, 5);

    // manageTick path also recovers if somehow still null
    pm.get(placed.position_id!)!.stop_loss = null;
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
    expect(pm.get(placed.position_id!)!.stop_loss).toBeCloseTo(expected, 5);
    void raw;
  });
});
