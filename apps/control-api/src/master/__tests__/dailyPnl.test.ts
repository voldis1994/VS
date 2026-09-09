import { describe, expect, it } from 'vitest';
import { PaperBroker } from '../broker.js';
import { evaluateRisk } from '../risk.js';
import { DEFAULT_MASTER_CONFIG, GOLD_SPEC, MasterPipeline } from '../pipeline.js';
import { PositionManager } from '../positionManager.js';
import { syncPositionsWithBroker } from '../positionSync.js';
import { masterRuntime } from '../runtime.js';
import type { AccountSnapshot, Quote } from '../types.js';

const account: AccountSnapshot = {
  equity: 10_000,
  balance: 10_000,
  currency: 'GBP',
  open_positions: 0,
  daily_pnl: 0,
  day_start_equity: 10_000,
  peak_equity: 10_000,
  consecutive_losses: 0,
};

describe('MASTER daily pnl day boundary', () => {
  it('max_daily_loss uses day_start_equity denom', async () => {
    const bars = Array.from({ length: 40 }, (_, i) => {
      const o = 4400 + i * 0.8;
      return { open: o, high: o + 1.2, low: o - 0.1, close: o + 0.9, ts_ms: i * 60_000 };
    });
    const pipe = new MasterPipeline('PAPER');
    const cycle = await pipe.runCycle({
      bars,
      quote: { bid: 4430, ask: 4430.4, mid: 4430.2, spread: 0.4, ts_ms: Date.now() },
      account,
      instrument: GOLD_SPEC,
      cfg: DEFAULT_MASTER_CONFIG,
    });
    const forced = {
      ...cycle.decision,
      kind: 'BUY' as const,
      side: 'BUY' as const,
      block_reason: null,
      buy: {
        ...cycle.decision.buy,
        valid: true,
        filter_ok: true,
        score: 0.9,
        entry: 4430,
        stop_loss: 4428,
        take_profit: 4435,
      },
    };
    const quote: Quote = { bid: 4430, ask: 4430.4, mid: 4430.2, spread: 0.4, ts_ms: Date.now() };
    // Closed −200 (2%) with equity still 9_800 → under 3% gate
    const ok = evaluateRisk(
      forced,
      { ...account, daily_pnl: -200, day_start_equity: 10_000, equity: 9_800 },
      GOLD_SPEC,
      quote,
      { ...DEFAULT_MASTER_CONFIG, max_daily_loss_pct: 0.03 }
    );
    expect(ok.reasons).not.toContain('max_daily_loss');
    // Closed only −200 but floating equity at 9_000 (10% drawdown) → Reader blocks
    const floatingBlocked = evaluateRisk(
      forced,
      { ...account, daily_pnl: -200, day_start_equity: 10_000, equity: 9_000 },
      GOLD_SPEC,
      quote,
      { ...DEFAULT_MASTER_CONFIG, max_daily_loss_pct: 0.03 }
    );
    expect(floatingBlocked.reasons).toContain('max_daily_loss');
    const blocked = evaluateRisk(
      forced,
      { ...account, daily_pnl: -400, day_start_equity: 10_000, equity: 9_600 },
      GOLD_SPEC,
      quote,
      { ...DEFAULT_MASTER_CONFIG, max_daily_loss_pct: 0.03 }
    );
    expect(blocked.reasons).toContain('max_daily_loss');
  });

  it('rollDailyPnl zeros prior-day losses on new UTC day', async () => {
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.ensurePaperBroker();
    masterRuntime.account.daily_pnl = -900;
    masterRuntime.account.daily_pnl_day = '2000-01-01';
    masterRuntime.account.day_start_equity = 10_000;
    // One tick rolls the day
    const bars = Array.from({ length: 30 }, (_, i) => {
      const o = 4400 + i * 0.5;
      return { open: o, high: o + 1, low: o - 0.2, close: o + 0.4, ts_ms: i * 60_000 };
    });
    const quote: Quote = {
      bid: 4415,
      ask: 4415.4,
      mid: 4415.2,
      spread: 0.4,
      ts_ms: Date.now(),
    };
    await masterRuntime.tick(bars, quote);
    expect(masterRuntime.account.daily_pnl_day).toBe(new Date().toISOString().slice(0, 10));
    expect(masterRuntime.account.daily_pnl).toBe(0);
  });

  it('manageOnlyTick rolls stale daily_pnl_day before sync-ghost close', async () => {
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'PAPER',
      time_stop_max_bars: 0,
      max_hold_ms: 86_400_000,
      post_exit_cooldown_ms: 0,
    };
    const broker = masterRuntime.ensurePaperBroker();
    broker.hydrateAccount({ equity: 10_000, balance: 10_000 });
    masterRuntime.account.equity = 10_000;
    masterRuntime.account.balance = 10_000;
    masterRuntime.account.peak_equity = 10_000;
    // Stale prior-day loss — must roll before close mutates daily_pnl
    masterRuntime.account.daily_pnl = -900;
    masterRuntime.account.daily_pnl_day = '2000-01-01';
    masterRuntime.account.day_start_equity = 10_000;
    masterRuntime.running = true;

    const entry = 4400;
    const bars = Array.from({ length: 20 }, (_, i) => ({
      open: entry,
      high: entry + 1,
      low: entry - 1,
      close: entry,
      ts_ms: Date.UTC(2026, 8, 9, 16, i),
    }));
    broker.setQuote({
      bid: entry,
      ask: entry + 0.2,
      mid: entry + 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'manage-only-day-roll-aaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 2,
      profit_level: entry + 20,
    });
    expect(placed.ok).toBe(true);
    masterRuntime.positions.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-manage-only-day-roll',
      intent_id: 'manage-only-day-roll-aaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: placed.fill_price!,
      stop_loss: entry - 2,
      take_profit: entry + 20,
      decision: {
        decision_id: 'd-day-roll',
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

    broker.setQuote({
      bid: entry - 3,
      ask: entry - 2.8,
      mid: entry - 2.9,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const bounce = {
      bid: entry + 1,
      ask: entry + 1.2,
      mid: entry + 1.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    broker.setQuote(bounce);
    await (
      masterRuntime as unknown as {
        manageOnlyTick: (b: typeof bars, q: typeof bounce) => Promise<void>;
      }
    ).manageOnlyTick(bars, bounce);

    const today = new Date().toISOString().slice(0, 10);
    expect(masterRuntime.account.daily_pnl_day).toBe(today);
    // Prior-day −900 rolled away; today's close is the STOP loss only (not −900 + loss)
    expect(masterRuntime.account.daily_pnl).toBeLessThan(0);
    expect(masterRuntime.account.daily_pnl).toBeGreaterThan(-900);
    expect(masterRuntime.positions.count()).toBe(0);
    masterRuntime.stop();
    broker.hydrateAccount({ equity: 10_000, balance: 10_000 });
  });
});

describe('MASTER per-tick ghost sync', () => {
  it('drops local ghost only after 5 consecutive empty broker lists', async () => {
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    const broker = masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('PAPER');
    masterRuntime.running = true;

    // Register local without broker position (ghost)
    const bars = Array.from({ length: 30 }, (_, i) => {
      const o = 4400 + i * 0.5;
      return { open: o, high: o + 1, low: o - 0.2, close: o + 0.4, ts_ms: i * 60_000 };
    });
    const cycle = await masterRuntime.pipeline.runCycle({
      bars,
      quote: { bid: 4415, ask: 4415.4, mid: 4415.2, spread: 0.4, ts_ms: Date.now() },
      account: masterRuntime.account,
      instrument: GOLD_SPEC,
      cfg: DEFAULT_MASTER_CONFIG,
    });
    masterRuntime.positions.register({
      position_id: 'ghost-1',
      opportunity_id: cycle.opportunity.id,
      intent_id: 'ghost-intent',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: 4410,
      stop_loss: 4405,
      decision: { ...cycle.decision, kind: 'BUY', side: 'BUY' },
    });
    expect(masterRuntime.positions.count()).toBe(1);

    const debounce = { consecutive_empty: 0 };
    const deferred = await syncPositionsWithBroker(
      masterRuntime.positions,
      broker,
      'GOLD',
      debounce
    );
    expect(deferred.ghost_drop_deferred).toBe(true);
    expect(deferred.orphans_local.length).toBe(0);
    expect(masterRuntime.positions.count()).toBe(1);

    let sync = deferred;
    for (let i = 0; i < 4; i++) {
      sync = await syncPositionsWithBroker(
        masterRuntime.positions,
        broker,
        'GOLD',
        debounce
      );
    }
    expect(sync.ghost_drop_deferred).toBe(false);
    expect(sync.orphans_local.length).toBe(1);
    expect(masterRuntime.positions.count()).toBe(0);

    // Via tick path — also journals (kill entries so we only observe ghost clear)
    masterRuntime.setKillSwitch(true);
    masterRuntime.positions.register({
      position_id: 'ghost-2',
      opportunity_id: `ghost-opp-${Date.now()}`,
      intent_id: 'ghost-intent-2',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: 4410,
      stop_loss: 4405,
      decision: { ...cycle.decision, kind: 'BUY', side: 'BUY' },
    });
    broker.setQuote({
      bid: 4415,
      ask: 4415.4,
      mid: 4415.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const q = {
      bid: 4415,
      ask: 4415.4,
      mid: 4415.2,
      spread: 0.4,
      ts_ms: Date.now(),
    };
    for (let i = 0; i < 5; i++) {
      await masterRuntime.tick(bars, q);
    }
    expect(masterRuntime.positions.count()).toBe(0);
    expect(
      masterRuntime.pipeline.journal.opportunities.some(
        (o) => o.outcome?.exit_reason === 'broker_flat'
      )
    ).toBe(true);
    masterRuntime.setKillSwitch(false);
  });

  it('defers ghost drop ×5 when missing from a non-empty broker book', async () => {
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    const broker = masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('PAPER');
    masterRuntime.running = true;

    broker.seedOpens([
      {
        position_id: 'live-other',
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        open_level: 4410,
        stop_level: 4400,
        profit_level: null,
      },
    ]);
    masterRuntime.positions.register({
      position_id: 'ghost-partial-1',
      opportunity_id: `ghost-partial-opp-${Date.now()}`,
      intent_id: 'ghost-partial-intent',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: 4410,
      stop_loss: 4405,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.5,
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
          swing_high: 4420,
          swing_low: 4400,
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

    const debounce = { consecutive_empty: 0, miss_by_id: {} as Record<string, number> };
    const first = await syncPositionsWithBroker(
      masterRuntime.positions,
      broker,
      'GOLD',
      debounce
    );
    expect(first.ghost_drop_deferred).toBe(true);
    expect(first.orphans_local.length).toBe(0);
    expect(masterRuntime.positions.get('ghost-partial-1')).toBeTruthy();
    expect(debounce.miss_by_id['ghost-partial-1']).toBe(1);

    let sync = first;
    for (let i = 0; i < 3; i++) {
      sync = await syncPositionsWithBroker(
        masterRuntime.positions,
        broker,
        'GOLD',
        debounce
      );
      expect(sync.ghost_drop_deferred).toBe(true);
      expect(masterRuntime.positions.get('ghost-partial-1')).toBeTruthy();
    }
    sync = await syncPositionsWithBroker(
      masterRuntime.positions,
      broker,
      'GOLD',
      debounce
    );
    expect(sync.ghost_drop_deferred).toBe(false);
    expect(sync.orphans_local.length).toBe(1);
    expect(masterRuntime.positions.get('ghost-partial-1')).toBeFalsy();
  });
});
