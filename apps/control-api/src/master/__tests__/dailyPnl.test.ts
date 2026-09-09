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

  it('evaluateRisk blocks entries while daily_pnl_day lags UTC today', async () => {
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
    const today = new Date().toISOString().slice(0, 10);
    // Sealed prior day with mild PnL — must not allow entry while roll deferred
    const deferred = evaluateRisk(
      forced,
      {
        ...account,
        daily_pnl: -50,
        daily_pnl_day: '2000-01-01',
        day_start_equity: 10_000,
        equity: 9_950,
      },
      GOLD_SPEC,
      quote,
      { ...DEFAULT_MASTER_CONFIG, max_daily_loss_pct: 0.99 }
    );
    expect(deferred.allowed).toBe(false);
    expect(deferred.reasons).toContain('utc_day_roll_deferred');

    const rolled = evaluateRisk(
      forced,
      {
        ...account,
        daily_pnl: -80,
        daily_pnl_day: today,
        day_start_equity: 9_950,
        equity: 9_870,
      },
      GOLD_SPEC,
      quote,
      { ...DEFAULT_MASTER_CONFIG, max_daily_loss_pct: 0.99 }
    );
    expect(rolled.reasons).not.toContain('utc_day_roll_deferred');
  });

  it('dollar day gates fold closed daily_pnl after post-defer day_start reseed', async () => {
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
    const today = new Date().toISOString().slice(0, 10);
    // Post-defer roll: day_start reseeded from post-close equity → equityDaily≈0,
    // but daily_pnl still holds today's closed −250 from the defer window.
    const lossBlocked = evaluateRisk(
      forced,
      {
        ...account,
        daily_pnl: -250,
        daily_pnl_day: today,
        day_start_equity: 9_750,
        equity: 9_750,
      },
      GOLD_SPEC,
      quote,
      {
        ...DEFAULT_MASTER_CONFIG,
        max_daily_loss_pct: 0.99,
        daily_loss_limit: 200,
        profit_lock: 0,
      }
    );
    expect(lossBlocked.allowed).toBe(false);
    expect(lossBlocked.reasons).toContain('daily_loss_limit');

    const profitBlocked = evaluateRisk(
      forced,
      {
        ...account,
        daily_pnl: 500,
        daily_pnl_day: today,
        day_start_equity: 10_500,
        equity: 10_500,
      },
      GOLD_SPEC,
      quote,
      {
        ...DEFAULT_MASTER_CONFIG,
        max_daily_loss_pct: 0.99,
        daily_loss_limit: 0,
        profit_lock: 400,
      }
    );
    expect(profitBlocked.allowed).toBe(false);
    expect(profitBlocked.reasons).toContain('profit_lock');
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

  it('rollDailyPnl restores closes credited during deferred UTC day', async () => {
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('PAPER');
    masterRuntime.account.daily_pnl = -250;
    masterRuntime.account.daily_pnl_day = '2000-01-01';
    masterRuntime.account.day_start_equity = 10_000;
    masterRuntime.account.equity = 9_750;
    masterRuntime.account.balance = 9_750;
    (
      masterRuntime as unknown as { pendingCalendarDayClosedPnl: number }
    ).pendingCalendarDayClosedPnl = 0;

    // Close while day-roll deferred (calendar today, sealed day yesterday)
    (
      masterRuntime as unknown as { creditClosedDailyPnl: (n: number) => void }
    ).creditClosedDailyPnl(-80);
    expect(masterRuntime.account.daily_pnl).toBe(-330);
    expect(
      (masterRuntime as unknown as { pendingCalendarDayClosedPnl: number })
        .pendingCalendarDayClosedPnl
    ).toBe(-80);

    const rolled = (
      masterRuntime as unknown as { rollDailyPnl: () => boolean }
    ).rollDailyPnl();
    expect(rolled).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect(masterRuntime.account.daily_pnl_day).toBe(today);
    // Today's deferred close must survive — not wiped to 0
    expect(masterRuntime.account.daily_pnl).toBe(-80);
    expect(
      (masterRuntime as unknown as { pendingCalendarDayClosedPnl: number })
        .pendingCalendarDayClosedPnl
    ).toBe(0);
  });

  it('hydrate rebuilds pending today closes so post-defer roll keeps them', async () => {
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { installFilePersist } = await import('../filePersist.js');
    const { saveRuntimeGates } = await import('../runtimeGates.js');

    const dir = mkdtempSync(join(tmpdir(), 'vs-defer-pending-rebuild-'));
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    installFilePersist(dir);

    const today = new Date().toISOString().slice(0, 10);
    const entry = 4400;
    writeFileSync(
      join(dir, 'master_state.json'),
      JSON.stringify({
        opportunities: [
          {
            id: '00000000-0000-4000-8000-0000000000aa',
            ts: '2000-01-01T12:00:00.000Z',
            mode: 'PAPER',
            epic: 'GOLD',
          },
          {
            id: '00000000-0000-4000-8000-0000000000bb',
            ts: `${today}T08:00:00.000Z`,
            mode: 'PAPER',
            epic: 'GOLD',
          },
        ],
        outcomes: [
          {
            opportunity_id: '00000000-0000-4000-8000-0000000000aa',
            setup_key: 'TREND:BUY',
            created_at: '2000-01-01T12:05:00.000Z',
            outcome: {
              position_id: 'p-sealed-prior',
              side: 'BUY',
              entry: 4400,
              exit: 4390,
              volume: 1,
              pnl: -250,
              fees: 0,
              slippage: 0,
              mae: 10,
              mfe: 0,
              r_multiple: -1,
              hold_ms: 1000,
              exit_reason: 'STOP_HIT',
            },
          },
          {
            opportunity_id: '00000000-0000-4000-8000-0000000000bb',
            setup_key: 'TREND:BUY',
            created_at: `${today}T09:00:00.000Z`,
            outcome: {
              position_id: 'p-today-during-defer',
              side: 'BUY',
              entry: 4400,
              exit: 4392,
              volume: 1,
              pnl: -80,
              fees: 0,
              slippage: 0,
              mae: 8,
              mfe: 0,
              r_multiple: -0.8,
              hold_ms: 1000,
              exit_reason: 'STOP_HIT',
            },
          },
        ],
        positions: [
          {
            position_id: 'paper-pending-rebuild-open',
            opportunity_id: '00000000-0000-4000-8000-0000000000cc',
            intent_id: 'defer-pending-rebuild-aaaaaa',
            epic: 'GOLD',
            side: 'BUY',
            size: 1,
            entry,
            stop_loss: entry - 50,
            take_profit: entry + 50,
            entry_at: `${today}T10:00:00.000Z`,
            decision: {
              decision_id: 'd-pending-rebuild',
              kind: 'BUY',
              side: 'BUY',
              score: 0.7,
              block_reason: null,
              buy: null,
              sell: null,
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
          },
        ],
        intents: [],
      })
    );
    saveRuntimeGates({
      last_loss_ms: 0,
      reject_until_ms: 0,
      inflight_until_ms: 0,
      post_exit_until_ms: 0,
      last_entry_fingerprint: null,
      day_start_equity: 10_000,
      peak_equity: 10_000,
      daily_pnl_day: '2000-01-01',
      consecutive_losses: 1,
      capital_day_gates_seeded: false,
      last_ai_allow_close: true,
      ai_mode: 'off',
      kill_switch: false,
      mode: 'PAPER',
      epic: 'GOLD',
      entries_armed: true,
      entries_pause_reason: null,
      last_close_failed: null,
      desired_running: false,
    });
    installFilePersist(dir);

    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.bookHydrated = false;
    masterRuntime.recovered = false;
    masterRuntime.broker = null;
    masterRuntime.account.equity = 10_000;
    masterRuntime.account.balance = 10_000;
    masterRuntime.account.peak_equity = 10_000;
    masterRuntime.account.daily_pnl = -50;
    masterRuntime.account.daily_pnl_day = '2000-01-01';
    masterRuntime.account.day_start_equity = 10_000;
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'PAPER', ai_mode: 'off' };
    masterRuntime.last_quote = null;
    masterRuntime.last_bars = [];
    (
      masterRuntime as unknown as { pendingCalendarDayClosedPnl: number }
    ).pendingCalendarDayClosedPnl = 0;
    masterRuntime.stop();

    const ok = await masterRuntime.hydrateBookFromDisk();
    expect(ok).toBe(true);
    expect(masterRuntime.positions.count()).toBe(1);
    expect(masterRuntime.account.daily_pnl_day).toBe('2000-01-01');
    expect(masterRuntime.account.daily_pnl).toBe(-250);
    // Calendar-today close must be parked for the eventual roll
    expect(
      (masterRuntime as unknown as { pendingCalendarDayClosedPnl: number })
        .pendingCalendarDayClosedPnl
    ).toBe(-80);

    const rolled = (
      masterRuntime as unknown as { rollDailyPnl: () => boolean }
    ).rollDailyPnl();
    expect(rolled).toBe(true);
    expect(masterRuntime.account.daily_pnl_day).toBe(today);
    expect(masterRuntime.account.daily_pnl).toBe(-80);
    expect(
      (masterRuntime as unknown as { pendingCalendarDayClosedPnl: number })
        .pendingCalendarDayClosedPnl
    ).toBe(0);
  });

  it('status reports utc_day_roll_deferred while open-book mark unproven', async () => {
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('PAPER');
    masterRuntime.account.daily_pnl = -250;
    masterRuntime.account.daily_pnl_day = '2000-01-01';
    masterRuntime.account.day_start_equity = 10_000;
    masterRuntime.account.equity = 9_750;
    masterRuntime.account.balance = 9_750;
    masterRuntime.positions.register({
      position_id: 'status-day-roll-defer',
      opportunity_id: 'opp-status-day-roll',
      intent_id: 'intent-status-day-roll',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: 4400,
      stop_loss: 4350,
      take_profit: 4450,
      entry_at: new Date().toISOString(),
      decision: {
        decision_id: 'd-status-day-roll',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null,
        sell: null,
        analysis: {
          regime: 'TREND',
          market_state: 't',
          momentum_score: 0.5,
          momentum_dir: 'UP',
          trend_dir: 'UP',
          trend_strength: 0.5,
          structure_bias: 'BULLISH',
          swing_high: 4405,
          swing_low: 4395,
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
    masterRuntime.last_quote = null;
    (
      masterRuntime as unknown as { quoteFromDiskCache: boolean }
    ).quoteFromDiskCache = false;

    const deferred = masterRuntime.status();
    expect(deferred.utc_day_roll_deferred).toBe(true);

    masterRuntime.last_quote = {
      bid: 4399.5,
      ask: 4399.7,
      mid: 4399.6,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    // Live mark clears open-book defer, but sealed prior day still paints deferred
    const markLiveDayLagged = masterRuntime.status();
    expect(markLiveDayLagged.utc_day_roll_deferred).toBe(true);
    expect(String(markLiveDayLagged.last_block_reason || '')).toMatch(
      /utc_day_roll_deferred/
    );

    masterRuntime.account.daily_pnl_day = new Date()
      .toISOString()
      .slice(0, 10);
    const live = masterRuntime.status();
    expect(live.utc_day_roll_deferred).toBe(false);

    masterRuntime.positions = new PositionManager();
    masterRuntime.last_quote = null;
  });

  it('status Why surfaces utc_day_roll_deferred while daily_pnl_day lags UTC today', async () => {
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('PAPER');
    masterRuntime.last_market = {
      ok: true,
      quality: 0.9,
      reasons: [],
      bars_in: 30,
      bars_out: 30,
    };
    masterRuntime.last_decision = {
      decision_id: 'why-day-lag',
      kind: 'WAIT',
      side: null,
      score: 0,
      block_reason: 'filters:spread',
      buy: null as never,
      sell: null as never,
      analysis: {
        regime: 'RANGE',
        market_state: 'r',
        momentum_score: 0,
        momentum_dir: 'FLAT',
        trend_dir: 'FLAT',
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
        volatility: 0.001,
        atr: 1,
        data_quality: 0.9,
        session: 'LONDON',
      },
      expectancy: null,
    } as typeof masterRuntime.last_decision;
    masterRuntime.last_risk = null;
    masterRuntime.account.daily_pnl = -120;
    masterRuntime.account.daily_pnl_day = '2000-01-01';
    masterRuntime.account.day_start_equity = 10_000;

    const lagged = masterRuntime.status();
    expect(String(lagged.last_block_reason || '')).toMatch(
      /^utc_day_roll_deferred/
    );
    expect(String(lagged.last_block_reason || '')).toContain('filters:spread');
    // Flat book: shouldDeferUtcDayRoll is false, but day lag must still paint deferred
    expect(masterRuntime.positions.count()).toBe(0);
    expect(lagged.utc_day_roll_deferred).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    masterRuntime.account.daily_pnl_day = today;
    const rolled = masterRuntime.status();
    expect(String(rolled.last_block_reason || '')).toBe('filters:spread');
    expect(String(rolled.last_block_reason || '')).not.toMatch(
      /utc_day_roll_deferred/
    );
    expect(rolled.utc_day_roll_deferred).toBe(false);

    masterRuntime.last_market = null;
    masterRuntime.last_decision = null;
  });

  it('status utc_day_roll_deferred when flat paper daily_pnl_day lags UTC today', async () => {
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('PAPER');
    masterRuntime.last_quote = {
      bid: 4400,
      ask: 4400.2,
      mid: 4400.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    (
      masterRuntime as unknown as { quoteFromDiskCache: boolean }
    ).quoteFromDiskCache = false;
    masterRuntime.account.daily_pnl = -40;
    masterRuntime.account.daily_pnl_day = '2000-01-01';
    masterRuntime.account.day_start_equity = 10_000;
    expect(masterRuntime.positions.count()).toBe(0);

    const lagged = masterRuntime.status();
    expect(lagged.utc_day_roll_deferred).toBe(true);
    expect(String(lagged.last_block_reason || '')).toMatch(
      /utc_day_roll_deferred/
    );

    masterRuntime.account.daily_pnl_day = new Date()
      .toISOString()
      .slice(0, 10);
    expect(masterRuntime.status().utc_day_roll_deferred).toBe(false);
    masterRuntime.last_quote = null;
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

  it('manageOnlyTick seeds day_start_equity from MTM equity after UTC day roll', async () => {
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'PAPER',
      time_stop_max_bars: 0,
      max_hold_ms: 86_400_000,
      post_exit_cooldown_ms: 0,
      soft_trail_money_arm: 0,
      be_start: 0,
      trail_start: 0,
      scalp_pct_chase: false,
      ai_mode: 'off',
    };
    const broker = masterRuntime.ensurePaperBroker();
    broker.seedOpens([]);
    broker.hydrateAccount({ equity: 10_000, balance: 10_000 });
    // Stale account equity left from prior session — must NOT seed day_start
    masterRuntime.account.equity = 10_000;
    masterRuntime.account.balance = 10_000;
    masterRuntime.account.peak_equity = 10_000;
    masterRuntime.account.daily_pnl = -50;
    masterRuntime.account.daily_pnl_day = '2000-01-01';
    masterRuntime.account.day_start_equity = 10_000;
    masterRuntime.running = true;

    const entry = 4400;
    // Manage-on-quote only — empty bars skip EMA structure exits
    const bars: Array<{
      open: number;
      high: number;
      low: number;
      close: number;
      ts_ms: number;
    }> = [];
    broker.setQuote({
      bid: entry,
      ask: entry + 0.2,
      mid: entry + 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'manage-only-day-mtm-aaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 50,
      profit_level: entry + 50,
    });
    expect(placed.ok).toBe(true);
    masterRuntime.positions.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-manage-only-day-mtm',
      intent_id: 'manage-only-day-mtm-aaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: placed.fill_price!,
      stop_loss: entry - 50,
      take_profit: entry + 50,
      decision: {
        decision_id: 'd-day-mtm',
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

    // Mild adverse mark — MTM equity drops; stay open (below HardInvalidation ~1.5pts)
    const loseMark = {
      bid: entry - 0.5,
      ask: entry - 0.3,
      mid: entry - 0.4,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    broker.setQuote(loseMark);
    // Leave account.equity stale at 10k until manageOnly MTM+snapshot
    masterRuntime.account.equity = 10_000;

    await (
      masterRuntime as unknown as {
        manageOnlyTick: (b: typeof bars, q: typeof loseMark) => Promise<void>;
      }
    ).manageOnlyTick(bars, loseMark);

    const today = new Date().toISOString().slice(0, 10);
    expect(masterRuntime.account.daily_pnl_day).toBe(today);
    expect(masterRuntime.positions.count()).toBe(1);
    expect(broker.equity).toBeLessThan(10_000);
    // day_start must seed from post-MTM equity, not stale 10k leftovers
    expect(masterRuntime.account.day_start_equity).toBe(broker.equity);
    expect(masterRuntime.account.day_start_equity).toBeLessThan(10_000);
    expect(masterRuntime.account.equity).toBe(broker.equity);
    masterRuntime.stop();
    broker.seedOpens([]);
    broker.hydrateAccount({ equity: 10_000, balance: 10_000 });
  });

  it('recover seeds day_start_equity from journal equity after UTC day roll', async () => {
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { installFilePersist } = await import('../filePersist.js');
    const { saveRuntimeGates } = await import('../runtimeGates.js');
    const { writeFileSync } = await import('fs');

    const dir = mkdtempSync(join(tmpdir(), 'vs-recover-day-mtm-'));
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    installFilePersist(dir);

    // Prior-day closed −250 → rebuilt equity 9750; must seed day_start (not stale 10k)
    writeFileSync(
      join(dir, 'master_state.json'),
      JSON.stringify({
        opportunities: [
          {
            id: '00000000-0000-4000-8000-0000000000aa',
            ts: '2000-01-01T12:00:00.000Z',
            mode: 'PAPER',
            epic: 'GOLD',
          },
        ],
        outcomes: [
          {
            opportunity_id: '00000000-0000-4000-8000-0000000000aa',
            setup_key: 'TREND:BUY',
            created_at: '2000-01-01T12:05:00.000Z',
            outcome: {
              position_id: 'p-recover-day-mtm',
              side: 'BUY',
              entry: 4400,
              exit: 4390,
              volume: 1,
              pnl: -250,
              fees: 0,
              slippage: 0,
              mae: 10,
              mfe: 0,
              r_multiple: -1,
              hold_ms: 1000,
              exit_reason: 'STOP_HIT',
            },
          },
        ],
        positions: [],
        intents: [],
      })
    );
    saveRuntimeGates({
      last_loss_ms: 0,
      reject_until_ms: 0,
      inflight_until_ms: 0,
      post_exit_until_ms: 0,
      last_entry_fingerprint: null,
      day_start_equity: 10_000,
      peak_equity: 10_000,
      daily_pnl_day: '2000-01-01',
      consecutive_losses: 1,
      capital_day_gates_seeded: false,
      last_ai_allow_close: true,
      ai_mode: 'off',
      kill_switch: false,
      mode: 'PAPER',
      epic: 'GOLD',
      entries_armed: true,
      entries_pause_reason: null,
      last_close_failed: null,
      desired_running: false,
    });
    installFilePersist(dir);

    // Reset account BEFORE stop() — stop persistRuntimeGates must not rewrite
    // temp gates with prior-test day_start / daily_pnl_day leftovers.
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.broker = null;
    masterRuntime.last_quote = null;
    masterRuntime.last_bars = [];
    masterRuntime.bookHydrated = false;
    masterRuntime.recovered = false;
    masterRuntime.account.equity = 10_000;
    masterRuntime.account.balance = 10_000;
    masterRuntime.account.peak_equity = 10_000;
    masterRuntime.account.daily_pnl = -50;
    masterRuntime.account.daily_pnl_day = '2000-01-01';
    masterRuntime.account.day_start_equity = 10_000;
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'PAPER', ai_mode: 'off' };
    masterRuntime.stop();
    // Re-assert gates after stop() persist
    saveRuntimeGates({
      last_loss_ms: 0,
      reject_until_ms: 0,
      inflight_until_ms: 0,
      post_exit_until_ms: 0,
      last_entry_fingerprint: null,
      day_start_equity: 10_000,
      peak_equity: 10_000,
      daily_pnl_day: '2000-01-01',
      consecutive_losses: 1,
      capital_day_gates_seeded: false,
      last_ai_allow_close: true,
      ai_mode: 'off',
      kill_switch: false,
      mode: 'PAPER',
      epic: 'GOLD',
      entries_armed: true,
      entries_pause_reason: null,
      last_close_failed: null,
      desired_running: false,
    });

    await masterRuntime.recover();

    const today = new Date().toISOString().slice(0, 10);
    expect(masterRuntime.account.daily_pnl_day).toBe(today);
    expect(masterRuntime.account.equity).toBe(9750);
    expect(masterRuntime.account.balance).toBe(9750);
    // day_start must seed from journal-rebuilt equity, not stale £10k leftovers
    expect(masterRuntime.account.day_start_equity).toBe(9750);
    expect(masterRuntime.account.daily_pnl).toBe(0);

    masterRuntime.stop();
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
  });

  it('recover syncs paper cash balance so open-book MTM day_start uses cash+UPL', async () => {
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { installFilePersist } = await import('../filePersist.js');
    const { saveRuntimeGates } = await import('../runtimeGates.js');

    const dir = mkdtempSync(join(tmpdir(), 'vs-recover-paper-cash-'));
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    installFilePersist(dir);

    const entry = 4400;
    const markBid = entry - 0.5;
    writeFileSync(
      join(dir, 'master_state.json'),
      JSON.stringify({
        opportunities: [
          {
            id: '00000000-0000-4000-8000-0000000000bb',
            ts: '2000-01-01T12:00:00.000Z',
            mode: 'PAPER',
            epic: 'GOLD',
          },
        ],
        outcomes: [
          {
            opportunity_id: '00000000-0000-4000-8000-0000000000bb',
            setup_key: 'TREND:BUY',
            created_at: '2000-01-01T12:05:00.000Z',
            outcome: {
              position_id: 'p-prior-close',
              side: 'BUY',
              entry: 4400,
              exit: 4390,
              volume: 1,
              pnl: -250,
              fees: 0,
              slippage: 0,
              mae: 10,
              mfe: 0,
              r_multiple: -1,
              hold_ms: 1000,
              exit_reason: 'STOP_HIT',
            },
          },
        ],
        positions: [
          {
            position_id: 'paper-open-cash-mtm',
            opportunity_id: '00000000-0000-4000-8000-0000000000cc',
            intent_id: 'recover-paper-cash-aaaaaaaa',
            epic: 'GOLD',
            side: 'BUY',
            size: 1,
            entry,
            stop_loss: entry - 50,
            take_profit: entry + 50,
            entry_at: '2000-01-01T18:00:00.000Z',
            decision: {
              decision_id: 'd-cash',
              kind: 'BUY',
              side: 'BUY',
              score: 0.7,
              block_reason: null,
              buy: null,
              sell: null,
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
          },
        ],
        intents: [],
      })
    );
    saveRuntimeGates({
      last_loss_ms: 0,
      reject_until_ms: 0,
      inflight_until_ms: 0,
      post_exit_until_ms: 0,
      last_entry_fingerprint: null,
      day_start_equity: 10_000,
      peak_equity: 10_000,
      daily_pnl_day: '2000-01-01',
      consecutive_losses: 1,
      capital_day_gates_seeded: false,
      last_ai_allow_close: true,
      ai_mode: 'off',
      kill_switch: false,
      mode: 'PAPER',
      epic: 'GOLD',
      entries_armed: true,
      entries_pause_reason: null,
      last_close_failed: null,
      desired_running: false,
    });
    installFilePersist(dir);

    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.bookHydrated = false;
    masterRuntime.recovered = false;
    masterRuntime.account.equity = 10_000;
    masterRuntime.account.balance = 10_000;
    masterRuntime.account.peak_equity = 10_000;
    masterRuntime.account.daily_pnl = -50;
    masterRuntime.account.daily_pnl_day = '2000-01-01';
    masterRuntime.account.day_start_equity = 10_000;
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'PAPER',
      ai_mode: 'off',
      soft_trail_money_arm: 0,
      be_start: 0,
      trail_start: 0,
      scalp_pct_chase: false,
      time_stop_max_bars: 0,
      max_hold_ms: 86_400_000,
    };
    // Attach paper broker + quote so recover MTM runs on the open
    const broker = masterRuntime.ensurePaperBroker();
    broker.seedOpens([]);
    broker.hydrateAccount({ equity: 10_000, balance: 10_000 });
    const loseMark = {
      bid: markBid,
      ask: markBid + 0.2,
      mid: markBid + 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    masterRuntime.last_quote = loseMark;
    masterRuntime.last_bars = [];
    masterRuntime.stop();
    saveRuntimeGates({
      last_loss_ms: 0,
      reject_until_ms: 0,
      inflight_until_ms: 0,
      post_exit_until_ms: 0,
      last_entry_fingerprint: null,
      day_start_equity: 10_000,
      peak_equity: 10_000,
      daily_pnl_day: '2000-01-01',
      consecutive_losses: 1,
      capital_day_gates_seeded: false,
      last_ai_allow_close: true,
      ai_mode: 'off',
      kill_switch: false,
      mode: 'PAPER',
      epic: 'GOLD',
      entries_armed: true,
      entries_pause_reason: null,
      last_close_failed: null,
      desired_running: false,
    });
    // stop() nulls desired_running — keep broker + quote for MTM
    masterRuntime.ensurePaperBroker();
    masterRuntime.last_quote = loseMark;

    await masterRuntime.recover();

    const today = new Date().toISOString().slice(0, 10);
    const upl = markBid - entry; // BUY protective mark
    const expectedCash = 9750;
    const expectedEquity = expectedCash + upl;
    expect(masterRuntime.account.daily_pnl_day).toBe(today);
    expect(masterRuntime.positions.count()).toBe(1);
    expect(masterRuntime.account.balance).toBe(expectedCash);
    expect(broker.balance).toBe(expectedCash);
    expect(masterRuntime.account.equity).toBeCloseTo(expectedEquity, 5);
    // Must NOT seed from stale £10k+UPL
    expect(masterRuntime.account.day_start_equity).toBeCloseTo(expectedEquity, 5);
    expect(masterRuntime.account.day_start_equity).toBeLessThan(10_000);

    masterRuntime.stop();
    broker.seedOpens([]);
    broker.hydrateAccount({ equity: 10_000, balance: 10_000 });
    masterRuntime.account.equity = 10_000;
    masterRuntime.account.balance = 10_000;
    masterRuntime.account.day_start_equity = 10_000;
    masterRuntime.last_quote = null;
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
  });

  it('hydrateBookFromDisk MTM seeds day_start from cash+UPL before UTC day roll', async () => {
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { installFilePersist } = await import('../filePersist.js');
    const { saveRuntimeGates } = await import('../runtimeGates.js');

    const dir = mkdtempSync(join(tmpdir(), 'vs-hydrate-open-mtm-'));
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    installFilePersist(dir);

    const entry = 4400;
    const markBid = entry - 0.5;
    writeFileSync(
      join(dir, 'master_state.json'),
      JSON.stringify({
        opportunities: [
          {
            id: '00000000-0000-4000-8000-0000000000dd',
            ts: '2000-01-01T12:00:00.000Z',
            mode: 'PAPER',
            epic: 'GOLD',
          },
        ],
        outcomes: [
          {
            opportunity_id: '00000000-0000-4000-8000-0000000000dd',
            setup_key: 'TREND:BUY',
            created_at: '2000-01-01T12:05:00.000Z',
            outcome: {
              position_id: 'p-hydrate-prior',
              side: 'BUY',
              entry: 4400,
              exit: 4390,
              volume: 1,
              pnl: -250,
              fees: 0,
              slippage: 0,
              mae: 10,
              mfe: 0,
              r_multiple: -1,
              hold_ms: 1000,
              exit_reason: 'STOP_HIT',
            },
          },
        ],
        positions: [
          {
            position_id: 'paper-hydrate-open-mtm',
            opportunity_id: '00000000-0000-4000-8000-0000000000ee',
            intent_id: 'hydrate-open-mtm-aaaaaaaa',
            epic: 'GOLD',
            side: 'BUY',
            size: 1,
            entry,
            stop_loss: entry - 50,
            take_profit: entry + 50,
            entry_at: '2000-01-01T18:00:00.000Z',
            decision: {
              decision_id: 'd-hyd',
              kind: 'BUY',
              side: 'BUY',
              score: 0.7,
              block_reason: null,
              buy: null,
              sell: null,
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
          },
        ],
        intents: [],
      })
    );
    saveRuntimeGates({
      last_loss_ms: 0,
      reject_until_ms: 0,
      inflight_until_ms: 0,
      post_exit_until_ms: 0,
      last_entry_fingerprint: null,
      day_start_equity: 10_000,
      peak_equity: 10_000,
      daily_pnl_day: '2000-01-01',
      consecutive_losses: 1,
      capital_day_gates_seeded: false,
      last_ai_allow_close: true,
      ai_mode: 'off',
      kill_switch: false,
      mode: 'PAPER',
      epic: 'GOLD',
      entries_armed: true,
      entries_pause_reason: null,
      last_close_failed: null,
      desired_running: false,
    });
    installFilePersist(dir);

    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.bookHydrated = false;
    masterRuntime.recovered = false;
    masterRuntime.account.equity = 10_000;
    masterRuntime.account.balance = 10_000;
    masterRuntime.account.peak_equity = 10_000;
    masterRuntime.account.daily_pnl = -50;
    masterRuntime.account.daily_pnl_day = '2000-01-01';
    masterRuntime.account.day_start_equity = 10_000;
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'PAPER',
      ai_mode: 'off',
      soft_trail_money_arm: 0,
      be_start: 0,
      trail_start: 0,
      scalp_pct_chase: false,
      time_stop_max_bars: 0,
      max_hold_ms: 86_400_000,
    };
    const broker = masterRuntime.ensurePaperBroker();
    broker.seedOpens([]);
    broker.hydrateAccount({ equity: 10_000, balance: 10_000 });
    const loseMark = {
      bid: markBid,
      ask: markBid + 0.2,
      mid: markBid + 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    // Keep quote through hydrateMarketCacheFromDisk (only fills when last_quote null)
    masterRuntime.last_quote = loseMark;
    masterRuntime.last_bars = [];
    masterRuntime.stop();
    saveRuntimeGates({
      last_loss_ms: 0,
      reject_until_ms: 0,
      inflight_until_ms: 0,
      post_exit_until_ms: 0,
      last_entry_fingerprint: null,
      day_start_equity: 10_000,
      peak_equity: 10_000,
      daily_pnl_day: '2000-01-01',
      consecutive_losses: 1,
      capital_day_gates_seeded: false,
      last_ai_allow_close: true,
      ai_mode: 'off',
      kill_switch: false,
      mode: 'PAPER',
      epic: 'GOLD',
      entries_armed: true,
      entries_pause_reason: null,
      last_close_failed: null,
      desired_running: false,
    });
    masterRuntime.bookHydrated = false;
    masterRuntime.recovered = false;
    masterRuntime.ensurePaperBroker();
    masterRuntime.last_quote = loseMark;

    const ok = await masterRuntime.hydrateBookFromDisk();
    expect(ok).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    const upl = markBid - entry;
    const expectedCash = 9750;
    const expectedEquity = expectedCash + upl;
    expect(masterRuntime.account.daily_pnl_day).toBe(today);
    expect(masterRuntime.positions.count()).toBe(1);
    expect(masterRuntime.account.balance).toBe(expectedCash);
    // Must NOT seed cash-only 9750 — open UPL must be in day_start
    expect(masterRuntime.account.day_start_equity).toBeCloseTo(expectedEquity, 5);
    expect(masterRuntime.account.day_start_equity).toBeLessThan(expectedCash);
    expect(masterRuntime.account.equity).toBeCloseTo(expectedEquity, 5);

    masterRuntime.stop();
    broker.seedOpens([]);
    broker.hydrateAccount({ equity: 10_000, balance: 10_000 });
    masterRuntime.account.equity = 10_000;
    masterRuntime.account.balance = 10_000;
    masterRuntime.account.day_start_equity = 10_000;
    masterRuntime.last_quote = null;
    masterRuntime.bookHydrated = false;
    masterRuntime.recovered = false;
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
  });

  it('hydrateBookFromDisk defers UTC day-roll when opens exist without quote', async () => {
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { installFilePersist } = await import('../filePersist.js');
    const { saveRuntimeGates } = await import('../runtimeGates.js');

    const dir = mkdtempSync(join(tmpdir(), 'vs-defer-day-roll-'));
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    installFilePersist(dir);

    const entry = 4400;
    writeFileSync(
      join(dir, 'master_state.json'),
      JSON.stringify({
        opportunities: [
          {
            id: '00000000-0000-4000-8000-0000000000ff',
            ts: '2000-01-01T12:00:00.000Z',
            mode: 'PAPER',
            epic: 'GOLD',
          },
        ],
        outcomes: [
          {
            opportunity_id: '00000000-0000-4000-8000-0000000000ff',
            setup_key: 'TREND:BUY',
            created_at: '2000-01-01T12:05:00.000Z',
            outcome: {
              position_id: 'p-defer-prior',
              side: 'BUY',
              entry: 4400,
              exit: 4390,
              volume: 1,
              pnl: -250,
              fees: 0,
              slippage: 0,
              mae: 10,
              mfe: 0,
              r_multiple: -1,
              hold_ms: 1000,
              exit_reason: 'STOP_HIT',
            },
          },
        ],
        positions: [
          {
            position_id: 'paper-defer-open',
            opportunity_id: '00000000-0000-4000-8000-000000000011',
            intent_id: 'defer-open-day-roll-aaaaaa',
            epic: 'GOLD',
            side: 'BUY',
            size: 1,
            entry,
            stop_loss: entry - 50,
            take_profit: entry + 50,
            entry_at: '2000-01-01T18:00:00.000Z',
            decision: {
              decision_id: 'd-defer',
              kind: 'BUY',
              side: 'BUY',
              score: 0.7,
              block_reason: null,
              buy: null,
              sell: null,
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
          },
        ],
        intents: [],
      })
    );
    saveRuntimeGates({
      last_loss_ms: 0,
      reject_until_ms: 0,
      inflight_until_ms: 0,
      post_exit_until_ms: 0,
      last_entry_fingerprint: null,
      day_start_equity: 10_000,
      peak_equity: 10_000,
      daily_pnl_day: '2000-01-01',
      consecutive_losses: 1,
      capital_day_gates_seeded: false,
      last_ai_allow_close: true,
      ai_mode: 'off',
      kill_switch: false,
      mode: 'PAPER',
      epic: 'GOLD',
      entries_armed: true,
      entries_pause_reason: null,
      last_close_failed: null,
      desired_running: false,
    });
    installFilePersist(dir);

    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.bookHydrated = false;
    masterRuntime.recovered = false;
    masterRuntime.broker = null;
    masterRuntime.account.equity = 10_000;
    masterRuntime.account.balance = 10_000;
    masterRuntime.account.peak_equity = 10_000;
    masterRuntime.account.daily_pnl = -50;
    masterRuntime.account.daily_pnl_day = '2000-01-01';
    masterRuntime.account.day_start_equity = 10_000;
    masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'PAPER', ai_mode: 'off' };
    // No quote — must not cash-seal day roll
    masterRuntime.last_quote = null;
    masterRuntime.last_bars = [];
    masterRuntime.stop();
    saveRuntimeGates({
      last_loss_ms: 0,
      reject_until_ms: 0,
      inflight_until_ms: 0,
      post_exit_until_ms: 0,
      last_entry_fingerprint: null,
      day_start_equity: 10_000,
      peak_equity: 10_000,
      daily_pnl_day: '2000-01-01',
      consecutive_losses: 1,
      capital_day_gates_seeded: false,
      last_ai_allow_close: true,
      ai_mode: 'off',
      kill_switch: false,
      mode: 'PAPER',
      epic: 'GOLD',
      entries_armed: true,
      entries_pause_reason: null,
      last_close_failed: null,
      desired_running: false,
    });
    masterRuntime.bookHydrated = false;
    masterRuntime.recovered = false;
    masterRuntime.last_quote = null;

    const ok = await masterRuntime.hydrateBookFromDisk();
    expect(ok).toBe(true);
    expect(masterRuntime.positions.count()).toBe(1);
    // Must NOT advance daily_pnl_day to today without quote MTM
    expect(masterRuntime.account.daily_pnl_day).toBe('2000-01-01');
    expect(masterRuntime.account.day_start_equity).toBe(10_000);
    // Sealed-day closed PnL must survive defer (not wiped to today's 0)
    expect(masterRuntime.account.daily_pnl).toBe(-250);

    // Quote arrives → manageOnly rolls with cash+UPL
    const markBid = entry - 0.5;
    const loseMark = {
      bid: markBid,
      ask: markBid + 0.2,
      mid: markBid + 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    const broker = masterRuntime.ensurePaperBroker();
    broker.seedOpens(
      masterRuntime.positions.list().map((p) => ({
        position_id: p.position_id,
        epic: p.epic,
        side: p.side,
        size: p.size,
        open_level: p.entry,
        stop_level: p.stop_loss,
        profit_level: p.take_profit,
      }))
    );
    broker.hydrateAccount({
      equity: masterRuntime.account.equity,
      balance: masterRuntime.account.balance,
    });
    masterRuntime.cfg = {
      ...masterRuntime.cfg,
      soft_trail_money_arm: 0,
      be_start: 0,
      trail_start: 0,
      scalp_pct_chase: false,
      time_stop_max_bars: 0,
      max_hold_ms: 86_400_000,
      post_exit_cooldown_ms: 0,
    };
    masterRuntime.running = true;
    await (
      masterRuntime as unknown as {
        manageOnlyTick: (b: [], q: typeof loseMark) => Promise<void>;
      }
    ).manageOnlyTick([], loseMark);

    const today = new Date().toISOString().slice(0, 10);
    const expectedCash = 9750;
    const expectedEquity = expectedCash + (markBid - entry);
    expect(masterRuntime.account.daily_pnl_day).toBe(today);
    expect(masterRuntime.account.day_start_equity).toBeCloseTo(expectedEquity, 5);
    expect(masterRuntime.account.day_start_equity).toBeLessThan(expectedCash);

    masterRuntime.stop();
    broker.seedOpens([]);
    broker.hydrateAccount({ equity: 10_000, balance: 10_000 });
    masterRuntime.account.equity = 10_000;
    masterRuntime.account.balance = 10_000;
    masterRuntime.account.day_start_equity = 10_000;
    masterRuntime.last_quote = null;
    masterRuntime.bookHydrated = false;
    masterRuntime.recovered = false;
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
  });

  it('hydrateBookFromDisk defers UTC day-roll when open-book quote is disk/stale', async () => {
    const { mkdtempSync, writeFileSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { installFilePersist } = await import('../filePersist.js');
    const { saveRuntimeGates } = await import('../runtimeGates.js');

    const dir = mkdtempSync(join(tmpdir(), 'vs-defer-stale-quote-'));
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    installFilePersist(dir);

    const entry = 4400;
    writeFileSync(
      join(dir, 'master_state.json'),
      JSON.stringify({
        opportunities: [
          {
            id: '00000000-0000-4000-8000-000000000022',
            ts: '2000-01-01T12:00:00.000Z',
            mode: 'PAPER',
            epic: 'GOLD',
          },
        ],
        outcomes: [
          {
            opportunity_id: '00000000-0000-4000-8000-000000000022',
            setup_key: 'TREND:BUY',
            created_at: '2000-01-01T12:05:00.000Z',
            outcome: {
              position_id: 'p-stale-prior',
              side: 'BUY',
              entry: 4400,
              exit: 4390,
              volume: 1,
              pnl: -250,
              fees: 0,
              slippage: 0,
              mae: 10,
              mfe: 0,
              r_multiple: -1,
              hold_ms: 1000,
              exit_reason: 'STOP_HIT',
            },
          },
        ],
        positions: [
          {
            position_id: 'paper-stale-open',
            opportunity_id: '00000000-0000-4000-8000-000000000033',
            intent_id: 'defer-stale-quote-aaaaaaaa',
            epic: 'GOLD',
            side: 'BUY',
            size: 1,
            entry,
            stop_loss: entry - 50,
            take_profit: entry + 50,
            entry_at: '2000-01-01T18:00:00.000Z',
            decision: {
              decision_id: 'd-stale',
              kind: 'BUY',
              side: 'BUY',
              score: 0.7,
              block_reason: null,
              buy: null,
              sell: null,
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
          },
        ],
        intents: [],
      })
    );
    saveRuntimeGates({
      last_loss_ms: 0,
      reject_until_ms: 0,
      inflight_until_ms: 0,
      post_exit_until_ms: 0,
      last_entry_fingerprint: null,
      day_start_equity: 10_000,
      peak_equity: 10_000,
      daily_pnl_day: '2000-01-01',
      consecutive_losses: 1,
      capital_day_gates_seeded: false,
      last_ai_allow_close: true,
      ai_mode: 'off',
      kill_switch: false,
      mode: 'PAPER',
      epic: 'GOLD',
      entries_armed: true,
      entries_pause_reason: null,
      last_close_failed: null,
      desired_running: false,
    });
    installFilePersist(dir);

    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    masterRuntime.bookHydrated = false;
    masterRuntime.recovered = false;
    masterRuntime.broker = null;
    masterRuntime.account.equity = 10_000;
    masterRuntime.account.balance = 10_000;
    masterRuntime.account.peak_equity = 10_000;
    masterRuntime.account.daily_pnl = -50;
    masterRuntime.account.daily_pnl_day = '2000-01-01';
    masterRuntime.account.day_start_equity = 10_000;
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'PAPER',
      ai_mode: 'off',
      stale_quote_ms: 15_000,
    };
    // Aged disk_cache quote would previously MTM-seal day_start
    const staleMark = {
      bid: entry - 0.5,
      ask: entry - 0.3,
      mid: entry - 0.4,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now() - 60_000,
    };
    masterRuntime.last_quote = staleMark;
    (
      masterRuntime as unknown as { quoteFromDiskCache: boolean }
    ).quoteFromDiskCache = true;
    masterRuntime.last_bars = [];
    masterRuntime.stop();
    saveRuntimeGates({
      last_loss_ms: 0,
      reject_until_ms: 0,
      inflight_until_ms: 0,
      post_exit_until_ms: 0,
      last_entry_fingerprint: null,
      day_start_equity: 10_000,
      peak_equity: 10_000,
      daily_pnl_day: '2000-01-01',
      consecutive_losses: 1,
      capital_day_gates_seeded: false,
      last_ai_allow_close: true,
      ai_mode: 'off',
      kill_switch: false,
      mode: 'PAPER',
      epic: 'GOLD',
      entries_armed: true,
      entries_pause_reason: null,
      last_close_failed: null,
      desired_running: false,
    });
    masterRuntime.bookHydrated = false;
    masterRuntime.recovered = false;
    masterRuntime.last_quote = staleMark;
    (
      masterRuntime as unknown as { quoteFromDiskCache: boolean }
    ).quoteFromDiskCache = true;

    const ok = await masterRuntime.hydrateBookFromDisk();
    expect(ok).toBe(true);
    expect(masterRuntime.positions.count()).toBe(1);
    expect(masterRuntime.account.daily_pnl_day).toBe('2000-01-01');
    expect(masterRuntime.account.day_start_equity).toBe(10_000);
    // Sealed-day closed PnL must survive defer (not wiped to today's 0)
    expect(masterRuntime.account.daily_pnl).toBe(-250);

    const markBid = entry - 0.5;
    const freshMark = {
      bid: markBid,
      ask: markBid + 0.2,
      mid: markBid + 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    const broker = masterRuntime.ensurePaperBroker();
    broker.seedOpens(
      masterRuntime.positions.list().map((p) => ({
        position_id: p.position_id,
        epic: p.epic,
        side: p.side,
        size: p.size,
        open_level: p.entry,
        stop_level: p.stop_loss,
        profit_level: p.take_profit,
      }))
    );
    broker.hydrateAccount({
      equity: masterRuntime.account.equity,
      balance: masterRuntime.account.balance,
    });
    masterRuntime.cfg = {
      ...masterRuntime.cfg,
      soft_trail_money_arm: 0,
      be_start: 0,
      trail_start: 0,
      scalp_pct_chase: false,
      time_stop_max_bars: 0,
      max_hold_ms: 86_400_000,
      post_exit_cooldown_ms: 0,
    };
    masterRuntime.running = true;
    await (
      masterRuntime as unknown as {
        manageOnlyTick: (b: [], q: typeof freshMark) => Promise<void>;
      }
    ).manageOnlyTick([], freshMark);

    const today = new Date().toISOString().slice(0, 10);
    const expectedCash = 9750;
    const expectedEquity = expectedCash + (markBid - entry);
    expect(masterRuntime.account.daily_pnl_day).toBe(today);
    expect(masterRuntime.account.day_start_equity).toBeCloseTo(expectedEquity, 5);
    expect(masterRuntime.account.day_start_equity).toBeLessThan(expectedCash);

    masterRuntime.stop();
    broker.seedOpens([]);
    broker.hydrateAccount({ equity: 10_000, balance: 10_000 });
    masterRuntime.account.equity = 10_000;
    masterRuntime.account.balance = 10_000;
    masterRuntime.account.day_start_equity = 10_000;
    masterRuntime.last_quote = null;
    (
      masterRuntime as unknown as { quoteFromDiskCache: boolean }
    ).quoteFromDiskCache = false;
    masterRuntime.bookHydrated = false;
    masterRuntime.recovered = false;
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
  });

  it('full tick defers UTC day-roll when replaying disk/stale open-book quote', async () => {
    masterRuntime.stop();
    masterRuntime.pipeline = new MasterPipeline('PAPER');
    masterRuntime.positions = new PositionManager();
    const broker = masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('PAPER');
    masterRuntime.cfg = {
      ...DEFAULT_MASTER_CONFIG,
      mode: 'PAPER',
      ai_mode: 'off',
      stale_quote_ms: 15_000,
      soft_trail_money_arm: 0,
      be_start: 0,
      trail_start: 0,
      scalp_pct_chase: false,
      time_stop_max_bars: 0,
      max_hold_ms: 86_400_000,
      post_exit_cooldown_ms: 0,
    };
    masterRuntime.setEntriesArmed(false, 'test_day_roll_only');
    const entry = 4400;
    masterRuntime.positions.register({
      position_id: 'full-tick-disk-day-roll',
      opportunity_id: 'opp-full-tick-disk',
      intent_id: 'intent-full-tick-disk',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry,
      stop_loss: entry - 50,
      take_profit: entry + 50,
      entry_at: new Date().toISOString(),
      decision: {
        decision_id: 'd-full-tick-disk',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null,
        sell: null,
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
    broker.seedOpens([
      {
        position_id: 'full-tick-disk-day-roll',
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        open_level: entry,
        stop_level: entry - 50,
        profit_level: entry + 50,
      },
    ]);
    const cash = 9750;
    broker.hydrateAccount({ equity: cash, balance: cash });
    masterRuntime.account.equity = cash;
    masterRuntime.account.balance = cash;
    masterRuntime.account.peak_equity = 10_000;
    masterRuntime.account.daily_pnl = -50;
    masterRuntime.account.daily_pnl_day = '2000-01-01';
    masterRuntime.account.day_start_equity = 10_000;

    const staleMark: Quote = {
      bid: entry - 0.5,
      ask: entry - 0.3,
      mid: entry - 0.4,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now() - 60_000,
    };
    masterRuntime.last_quote = staleMark;
    (
      masterRuntime as unknown as { quoteFromDiskCache: boolean }
    ).quoteFromDiskCache = true;
    const bars = Array.from({ length: 40 }, (_, i) => {
      const o = entry - 2 + i * 0.05;
      return {
        open: o,
        high: o + 0.2,
        low: o - 0.2,
        close: o + 0.05,
        ts_ms: Date.now() - (40 - i) * 60_000,
      };
    });
    masterRuntime.last_bars = bars;
    masterRuntime.running = true;

    // Interval-style replay: same disk mark object identity path (ts/mid match)
    await masterRuntime.tick(bars, staleMark);

    expect(masterRuntime.positions.count()).toBe(1);
    expect(masterRuntime.account.daily_pnl_day).toBe('2000-01-01');
    expect(masterRuntime.account.day_start_equity).toBe(10_000);
    expect(
      (masterRuntime as unknown as { quoteFromDiskCache: boolean }).quoteFromDiskCache
    ).toBe(true);

    const markBid = entry - 0.5;
    const freshMark: Quote = {
      bid: markBid,
      ask: markBid + 0.2,
      mid: markBid + 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    await masterRuntime.tick(bars, freshMark);

    const today = new Date().toISOString().slice(0, 10);
    const expectedEquity = cash + (markBid - entry);
    expect(masterRuntime.account.daily_pnl_day).toBe(today);
    expect(masterRuntime.account.day_start_equity).toBeCloseTo(expectedEquity, 5);
    expect(masterRuntime.account.day_start_equity).toBeLessThan(cash);

    masterRuntime.stop();
    broker.seedOpens([]);
    broker.hydrateAccount({ equity: 10_000, balance: 10_000 });
    masterRuntime.account.equity = 10_000;
    masterRuntime.account.balance = 10_000;
    masterRuntime.account.day_start_equity = 10_000;
    masterRuntime.last_quote = null;
    (
      masterRuntime as unknown as { quoteFromDiskCache: boolean }
    ).quoteFromDiskCache = false;
    masterRuntime.positions = new PositionManager();
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
