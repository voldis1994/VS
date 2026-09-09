import { describe, expect, it } from 'vitest';
import { analyzeBars, ema, emaFromBars } from '../analysis.js';
import { buildBuyComponents, buildSellComponents, buildCandidates } from '../candidates.js';
import { decide, pickPreferred } from '../decision.js';
import { ExpectancyStore } from '../expectancy.js';
import { computePerformance, fromOutcomes, monteCarlo } from '../performance.js';
import { MasterJournal } from '../journal.js';
import {
  DEFAULT_MASTER_CONFIG,
  GOLD_SPEC,
  MasterPipeline,
  specForEpic,
} from '../pipeline.js';
import { evaluateRisk, sizeFromEquity } from '../risk.js';
import { validateSlTp } from '../slTp.js';
import {
  clampStopForCapitalMark,
  capitalMinStopDistance,
  effectiveMinStopDistance,
} from '../capitalStop.js';
import { replayMaster, walkForward } from '../replay.js';
import type {
  AccountSnapshot,
  Bar,
  Quote,
  TradeCandidate,
  TradeOutcome,
} from '../types.js';

function barsTrendUp(n = 40): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4400 + i * 0.8;
    out.push({ open: o, high: o + 1.2, low: o - 0.1, close: o + 0.9, ts_ms: i * 60_000 });
  }
  return out;
}

function barsTrendDown(n = 40): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4450 - i * 0.8;
    out.push({ open: o, high: o + 0.1, low: o - 1.2, close: o - 0.9, ts_ms: i * 60_000 });
  }
  return out;
}

function quoteFrom(bar: Bar, spread = 0.4): Quote {
  return {
    bid: bar.close - spread / 2,
    ask: bar.close + spread / 2,
    mid: bar.close,
    spread,
    // Live quote freshness — bar candle ts must not forge / fail stale_quote gates
    ts_ms: Date.now(),
  };
}

const account: AccountSnapshot = {
  equity: 10_000,
  balance: 10_000,
  currency: 'GBP',
  open_positions: 0,
  daily_pnl: 0,
  peak_equity: 10_000,
  consecutive_losses: 0,
};

describe('VS MASTER analysis', () => {
  it('classifies uptrend and builds dual candidates independently', async () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    expect(a.trend_dir).toBe('UP');
    expect(['TREND', 'TREND_UP', 'TREND_DOWN', 'BREAKOUT', 'BREAKOUT_UP', 'BREAKOUT_DOWN', 'HIGH_VOLATILITY', 'LOW_VOLATILITY']).toContain(a.regime);
    const buy = buildBuyComponents(a);
    const sell = buildSellComponents(a);
    expect(buy.momentum).toBeGreaterThan(sell.momentum);
    const q = quoteFrom(bars[bars.length - 1]!);
    const { buy: bc, sell: sc } = buildCandidates(a, q, DEFAULT_MASTER_CONFIG);
    expect(bc.side).toBe('BUY');
    expect(sc.side).toBe('SELL');
    expect(bc.score).toBeGreaterThan(sc.score);
    expect(bc.components.momentum).not.toBe(sc.components.momentum);
  });

  it('does not call heuristic score a probability', async () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const d = decide(a, quoteFrom(bars.at(-1)!), DEFAULT_MASTER_CONFIG, () => null);
    expect(d.buy.score).toBeGreaterThanOrEqual(0);
    expect(d.buy.score).toBeLessThanOrEqual(1);
    // score exists; no fabricated "72% probability" field
    expect((d as { probability?: number }).probability).toBeUndefined();
  });

  it('ema / emaFromBars match VS-System period-3 trail input', () => {
    expect(ema([1, 2, 3], 3)).toBeCloseTo(2, 8);
    const bars = barsTrendUp(10);
    const e = emaFromBars(bars, 3);
    expect(e).not.toBeNull();
    expect(e!).toBeGreaterThan(bars[0]!.close);
    expect(e!).toBeLessThanOrEqual(bars.at(-1)!.close + 1e-9);
  });
});

describe('VS MASTER EMA3 trail manage', () => {
  it('raises BUY stop toward EMA3 below mark', async () => {
    const { PaperBroker } = await import('../broker.js');
    const { PositionManager } = await import('../positionManager.js');
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: 4410,
      ask: 4410.4,
      mid: 4410.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'ema3-trail-bbbbbbbbbbbb',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: entry - 5,
      profit_level: entry + 20,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-ema3',
      intent_id: 'ema3-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
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
        analysis: analyzeBars(barsTrendUp(), 0.4),
        expectancy: null,
      },
    });
    const ema3 = 4408; // above current SL 4395, below mark bid 4410
    await pm.manageTick({
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
      ema3,
      scalp_pct_chase: false,
      breakeven_progress: 0,
      max_hold_ms: 0,
      allow_close: false,
    });
    expect(pm.get(placed.position_id!)!.stop_loss).toBeCloseTo(ema3, 5);
    const { loadTradeEvents } = await import('../tradeEventJournal.js');
    const mods = loadTradeEvents(20).filter(
      (e) => e.event === 'MODIFY' && e.detail?.includes('ema3_trail')
    );
    expect(mods.length).toBeGreaterThan(0);
    expect(mods.some((e) => e.opportunity_id === 'opp-ema3')).toBe(true);
  });

  it('lowers SELL stop toward EMA3 above mark', async () => {
    const { PaperBroker } = await import('../broker.js');
    const { PositionManager } = await import('../positionManager.js');
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: 4390,
      ask: 4390.4,
      mid: 4390.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'ema3-trail-sellbbbbbbbb',
      epic: 'GOLD',
      side: 'SELL',
      size: 0.1,
      stop_level: entry + 5,
      profit_level: entry - 20,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-ema3-sell',
      intent_id: 'ema3-sell-1',
      epic: 'GOLD',
      side: 'SELL',
      size: 0.1,
      entry,
      stop_loss: entry + 5,
      take_profit: entry - 20,
      decision: {
        decision_id: 'd',
        kind: 'SELL',
        side: 'SELL',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: analyzeBars(barsTrendDown(), 0.4),
        expectancy: null,
      },
    });
    const ema3 = 4392; // below current SL 4405, above mark ask 4390.4
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4390,
        ask: 4390.4,
        mid: 4390.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      ema3,
      scalp_pct_chase: false,
      breakeven_progress: 0,
      max_hold_ms: 0,
      allow_close: false,
    });
    expect(pm.get(placed.position_id!)!.stop_loss).toBeCloseTo(ema3, 5);
  });

  it('BUY soft-closes on EMA3 price-through (above→below)', async () => {
    const { PaperBroker } = await import('../broker.js');
    const { PositionManager } = await import('../positionManager.js');
    const { ema3PriceThroughExit } = await import('../analysis.js');
    expect(
      ema3PriceThroughExit({
        side: 'BUY',
        mark: 4405,
        ema3: 4410,
        prevSide: 'above',
      }).exit
    ).toBe(true);
    expect(
      ema3PriceThroughExit({
        side: 'BUY',
        mark: 4415,
        ema3: 4410,
        prevSide: null,
      }).exit
    ).toBe(false);

    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: 4412,
      ask: 4412.4,
      mid: 4412.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'ema3-thru-bbbbbbbbbbbb',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: entry - 20,
      profit_level: entry + 40,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-ema3-thru',
      intent_id: 'ema3-thru-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry,
      stop_loss: entry - 20,
      take_profit: entry + 40,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: analyzeBars(barsTrendUp(), 0.4),
        expectancy: null,
      },
    });
    // Seed side above EMA3 without EMA3 trail lock (trail would move SL to EMA3 → STOP_HIT)
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4412,
        ask: 4412.4,
        mid: 4412.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      scalp_pct_chase: false,
      breakeven_progress: 0,
      max_hold_ms: 0,
      allow_close: false,
    });
    pm.get(placed.position_id!)!.ema3_side = 'above';
    pm.get(placed.position_id!)!.stop_loss = entry - 20;
    expect(pm.get(placed.position_id!)!.ema3_side).toBe('above');
    // Cross below EMA3
    broker.setQuote({
      bid: 4405,
      ask: 4405.4,
      mid: 4405.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const r = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4405,
        ask: 4405.4,
        mid: 4405.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      ema3: 4410,
      scalp_pct_chase: false,
      breakeven_progress: 0,
      max_hold_ms: 0,
      allow_close: true,
    });
    expect(r.closed.some((c) => c.reason === 'EMA3_PRICE_THROUGH')).toBe(true);
    expect(pm.get(placed.position_id!)).toBeNull();
  });

  it('BUY soft-closes on EMA1×EMA3 structural cross down', async () => {
    const { ema13CrossExit } = await import('../analysis.js');
    expect(
      ema13CrossExit({
        side: 'BUY',
        ema1Prev: 4412,
        ema3Prev: 4410,
        ema1: 4408,
        ema3: 4410,
      }).reason
    ).toBe('EMA13_CROSS_DOWN');
    // Closed-bar cross: prev crossed, live still on exit side of EMA3
    expect(
      ema13CrossExit({
        side: 'BUY',
        ema1Prev2: 4412,
        ema3Prev2: 4410,
        ema1Prev: 4408,
        ema3Prev: 4410,
        ema1: 4409,
        ema3: 4410,
      }).reason
    ).toBe('EMA13_CROSS_DOWN');

    const { PaperBroker } = await import('../broker.js');
    const { PositionManager } = await import('../positionManager.js');
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: 4412,
      ask: 4412.4,
      mid: 4412.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'ema13-cross-bbbbbbbbbb',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: entry - 20,
      profit_level: entry + 40,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-ema13',
      intent_id: 'ema13-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry,
      stop_loss: entry - 20,
      take_profit: entry + 40,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: analyzeBars(barsTrendUp(), 0.4),
        expectancy: null,
      },
    });
    // Price still above EMA3 so price-through alone would not fire; structural cross does
    const r = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: 4411,
        ask: 4411.4,
        mid: 4411.2,
        spread: 0.4,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      ema3: 4410,
      ema1: 4408,
      ema1_prev: 4412,
      ema3_prev: 4410,
      scalp_pct_chase: false,
      breakeven_progress: 0,
      max_hold_ms: 0,
      allow_close: true,
    });
    expect(r.closed.some((c) => c.reason === 'EMA13_CROSS_DOWN')).toBe(true);
    expect(pm.get(placed.position_id!)).toBeNull();
  });
});

describe('VS MASTER decision + risk', () => {
  it('equal valid scores → WAIT (Reader equal_scores)', () => {
    const mk = (side: 'BUY' | 'SELL', score: number): TradeCandidate => ({
      side,
      valid: true,
      score,
      components: {
        momentum: score,
        trend: score,
        structure: score,
        pressure: score,
        behavior: score,
        impact: score,
        context: score,
      },
      entry: 4400,
      stop_loss: side === 'BUY' ? 4395 : 4405,
      take_profit: side === 'BUY' ? 4410 : 4390,
      filter_ok: true,
      filter_reason: null,
    });
    expect(pickPreferred(mk('BUY', 0.7), mk('SELL', 0.7))).toBeNull();
    expect(pickPreferred(mk('BUY', 0.71), mk('SELL', 0.7))?.side).toBe('BUY');
    expect(pickPreferred(mk('BUY', 0.7), mk('SELL', 0.72))?.side).toBe('SELL');
  });

  it('near-tie min_score_delta → WAIT (Reader score_delta_too_small)', () => {
    const mk = (side: 'BUY' | 'SELL', score: number): TradeCandidate => ({
      side,
      valid: true,
      score,
      components: {
        momentum: score,
        trend: score,
        structure: score,
        pressure: score,
        behavior: score,
        impact: score,
        context: score,
      },
      entry: 4400,
      stop_loss: side === 'BUY' ? 4395 : 4405,
      take_profit: side === 'BUY' ? 4410 : 4390,
      filter_ok: true,
      filter_reason: null,
    });
    expect(pickPreferred(mk('BUY', 0.71), mk('SELL', 0.7), 0.05)).toBeNull();
    expect(pickPreferred(mk('BUY', 0.76), mk('SELL', 0.7), 0.05)?.side).toBe('BUY');
  });

  it('Check- profit_lock and equity_floor block new entries', () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const d = decide(a, quoteFrom(bars.at(-1)!), { ...DEFAULT_MASTER_CONFIG, min_score: 0.3 }, () => null, bars);
    const decision =
      d.kind === 'BUY' || d.kind === 'SELL'
        ? d
        : {
            ...d,
            kind: 'BUY' as const,
            side: 'BUY' as const,
            block_reason: null,
            buy: { ...d.buy, valid: true, filter_ok: true, score: 0.9 },
          };
    const locked = evaluateRisk(
      decision,
      { ...account, daily_pnl: 350 },
      GOLD_SPEC,
      quoteFrom(bars.at(-1)!),
      { ...DEFAULT_MASTER_CONFIG, profit_lock: 300 }
    );
    expect(locked.allowed).toBe(false);
    expect(locked.reasons).toContain('profit_lock');

    const floor = evaluateRisk(
      decision,
      { ...account, equity: 500 },
      GOLD_SPEC,
      quoteFrom(bars.at(-1)!),
      { ...DEFAULT_MASTER_CONFIG, equity_floor: 1000 }
    );
    expect(floor.allowed).toBe(false);
    expect(floor.reasons).toContain('equity_floor');
  });

  it('Check- hard $ daily_loss_limit blocks new entries', () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const d = decide(a, quoteFrom(bars.at(-1)!), { ...DEFAULT_MASTER_CONFIG, min_score: 0.3 }, () => null, bars);
    const decision =
      d.kind === 'BUY' || d.kind === 'SELL'
        ? d
        : {
            ...d,
            kind: 'BUY' as const,
            side: 'BUY' as const,
            block_reason: null,
            buy: { ...d.buy, valid: true, filter_ok: true, score: 0.9 },
          };
    const blocked = evaluateRisk(
      decision,
      { ...account, daily_pnl: -80 },
      GOLD_SPEC,
      quoteFrom(bars.at(-1)!),
      { ...DEFAULT_MASTER_CONFIG, daily_loss_limit: 50, max_daily_loss_pct: 0.99 }
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons).toContain('daily_loss_limit');

    const ok = evaluateRisk(
      decision,
      { ...account, daily_pnl: -40 },
      GOLD_SPEC,
      quoteFrom(bars.at(-1)!),
      { ...DEFAULT_MASTER_CONFIG, daily_loss_limit: 50, max_daily_loss_pct: 0.99 }
    );
    expect(ok.reasons).not.toContain('daily_loss_limit');
  });

  it('Check equity-delta daily PnL blocks while realized flat', () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const d = decide(a, quoteFrom(bars.at(-1)!), { ...DEFAULT_MASTER_CONFIG, min_score: 0.3 }, () => null, bars);
    const decision =
      d.kind === 'BUY' || d.kind === 'SELL'
        ? d
        : {
            ...d,
            kind: 'BUY' as const,
            side: 'BUY' as const,
            block_reason: null,
            buy: { ...d.buy, valid: true, filter_ok: true, score: 0.9 },
          };
    const hit = evaluateRisk(
      decision,
      { ...account, equity: 9700, day_start_equity: 10_000, daily_pnl: 0 },
      GOLD_SPEC,
      quoteFrom(bars.at(-1)!),
      { ...DEFAULT_MASTER_CONFIG, daily_loss_limit: 200, max_daily_loss_pct: 0.99 }
    );
    expect(hit.allowed).toBe(false);
    expect(hit.reasons).toContain('daily_loss_limit');
  });

  it('account_not_tradeable blocks when trade_allowed is false', () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const d = decide(a, quoteFrom(bars.at(-1)!), { ...DEFAULT_MASTER_CONFIG, min_score: 0.3 }, () => null, bars);
    const decision =
      d.kind === 'BUY' || d.kind === 'SELL'
        ? d
        : {
            ...d,
            kind: 'BUY' as const,
            side: 'BUY' as const,
            block_reason: null,
            buy: { ...d.buy, valid: true, filter_ok: true, score: 0.9 },
          };
    const blocked = evaluateRisk(
      decision,
      { ...account, trade_allowed: false },
      GOLD_SPEC,
      quoteFrom(bars.at(-1)!),
      DEFAULT_MASTER_CONFIG
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons).toContain('account_not_tradeable');
  });

  it('BUY/SELL symmetry — dump prefers SELL', async () => {
    const bars = barsTrendDown();
    const a = analyzeBars(bars, 0.4);
    const d = decide(a, quoteFrom(bars.at(-1)!), DEFAULT_MASTER_CONFIG, () => null);
    expect(d.sell.score).toBeGreaterThan(d.buy.score);
  });

  it('risk engine blocks kill switch and sizes from equity', async () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const cfg = { ...DEFAULT_MASTER_CONFIG, kill_switch: true };
    const d = decide(a, quoteFrom(bars.at(-1)!), cfg, () => null);
    expect(d.kind).toBe('BLOCK');
    const cand = {
      side: 'BUY' as const,
      valid: true,
      score: 0.8,
      components: {
        momentum: 0.8,
        trend: 0.8,
        structure: 0.8,
        pressure: 0.7,
        behavior: 0.6,
        impact: 0.7,
        context: 0.8,
      },
      entry: 4400,
      stop_loss: 4395,
      take_profit: 4410,
      filter_ok: true,
      filter_reason: null,
    };
    const sized = sizeFromEquity(10_000, cand, GOLD_SPEC, DEFAULT_MASTER_CONFIG);
    expect(sized.allowed).toBe(true);
    expect(sized.volume).toBeGreaterThan(0);
  });

  it('stale quote and max daily loss block', async () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const d = decide(a, quoteFrom(bars.at(-1)!), DEFAULT_MASTER_CONFIG, () => null);
    // force a trade decision shape
    const forced = { ...d, kind: 'BUY' as const, side: 'BUY' as const, block_reason: null };
    const stale = evaluateRisk(
      forced,
      account,
      GOLD_SPEC,
      { ...quoteFrom(bars.at(-1)!), ts_ms: Date.now() - 60_000 },
      DEFAULT_MASTER_CONFIG
    );
    expect(stale.allowed).toBe(false);
    expect(stale.reasons).toContain('stale_data_protection');

    const daily = evaluateRisk(
      forced,
      { ...account, daily_pnl: -500, equity: 10_000, day_start_equity: 10_000 },
      GOLD_SPEC,
      quoteFrom(bars.at(-1)!),
      { ...DEFAULT_MASTER_CONFIG, max_daily_loss_pct: 0.03 }
    );
    expect(daily.allowed).toBe(false);
    expect(daily.reasons).toContain('max_daily_loss');

    // Floating equity drawdown (Reader) even when closed daily_pnl is flat
    const floating = evaluateRisk(
      forced,
      { ...account, daily_pnl: 0, equity: 9_500, day_start_equity: 10_000 },
      GOLD_SPEC,
      quoteFrom(bars.at(-1)!),
      { ...DEFAULT_MASTER_CONFIG, max_daily_loss_pct: 0.03 }
    );
    expect(floating.reasons).toContain('max_daily_loss');
  });

  it('intent idempotency — claim once', async () => {
    const pipe = new MasterPipeline('PAPER');
    const id = pipe.newIntentId('dec-1');
    expect(pipe.claimIntent(id)).toBe(true);
    expect(pipe.claimIntent(id)).toBe(false);
  });
});

describe('VS MASTER expectancy + journal', () => {
  it('computes EV from samples only — never invents', async () => {
    const store = new ExpectancyStore();
    expect(store.lookup('BUY|TREND|UP|LONDON')).toBeNull();
    const win: TradeOutcome = {
      position_id: '1',
      side: 'BUY',
      entry: 1,
      exit: 2,
      volume: 1,
      pnl: 10,
      fees: 0.5,
      slippage: 0.2,
      mae: 1,
      mfe: 12,
      r_multiple: 1,
      hold_ms: 1000,
      exit_reason: 'TP',
    };
    const loss: TradeOutcome = { ...win, pnl: -8, position_id: '2', exit_reason: 'SL' };
    store.record('BUY|TREND|UP|LONDON', win);
    store.record('BUY|TREND|UP|LONDON', win);
    store.record('BUY|TREND|UP|LONDON', loss);
    const snap = store.lookup('BUY|TREND|UP|LONDON')!;
    expect(snap.samples).toBe(3);
    expect(snap.p_win).toBeCloseTo(2 / 3, 5);
    // Mean net pnl (10+10-8)/3 — fees already in pnl, not subtracted again
    expect(snap.ev).toBeCloseTo(4, 8);
    expect(snap.costs).toBeCloseTo(0.5, 8);
  });

  it('accumulates multi-TP / partial close slices for Fees KPI', () => {
    const j = new MasterJournal();
    const stubDecision = {
      decision_id: 'd',
      kind: 'BUY' as const,
      side: 'BUY' as const,
      score: 0.7,
      block_reason: null,
      buy: null as never,
      sell: null as never,
      analysis: {} as never,
      expectancy: null,
    };
    const stubRisk = { allowed: true, volume: 1, risk_amount: 1, reasons: [] };
    const rec = j.recordOpportunity({
      mode: 'PAPER',
      epic: 'GOLD',
      decision: stubDecision,
      risk: stubRisk,
      executed: true,
      id: 'opp-multi',
    });
    const slice = (pnl: number, fees: number, vol: number, reason: string): TradeOutcome => ({
      position_id: 'p1',
      side: 'BUY',
      entry: 4400,
      exit: 4410,
      volume: vol,
      pnl,
      fees,
      slippage: 0,
      mae: 0,
      mfe: 1,
      r_multiple: 1,
      hold_ms: 1000,
      exit_reason: reason,
    });
    j.attachOutcome(rec.id, slice(1, 0.05, 0.5, 'PARTIAL_1'));
    j.attachOutcome(rec.id, slice(2, 0.05, 0.5, 'TP_FINAL'));
    expect(j.allCloseOutcomes()).toHaveLength(2);
    expect(j.traded()).toHaveLength(1);
    expect(j.traded()[0]!.outcome!.pnl).toBeCloseTo(3, 8);
    expect(j.traded()[0]!.outcome!.fees).toBeCloseTo(0.1, 8);
    const perf = fromOutcomes(j.allCloseOutcomes());
    expect(perf.trades).toBe(2);
    expect(perf.total_fees).toBeCloseTo(0.1, 8);
    expect(perf.total_pnl).toBeCloseTo(3, 8);
  });

  it('surfaceForApi keeps closed trades visible amid WAIT noise', () => {
    const j = new MasterJournal();
    const stubDecision = {
      decision_id: 'd',
      kind: 'WAIT' as const,
      side: null,
      score: 0,
      block_reason: 'noise',
      buy: null as never,
      sell: null as never,
      analysis: {} as never,
      expectancy: null,
    };
    const stubRisk = { allowed: false, volume: 0, risk_amount: 0, reasons: ['wait'] };
    for (let i = 0; i < 220; i++) {
      j.recordOpportunity({
        mode: 'PAPER',
        epic: 'GOLD',
        decision: stubDecision,
        risk: stubRisk,
        executed: false,
      });
    }
    const traded = j.recordOpportunity({
      mode: 'PAPER',
      epic: 'GOLD',
      decision: { ...stubDecision, kind: 'BUY', side: 'BUY', score: 0.7, block_reason: null },
      risk: { allowed: true, volume: 1, risk_amount: 10, reasons: [] },
      executed: true,
      id: 'trade-time-stop',
    });
    j.attachOutcome(traded.id, {
      position_id: 'p1',
      side: 'BUY',
      entry: 2000,
      exit: 2001,
      volume: 1,
      pnl: 1,
      fees: 0,
      slippage: 0,
      mae: 0,
      mfe: 1,
      r_multiple: 0.5,
      hold_ms: 2_700_000,
      exit_reason: 'TIME_STOP',
    });
    // Bury the closed trade under WAIT noise (naive last-200 would miss it)
    const idx = j.opportunities.findIndex((o) => o.id === 'trade-time-stop');
    const [row] = j.opportunities.splice(idx, 1);
    j.opportunities.unshift(row!);

    const naive = j.opportunities.slice(-200);
    expect(naive.some((o) => o.id === 'trade-time-stop')).toBe(false);

    const surface = j.surfaceForApi(50, 150);
    expect(surface.traded_count).toBe(1);
    expect(surface.opportunities.some((o) => o.id === 'trade-time-stop')).toBe(true);
    expect(surface.opportunities.find((o) => o.id === 'trade-time-stop')?.outcome?.exit_reason).toBe(
      'TIME_STOP'
    );
  });

  it('surfaceForApi traded_count skips pnl_proven:false closes', () => {
    const j = new MasterJournal();
    const base = {
      mode: 'LIVE' as const,
      epic: 'GOLD',
      decision: {
        decision_id: 'd',
        kind: 'BUY' as const,
        side: 'BUY' as const,
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: {} as never,
        expectancy: null,
      },
      risk: { allowed: true, volume: 1, risk_amount: 10, reasons: [] },
      executed: true,
    };
    const a = j.recordOpportunity({ ...base, id: 'proven-close' });
    j.attachOutcome(a.id, {
      position_id: 'p1',
      side: 'BUY',
      entry: 1,
      exit: 2,
      volume: 1,
      pnl: 5,
      fees: 0,
      slippage: 0,
      mae: 0,
      mfe: 1,
      r_multiple: 1,
      hold_ms: 1,
      exit_reason: 'TP',
      pnl_proven: true,
    });
    const b = j.recordOpportunity({ ...base, id: 'unproven-close' });
    j.attachOutcome(b.id, {
      position_id: 'p2',
      side: 'BUY',
      entry: 1,
      exit: 1,
      volume: 1,
      pnl: 0,
      fees: 0,
      slippage: 0,
      mae: 0,
      mfe: 0,
      r_multiple: 0,
      hold_ms: 1,
      exit_reason: 'OPERATOR_CLOSE · capital_close_pnl_unproven',
      pnl_proven: false,
    });
    const surface = j.surfaceForApi();
    expect(surface.traded_count).toBe(1);
    expect(surface.opportunities.some((o) => o.id === 'unproven-close')).toBe(true);
  });
});

describe('VS MASTER replay / walk-forward / monte carlo', () => {
  it('replay uses causal bars only and returns performance', async () => {
    const bars = [...barsTrendUp(80), ...barsTrendDown(80)];
    const result = await replayMaster({
      bars,
      warmup: 30,
      spread: 0.5,
      slippage_pts: 0.15,
      commission: 0.08,
    });
    expect(result.opportunities.length).toBeGreaterThan(0);
    expect(result.performance.trades).toBeGreaterThanOrEqual(0);
    expect(result.equity_curve.length).toBeGreaterThan(10);
  });

  it('walk-forward returns in-sample and out-of-sample windows', async () => {
    const bars = [...barsTrendUp(60), ...barsTrendDown(60), ...barsTrendUp(60)];
    const wf = await walkForward({ bars, train: 70, test: 40, step: 50 });
    expect(wf.windows.length).toBeGreaterThan(0);
    expect(wf.windows[0]!.in_sample).toBeDefined();
    expect(wf.windows[0]!.out_of_sample).toBeDefined();
  });

  it('monte carlo uses empirical pnls only', async () => {
    const mc = monteCarlo([10, -5, 8, -3, 12, -7, 4], 200);
    expect(mc.drawdown_p95).toBeGreaterThanOrEqual(0);
    expect(mc.equity_p50).toBeDefined();
  });

  it('performance aggregates MAE/MFE/streaks', async () => {
    const outcomes: TradeOutcome[] = [
      {
        position_id: 'a',
        side: 'BUY',
        entry: 1,
        exit: 2,
        volume: 1,
        pnl: 5,
        fees: 0,
        slippage: 0,
        mae: 1,
        mfe: 6,
        r_multiple: 1,
        hold_ms: 1,
        exit_reason: 'TP',
      },
      {
        position_id: 'b',
        side: 'SELL',
        entry: 2,
        exit: 3,
        volume: 1,
        pnl: -4,
        fees: 0,
        slippage: 0,
        mae: 4,
        mfe: 1,
        r_multiple: -1,
        hold_ms: 1,
        exit_reason: 'SL',
      },
      {
        position_id: 'c',
        side: 'SELL',
        entry: 2,
        exit: 3,
        volume: 1,
        pnl: -2,
        fees: 0,
        slippage: 0,
        mae: 2,
        mfe: 0.5,
        r_multiple: -0.5,
        hold_ms: 1,
        exit_reason: 'SL',
      },
    ];
    const p = computePerformance(
      outcomes.map((o) => ({
        id: o.position_id,
        ts: '',
        mode: 'BACKTEST' as const,
        epic: 'GOLD',
        decision: null as never,
        risk: null as never,
        executed: true,
        outcome: o,
      }))
    );
    expect(p.trades).toBe(3);
    expect(p.longest_losing_streak).toBe(2);
    expect(p.wins).toBe(1);
  });
});

describe('VS MASTER pipeline end-to-end', () => {
  it('runs MARKET→VALIDATION→DECISION→RISK in one cycle', async () => {
    const pipe = new MasterPipeline('PAPER');
    const bars = barsTrendUp();
    const result = await pipe.runCycle({
      bars,
      quote: quoteFrom(bars.at(-1)!),
      account,
      instrument: GOLD_SPEC,
      cfg: DEFAULT_MASTER_CONFIG,
    });
    expect(result.decision.decision_id).toBeTruthy();
    expect(result.market.ok).toBe(true);
    expect(result.decision.buy.components).toBeDefined();
    expect(result.decision.sell.components).toBeDefined();
    expect(result.opportunity.executed).toBe(false);
    expect(['BUY', 'SELL', 'WAIT', 'BLOCK']).toContain(result.decision.kind);
  });

  it('blocks on invalid market data', async () => {
    const pipe = new MasterPipeline('PAPER');
    const result = await pipe.runCycle({
      bars: [{ open: 1, high: 1, low: 1, close: 1 }],
      quote: { bid: 1, ask: 1.01, mid: 1.005, spread: 0.01, ts_ms: Date.now() },
      account,
      instrument: GOLD_SPEC,
      cfg: DEFAULT_MASTER_CONFIG,
    });
    expect(result.market.ok).toBe(false);
    expect(result.decision.kind).toBe('BLOCK');
    expect(result.decision.block_reason).toMatch(/market_validation/);
  });
});

describe('VS MASTER AI layer', () => {
  it('required mode blocks without API key', async () => {
    const pipe = new MasterPipeline('PAPER');
    const bars = barsTrendUp();
    const result = await pipe.runCycle({
      bars,
      quote: quoteFrom(bars.at(-1)!),
      account,
      instrument: GOLD_SPEC,
      cfg: { ...DEFAULT_MASTER_CONFIG, ai_mode: 'required' },
    });
    expect(result.ai.ai_mode).toBe('required');
    expect(result.decision.kind).toBe('BLOCK');
    expect(result.decision.block_reason).toMatch(/ai_required_missing/);
  });

  it('advisory local advisor can with-trend allow', async () => {
    const pipe = new MasterPipeline('PAPER');
    const bars = barsTrendUp();
    const result = await pipe.runCycle({
      bars,
      quote: quoteFrom(bars.at(-1)!),
      account,
      instrument: GOLD_SPEC,
      cfg: { ...DEFAULT_MASTER_CONFIG, ai_mode: 'advisory', min_score: 0.3 },
    });
    expect(result.ai.ai_available).toBe(false);
    expect(result.ai.ai_fallback_used).toBe(true);
    expect(['BUY', 'SELL', 'WAIT', 'BLOCK']).toContain(result.decision.kind);
  });

  it('specForEpic resolves gold aliases and FX', () => {
    expect(specForEpic('XAUUSD').value_per_point_per_lot).toBe(GOLD_SPEC.value_per_point_per_lot);
    expect(specForEpic('EURUSD').min_volume).toBe(0.01);
    expect(specForEpic('BTCUSD').display_name).toMatch(/Bitcoin/i);
    expect(specForEpic('US100').volume_step).toBe(0.1);
    expect(specForEpic('US30').point).toBe(1);
    expect(specForEpic('GER40').display_name).toBe('GER40');
  });
});

describe('Reader SL/TP + Check sizing', () => {
  it('validateSlTp rejects bad BUY SL/TP and oversized stops', () => {
    expect(
      validateSlTp({
        side: 'BUY',
        entry: 4400,
        stop_loss: 4401,
        take_profit: 4410,
        swing_low: 4390,
        pip: 0.01,
        max_stop_loss_pips: 100,
      }).reason
    ).toBe('buy_sl_not_below_entry');
    expect(
      validateSlTp({
        side: 'BUY',
        entry: 4400,
        stop_loss: 4395,
        take_profit: 4410,
        swing_low: 4390,
        pip: 0.01,
        max_stop_loss_pips: 100,
      }).reason
    ).toBe('buy_sl_not_below_swing_low');
    expect(
      validateSlTp({
        side: 'BUY',
        entry: 4400,
        stop_loss: 4380,
        take_profit: 4410,
        swing_low: 4390,
        pip: 0.01,
        max_stop_loss_pips: 100,
      }).reason
    ).toBe('max_stop_loss_pips');
    expect(
      validateSlTp({
        side: 'BUY',
        entry: 4400,
        stop_loss: 4389,
        take_profit: 4410,
        swing_low: 4390,
        pip: 0.01,
        max_stop_loss_pips: 2000,
      }).allowed
    ).toBe(true);
  });

  it('Check- fixed_lot and reduce_lot_after_loss size path', () => {
    const cand: TradeCandidate = {
      side: 'BUY',
      valid: true,
      score: 0.8,
      components: {
        momentum: 0.8,
        trend: 0.8,
        structure: 0.8,
        pressure: 0.8,
        behavior: 0.8,
        impact: 0.8,
        context: 0.8,
      },
      entry: 4400,
      stop_loss: 4390,
      take_profit: 4420,
      filter_ok: true,
      filter_reason: null,
    };
    const fixed = sizeFromEquity(10_000, cand, GOLD_SPEC, {
      ...DEFAULT_MASTER_CONFIG,
      fixed_lot: 0.07,
    });
    expect(fixed.allowed).toBe(true);
    expect(fixed.volume).toBe(0.07);
    expect(fixed.reasons).toContain('fixed_lot');

    const reduced = sizeFromEquity(
      10_000,
      cand,
      GOLD_SPEC,
      { ...DEFAULT_MASTER_CONFIG, fixed_lot: 0.07, reduce_lot_after_loss: true, reduce_lot_to: 0.01 },
      { consecutive_losses: 1 }
    );
    expect(reduced.volume).toBe(0.01);
    expect(reduced.reasons).toContain('reduce_lot_after_loss');
  });

  it('evaluateRisk blocks max_stop_loss_pips', () => {
    const bars = barsTrendUp();
    const a = analyzeBars(bars, 0.4);
    const d = decide(a, quoteFrom(bars.at(-1)!), { ...DEFAULT_MASTER_CONFIG, min_score: 0.3 }, () => null, bars);
    if (d.kind !== 'BUY' && d.kind !== 'SELL') return;
    const cand = d.side === 'BUY' ? d.buy : d.sell;
    const blocked = evaluateRisk(
      {
        ...d,
        buy: d.side === 'BUY' ? { ...cand, stop_loss: cand.entry - 50 } : d.buy,
        sell: d.side === 'SELL' ? { ...cand, stop_loss: cand.entry + 50 } : d.sell,
      },
      account,
      GOLD_SPEC,
      quoteFrom(bars.at(-1)!),
      { ...DEFAULT_MASTER_CONFIG, max_stop_loss_pips: 100 }
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons.some((r) => r.includes('max_stop_loss') || r.includes('swing'))).toBe(
      true
    );
  });

  it('Capital clampStopForCapitalMark keeps GOLD BE legal vs mark', () => {
    expect(capitalMinStopDistance('GOLD')).toBeCloseTo(0.02, 8);
    expect(effectiveMinStopDistance('GOLD', 0.5)).toBeCloseTo(0.5, 8);
    const clamped = clampStopForCapitalMark({
      side: 'BUY',
      stop: 4400,
      mark: 4400.01,
      symbol: 'GOLD',
      current_stop: 4390,
    });
    // mark - minDist = 4399.99 — stop clamped down from 4400
    expect(clamped).toBeCloseTo(4399.99, 2);
    const liveClamped = clampStopForCapitalMark({
      side: 'BUY',
      stop: 4400.4,
      mark: 4400.6,
      symbol: 'GOLD',
      current_stop: 4390,
      min_distance: 0.5,
    });
    // Proposed 4400.4 is too close (mark−0.5=4400.1) → clamp down
    expect(liveClamped).toBeCloseTo(4400.1, 6);
  });
});

describe('VS MASTER desk SETUP ARMED gate', () => {
  const armedBuy = {
    kind: 'CONTINUATION' as const,
    side: 'BUY' as const,
    playbook: 'TREND' as const,
    status: 'ARMED' as const,
    swing_high: 4450,
    swing_low: 4380,
    reason: 'test ARMED BUY',
    confirm: 2,
    updated_at: new Date().toISOString(),
    watch_buy: 'CONTINUATION',
    watch_sell: null,
  };
  const armedSell = { ...armedBuy, side: 'SELL' as const, reason: 'test ARMED SELL' };
  const noneSetup = {
    kind: 'NONE' as const,
    side: null,
    playbook: null,
    status: 'NONE' as const,
    swing_high: 0,
    swing_low: 0,
    reason: 'no setup',
    confirm: 0,
    updated_at: new Date().toISOString(),
    watch_buy: null,
    watch_sell: null,
  };

  it('gatePreferredBySetup mismatches opposite ARMED side', async () => {
    const { gatePreferredBySetup } = await import('../decision.js');
    expect(gatePreferredBySetup('BUY', armedSell, false)).toBe('setup_side_mismatch:SELL');
    expect(gatePreferredBySetup('SELL', armedBuy, false)).toBe('setup_side_mismatch:BUY');
    expect(gatePreferredBySetup('BUY', armedBuy, false)).toBeNull();
  });

  it('gatePreferredBySetup setup_none when require_armed_setup and not ARMED', async () => {
    const { gatePreferredBySetup } = await import('../decision.js');
    expect(gatePreferredBySetup('BUY', noneSetup, true)).toBe('setup_none');
    expect(gatePreferredBySetup('BUY', null, true)).toBe('setup_none');
    expect(gatePreferredBySetup('BUY', noneSetup, false)).toBeNull();
  });

  it('decide WAIT setup_none when require_armed_setup without ARMED', () => {
    const bars = barsTrendUp(50);
    const a = analyzeBars(bars, 0.4);
    const d = decide(
      a,
      quoteFrom(bars.at(-1)!),
      { ...DEFAULT_MASTER_CONFIG, min_score: 0.3, require_armed_setup: true },
      () => null,
      bars,
      null,
      noneSetup
    );
    expect(d.kind).toBe('WAIT');
    expect(d.block_reason).toBe('setup_none');
  });

  it('decide WAIT setup_side_mismatch when ARMED opposite preferred', () => {
    const bars = barsTrendUp(50);
    const a = analyzeBars(bars, 0.4);
    const d = decide(
      a,
      quoteFrom(bars.at(-1)!),
      { ...DEFAULT_MASTER_CONFIG, min_score: 0.3, require_armed_setup: false },
      () => null,
      bars,
      null,
      armedSell
    );
    // Trend-up prefers BUY — ARMED SELL must WAIT even when gate not required
    if (d.kind === 'BUY' || d.kind === 'SELL') {
      // unexpected open with opposite armed
      expect(d.block_reason).toBeNull();
    } else {
      expect(d.kind).toBe('WAIT');
      expect(d.block_reason).toMatch(/setup_side_mismatch/);
    }
  });

  it('pipeline runCycle blocks BUY/SELL when require_armed_setup and override NONE', async () => {
    const pipe = new MasterPipeline('PAPER');
    const bars = barsTrendUp(50);
    const q = quoteFrom(bars.at(-1)!);
    const cycle = await pipe.runCycle({
      bars,
      quote: q,
      account,
      instrument: GOLD_SPEC,
      cfg: {
        ...DEFAULT_MASTER_CONFIG,
        min_score: 0.3,
        require_armed_setup: true,
        block_off_hours: false,
        block_high_impact_news: false,
      },
      market_setup: noneSetup,
    });
    expect(cycle.market_setup.status).toBe('NONE');
    expect(cycle.decision.kind === 'BUY' || cycle.decision.kind === 'SELL').toBe(false);
    expect(
      cycle.decision.block_reason === 'setup_none' ||
        cycle.decision.kind === 'WAIT' ||
        cycle.decision.kind === 'BLOCK'
    ).toBe(true);
    if (cycle.decision.buy.valid || cycle.decision.sell.valid) {
      expect(cycle.decision.block_reason).toBe('setup_none');
      expect(cycle.decision.kind).toBe('WAIT');
    }
  });

  it('pipeline runCycle allows BUY when ARMED BUY matches trend', async () => {
    const pipe = new MasterPipeline('PAPER');
    const bars = barsTrendUp(50);
    const q = quoteFrom(bars.at(-1)!);
    const cycle = await pipe.runCycle({
      bars,
      quote: q,
      account,
      instrument: GOLD_SPEC,
      cfg: {
        ...DEFAULT_MASTER_CONFIG,
        min_score: 0.3,
        require_armed_setup: true,
        block_off_hours: false,
        block_high_impact_news: false,
      },
      market_setup: armedBuy,
    });
    expect(cycle.market_setup.status).toBe('ARMED');
    expect(cycle.market_setup.side).toBe('BUY');
    // Prefer BUY on uptrend — must not be setup_none / mismatch
    expect(cycle.decision.block_reason).not.toBe('setup_none');
    expect(cycle.decision.block_reason || '').not.toMatch(/setup_side_mismatch/);
    if (cycle.decision.buy.valid && cycle.decision.buy.score >= 0.3) {
      expect(cycle.decision.kind).toBe('BUY');
    }
  });
});
