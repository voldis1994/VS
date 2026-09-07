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
});
