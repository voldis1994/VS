import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { PaperBroker } from '../broker.js';
import { DEFAULT_MASTER_CONFIG, MasterPipeline } from '../pipeline.js';
import { PositionManager } from '../positionManager.js';
import { syncPositionsWithBroker } from '../positionSync.js';
import { masterRuntime } from '../runtime.js';

describe('PaperBroker VS-System SL/TP auto-fill on setQuote', () => {
  it('auto-fills STOP_HIT on quote without manageTick', async () => {
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
      intent_id: 'paper-sl-autofill-aaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 2,
      profit_level: entry + 10,
    });
    expect(placed.ok).toBe(true);
    const eqBefore = broker.equity;

    // Cross SL on bid — venue fills without PositionManager
    broker.setQuote({
      bid: entry - 2.5,
      ask: entry - 2.3,
      mid: entry - 2.4,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const open = await broker.listOpenPositions('GOLD');
    expect(open.positions.length).toBe(0);
    expect(broker.equity).toBeLessThan(eqBefore);

    const peek = broker.peekRecentAutoFill(placed.position_id!);
    expect(peek?.reason).toBe('STOP_HIT');
    expect(peek?.fill_pnl).not.toBeNull();
    expect(Number(peek!.fill_pnl)).toBeLessThan(0);

    // manageTick-style close stays idempotent with the auto fill
    const closed = await broker.closePosition(placed.position_id!);
    expect(closed.ok).toBe(true);
    expect(closed.fill_price).toBe(entry - 2.5);
    expect(String(closed.detail)).toMatch(/paper_auto_stop_hit/);
    expect(closed.fill_pnl).not.toBeNull();
  });

  it('auto-fills TP_HIT on quote for SELL', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry - 0.2,
      ask: entry,
      mid: entry - 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'paper-tp-autofill-aaaaaaaa',
      epic: 'GOLD',
      side: 'SELL',
      size: 1,
      stop_level: entry + 5,
      profit_level: entry - 3,
    });
    expect(placed.ok).toBe(true);

    broker.setQuote({
      bid: entry - 3.2,
      ask: entry - 3.0,
      mid: entry - 3.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const open = await broker.listOpenPositions();
    expect(open.positions.length).toBe(0);
    const closed = await broker.closePosition(placed.position_id!);
    expect(closed.ok).toBe(true);
    expect(String(closed.detail)).toMatch(/paper_auto_tp_hit/);
  });

  it('does not auto-close non-matching epic on GOLD quote', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    broker.setQuote({
      bid: 30,
      ask: 30.1,
      mid: 30.05,
      spread: 0.1,
      epic: 'SILVER',
      ts_ms: Date.now(),
    });
    const silver = await broker.placeOrder({
      intent_id: 'paper-sl-silver-aaaaaaaaaa',
      epic: 'SILVER',
      side: 'BUY',
      size: 1,
      stop_level: 28,
    });
    broker.setQuote({
      bid: 4400,
      ask: 4400.2,
      mid: 4400.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    // Hostile GOLD print must not flatten SILVER
    const open = await broker.listOpenPositions();
    expect(open.positions.map((p) => p.position_id)).toContain(silver.position_id);
  });

  it('markToMarket updates UPL on protective mark per epic', async () => {
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
      intent_id: 'paper-mtm-aaaaaaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: 4300,
    });
    broker.setQuote({
      bid: 4410,
      ask: 4410.4,
      mid: 4410.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const open = await broker.listOpenPositions();
    const pos = open.positions.find((p) => p.position_id === placed.position_id);
    expect(pos).toBeTruthy();
    expect(pos!.upl).not.toBeNull();
    expect(Number(pos!.upl)).toBeGreaterThan(0);
  });

  it('sync journals STOP_HIT same cycle (no ×5 empty debounce) after paper auto-fill', async () => {
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
      intent_id: 'paper-ghost-sync-aaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 2,
      profit_level: entry + 10,
    });
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-ghost-sync',
      intent_id: 'ghost-sync-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: placed.fill_price!,
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
    expect((await broker.listOpenPositions()).positions.length).toBe(0);

    const debounce = { consecutive_empty: 0 };
    const sync = await syncPositionsWithBroker(pm, broker, 'GOLD', debounce);
    expect(sync.ghost_drop_deferred).toBe(false);
    expect(sync.orphans_local.length).toBe(1);
    expect(sync.orphans_local[0]!.position_id).toBe(placed.position_id);
    expect(broker.peekRecentAutoFill(placed.position_id!)?.reason).toBe('STOP_HIT');
    // Bounce above SL must not revive — venue already flat
    broker.setQuote({
      bid: entry + 1,
      ask: entry + 1.2,
      mid: entry + 1.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    expect((await broker.listOpenPositions()).positions.length).toBe(0);
  });

  it('paper empty debounce still applies when no auto-fill (Capital-style ghost)', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const pm = new PositionManager();
    pm.register({
      position_id: 'ghost-no-autofill',
      opportunity_id: 'opp-no-af',
      intent_id: 'no-af-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
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
    const debounce = { consecutive_empty: 0 };
    const deferred = await syncPositionsWithBroker(pm, broker, 'GOLD', debounce);
    expect(deferred.ghost_drop_deferred).toBe(true);
    expect(deferred.orphans_local.length).toBe(0);
    expect(pm.count()).toBe(1);
  });

  it('manage TIME_STOP journals net fill_pnl not stale broker_upl', async () => {
    const prev = process.env.MASTER_COMMISSION_PER_LOT;
    process.env.MASTER_COMMISSION_PER_LOT = '0.05';
    const { MasterPipeline } = await import('../pipeline.js');
    const { PositionManager } = await import('../positionManager.js');
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
      intent_id: 'paper-stale-upl-aaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 50, // wide — soft TIME_STOP must win
      profit_level: entry + 50,
    });
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    const pos = pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-stale-upl',
      intent_id: 'stale-upl-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      entry: placed.fill_price!,
      stop_loss: entry - 50,
      take_profit: entry + 50,
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
    // Stale prior-tick UPL would invent a big win if preferCloseFillPnl used it
    pos.broker_upl = 99;
    pos.entry_at = new Date(Date.now() - 5_000).toISOString();
    // Losing mark inside SL/TP — soft TIME_STOP (wall-clock)
    broker.setQuote({
      bid: entry - 1,
      ask: entry - 0.8,
      mid: entry - 0.9,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const eqBefore = broker.equity;
    const managed = await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: entry - 1,
        ask: entry - 0.8,
        mid: entry - 0.9,
        spread: 0.2,
        epic: 'GOLD',
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      max_hold_ms: 1,
      time_stop_max_bars: 0,
      allow_close: true,
    });
    expect(managed.closed.length).toBe(1);
    expect(managed.closed[0]!.reason).toMatch(/TIME_STOP/);
    const outcome = managed.closed[0]!.outcome;
    // Must match venue equity delta — not stale broker_upl=99
    expect(outcome.pnl).toBeCloseTo(broker.equity - eqBefore, 6);
    expect(Math.abs(outcome.pnl - 99)).toBeGreaterThan(10);
    expect(outcome.pnl).toBeLessThan(0);
    if (prev === undefined) delete process.env.MASTER_COMMISSION_PER_LOT;
    else process.env.MASTER_COMMISSION_PER_LOT = prev;
  });
});

describe('Paper full tick manage-before-sync after setQuote auto-fill', () => {
  it('full tick() returns exits≥1 with STOP_HIT (not sync-only ghost)', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(
      join(tmpdir(), 'vs-paper-tick-manage-sync-')
    );
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
        min_score: 0.99,
        block_off_hours: false,
        block_high_impact_news: false,
        max_relative_volatility: 100,
        max_relative_spread: 100,
        cooldown_ms_after_loss: 0,
        post_exit_cooldown_ms: 0,
        max_daily_loss_pct: 0.99,
        max_drawdown_pct: 0.99,
        time_stop_max_bars: 0,
        max_hold_ms: 86_400_000,
      };
      const broker = masterRuntime.ensurePaperBroker();
      broker.hydrateAccount({ equity: 10_000, balance: 10_000 });
      masterRuntime.running = true;
      masterRuntime.entries_armed = false;

      const entry = 4400;
      const bars = Array.from({ length: 40 }, (_, i) => {
        const o = entry + i * 0.1;
        return {
          open: o,
          high: o + 0.5,
          low: o - 0.5,
          close: o + 0.05,
          ts_ms: Date.UTC(2026, 8, 9, 12, i),
        };
      });
      broker.setQuote({
        bid: entry,
        ask: entry + 0.2,
        mid: entry + 0.1,
        spread: 0.2,
        epic: 'GOLD',
        ts_ms: Date.now(),
      });
      const placed = await broker.placeOrder({
        intent_id: 'paper-tick-manage-before-sync-a',
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        stop_level: entry - 2,
        profit_level: entry + 20,
      });
      expect(placed.ok).toBe(true);
      // Register local open matching venue (decision stub sufficient for manage)
      const analysis = {
        regime: 'TREND' as const,
        market_state: 't',
        momentum_score: 0.5,
        momentum_dir: 'UP' as const,
        trend_dir: 'UP' as const,
        trend_strength: 0.5,
        structure_bias: 'BULLISH' as const,
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
        session: 'LONDON' as const,
      };
      masterRuntime.positions.register({
        position_id: placed.position_id!,
        opportunity_id: 'opp-tick-manage-before-sync',
        intent_id: 'paper-tick-manage-before-sync-a',
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        entry: placed.fill_price!,
        stop_loss: entry - 2,
        take_profit: entry + 20,
        decision: {
          decision_id: 'd-tick-mbs',
          kind: 'BUY',
          side: 'BUY',
          score: 0.7,
          block_reason: null,
          buy: null as never,
          sell: null as never,
          analysis,
          expectancy: null,
        },
      });
      expect(masterRuntime.positions.count()).toBe(1);

      // SL cross on tick quote → setQuote auto-fills, then manage-before-sync
      const crashQuote = {
        bid: entry - 3,
        ask: entry - 2.8,
        mid: entry - 2.9,
        spread: 0.2,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      const result = await masterRuntime.tick(bars, crashQuote);
      expect(result.exits).toBeGreaterThanOrEqual(1);
      expect(
        result.exit_reasons.some((r) => /STOP_HIT/.test(String(r)))
      ).toBe(true);
      expect(masterRuntime.positions.count()).toBe(0);
      expect(String(masterRuntime.last_exit_reason || '')).toMatch(/STOP_HIT/);
    } finally {
      try {
        masterRuntime.ensurePaperBroker().hydrateAccount({
          equity: 10_000,
          balance: 10_000,
        });
      } catch {
        /* ignore */
      }
      masterRuntime.stop();
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });
});

describe('manageOnly equity refresh after close', () => {
  it('manageOnlyTick refreshes account.equity from PaperBroker after STOP_HIT', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(
      join(tmpdir(), 'vs-manage-only-equity-')
    );
    try {
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
      masterRuntime.running = true;

      const entry = 4400;
      const bars = Array.from({ length: 20 }, (_, i) => ({
        open: entry,
        high: entry + 1,
        low: entry - 1,
        close: entry,
        ts_ms: Date.UTC(2026, 8, 9, 13, i),
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
        intent_id: 'manage-only-equity-aaaaaaaa',
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        stop_level: entry - 2,
        profit_level: entry + 20,
      });
      expect(placed.ok).toBe(true);
      masterRuntime.positions.register({
        position_id: placed.position_id!,
        opportunity_id: 'opp-manage-only-equity',
        intent_id: 'manage-only-equity-aaaaaaaa',
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        entry: placed.fill_price!,
        stop_loss: entry - 2,
        take_profit: entry + 20,
        decision: {
          decision_id: 'd-moe',
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

      const crash = {
        bid: entry - 3,
        ask: entry - 2.8,
        mid: entry - 2.9,
        spread: 0.2,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      // Venue auto-fills on setQuote; account.equity stays stale until manageOnly
      masterRuntime.account.equity = 10_000;
      masterRuntime.account.balance = 10_000;
      broker.setQuote(crash);
      expect(broker.equity).toBeLessThan(10_000);
      expect(masterRuntime.account.equity).toBe(10_000);
      await (
        masterRuntime as unknown as {
          manageOnlyTick: (b: typeof bars, q: typeof crash) => Promise<void>;
        }
      ).manageOnlyTick(bars, crash);

      expect(masterRuntime.positions.count()).toBe(0);
      expect(broker.equity).toBeLessThan(10_000);
      // Must mirror venue immediately — not wait for next full tick
      expect(masterRuntime.account.equity).toBe(broker.equity);
      expect(masterRuntime.account.balance).toBe(broker.balance);
    } finally {
      try {
        masterRuntime.ensurePaperBroker().hydrateAccount({
          equity: 10_000,
          balance: 10_000,
        });
      } catch {
        /* ignore */
      }
      masterRuntime.stop();
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });

  it('manageOnlyTick raises peak_equity after winning TP auto-fill', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(
      join(tmpdir(), 'vs-post-close-peak-')
    );
    try {
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
      masterRuntime.account.day_start_equity = 10_000;
      masterRuntime.running = true;

      const entry = 4400;
      const bars = Array.from({ length: 20 }, (_, i) => ({
        open: entry,
        high: entry + 1,
        low: entry - 1,
        close: entry,
        ts_ms: Date.UTC(2026, 8, 9, 14, i),
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
        intent_id: 'post-close-peak-aaaaaaaaaa',
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        stop_level: entry - 5,
        profit_level: entry + 2,
      });
      expect(placed.ok).toBe(true);
      masterRuntime.positions.register({
        position_id: placed.position_id!,
        opportunity_id: 'opp-post-close-peak',
        intent_id: 'post-close-peak-aaaaaaaaaa',
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        entry: placed.fill_price!,
        stop_loss: entry - 5,
        take_profit: entry + 2,
        decision: {
          decision_id: 'd-peak',
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

      const win = {
        bid: entry + 2.5,
        ask: entry + 2.7,
        mid: entry + 2.6,
        spread: 0.2,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      masterRuntime.account.peak_equity = 10_000;
      broker.setQuote(win);
      expect(broker.equity).toBeGreaterThan(10_000);
      expect(masterRuntime.account.peak_equity).toBe(10_000);
      await (
        masterRuntime as unknown as {
          manageOnlyTick: (b: typeof bars, q: typeof win) => Promise<void>;
        }
      ).manageOnlyTick(bars, win);

      expect(masterRuntime.positions.count()).toBe(0);
      expect(masterRuntime.account.equity).toBe(broker.equity);
      expect(masterRuntime.account.peak_equity).toBe(broker.equity);
      expect(masterRuntime.account.peak_equity).toBeGreaterThan(10_000);
    } finally {
      try {
        masterRuntime.ensurePaperBroker().hydrateAccount({
          equity: 10_000,
          balance: 10_000,
        });
      } catch {
        /* ignore */
      }
      masterRuntime.stop();
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });

  it('sync-ghost STOP_HIT refreshes account equity without manage close', async () => {
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = mkdtempSync(
      join(tmpdir(), 'vs-sync-ghost-equity-')
    );
    try {
      masterRuntime.stop();
      masterRuntime.pipeline = new MasterPipeline('PAPER');
      masterRuntime.positions = new PositionManager();
      masterRuntime.cfg = {
        ...DEFAULT_MASTER_CONFIG,
        mode: 'PAPER',
        time_stop_max_bars: 0,
        max_hold_ms: 86_400_000,
        post_exit_cooldown_ms: 60_000,
      };
      const broker = masterRuntime.ensurePaperBroker();
      broker.hydrateAccount({ equity: 10_000, balance: 10_000 });
      masterRuntime.account.equity = 10_000;
      masterRuntime.account.balance = 10_000;
      masterRuntime.account.peak_equity = 10_000;
      masterRuntime.running = true;
      (masterRuntime as unknown as { post_exit_until_ms: number }).post_exit_until_ms = 0;

      const entry = 4400;
      const bars = Array.from({ length: 20 }, (_, i) => ({
        open: entry,
        high: entry + 1,
        low: entry - 1,
        close: entry,
        ts_ms: Date.UTC(2026, 8, 9, 15, i),
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
        intent_id: 'sync-ghost-equity-aaaaaaaa',
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        stop_level: entry - 2,
        profit_level: entry + 20,
      });
      expect(placed.ok).toBe(true);
      masterRuntime.positions.register({
        position_id: placed.position_id!,
        opportunity_id: 'opp-sync-ghost-equity',
        intent_id: 'sync-ghost-equity-aaaaaaaa',
        epic: 'GOLD',
        side: 'BUY',
        size: 1,
        entry: placed.fill_price!,
        stop_loss: entry - 2,
        take_profit: entry + 20,
        decision: {
          decision_id: 'd-sge',
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

      // Auto-fill on crash, then bounce so manage protective does not fire
      broker.setQuote({
        bid: entry - 3,
        ask: entry - 2.8,
        mid: entry - 2.9,
        spread: 0.2,
        epic: 'GOLD',
        ts_ms: Date.now(),
      });
      expect((await broker.listOpenPositions()).positions.length).toBe(0);
      expect(broker.equity).toBeLessThan(10_000);
      const bounce = {
        bid: entry + 1,
        ask: entry + 1.2,
        mid: entry + 1.1,
        spread: 0.2,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      broker.setQuote(bounce);
      masterRuntime.account.equity = 10_000;
      masterRuntime.account.peak_equity = 10_000;
      expect(masterRuntime.positions.count()).toBe(1);

      await (
        masterRuntime as unknown as {
          manageOnlyTick: (b: typeof bars, q: typeof bounce) => Promise<void>;
        }
      ).manageOnlyTick(bars, bounce);

      // Sync-ghost path (not manage close) must still settle account from venue
      expect(masterRuntime.positions.count()).toBe(0);
      expect(String(masterRuntime.last_exit_reason || '')).toMatch(/STOP_HIT/);
      expect(masterRuntime.account.equity).toBe(broker.equity);
      expect(masterRuntime.account.equity).toBeLessThan(10_000);
      // Sync-ghost must arm post-exit cool like manage/manual closes (no same-cycle re-entry)
      expect(masterRuntime.status().post_exit_cooldown_ms).toBeGreaterThan(0);
      expect(
        (masterRuntime as unknown as { post_exit_until_ms: number }).post_exit_until_ms
      ).toBeGreaterThan(Date.now());
    } finally {
      try {
        masterRuntime.ensurePaperBroker().hydrateAccount({
          equity: 10_000,
          balance: 10_000,
        });
      } catch {
        /* ignore */
      }
      masterRuntime.stop();
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });
});
