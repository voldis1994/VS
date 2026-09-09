/** Event-driven replay — same analysis/decision/risk + PositionManager exit brain as live. */
import { PaperBroker } from './broker.js';
import {
  emaPairFromBars,
  analyzeBars,
  emaFromBars,
} from './analysis.js';
import {
  buildEqualMultiTpPlan,
  multiTpFinalPrice,
} from './multiTp.js';
import { computePerformance, monteCarlo } from './performance.js';
import {
  DEFAULT_MASTER_CONFIG,
  GOLD_SPEC,
  MasterPipeline,
  specForEpic,
} from './pipeline.js';
import {
  entrySetupFromRegime,
  mapRegimeToPlaybook,
  PositionManager,
  protectiveMark,
} from './positionManager.js';
import { resolveAdvisor } from './ai.js';
import { updateSpreadModel } from './spreadModel.js';
import { setupKey } from './decision.js';
import type { CapitalPriceCandle } from '../services/capitalCom.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';
import type {
  Bar,
  MasterConfig,
  OpportunityRecord,
  Quote,
  Side,
  TradeOutcome,
} from './types.js';

export type ReplayOptions = {
  bars: Bar[];
  warmup?: number;
  cfg?: Partial<MasterConfig>;
  starting_equity?: number;
  spread?: number;
  slippage_pts?: number;
  commission?: number;
  latency_bars?: number;
  /** Trading epic for exit geometry (live uses pos.epic — default GOLD). */
  epic?: string;
  /** Seed expectancy before replay (walk-forward OOS from IS trades). */
  expectancy_seed?: Array<{ setup_key: string; outcome: TradeOutcome }>;
  /**
   * Test/operator override for soft-exit AI gate.
   * When set, skips resolveAdvisor and uses this value (hard SL/TP still fire).
   */
  force_allow_close?: boolean;
  /** Seed reject cooldown (quote.ts_ms units) — live reject_until_ms peer */
  reject_until_ms?: number;
  /** Seed inflight window — live inflight_until_ms peer */
  inflight_until_ms?: number;
  /**
   * When false, skip synthetic closed_10s / hour_bars (legacy replay without desk confirm).
   * Default true — live-parity desk SETUP/MOVE path.
   */
  desk_confirm?: boolean;
};

/** Treat the current replay bar OHLC as a just-closed 10s confirm bar. */
export function closed10sFromReplayBar(bar: Bar): TenSecBar {
  const ts = Number(bar.ts_ms) || 0;
  return {
    open_time_ms: Math.max(0, ts - 10_000),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    ticks: 1,
  };
}

/** Aggregate 1m (or finer) bars into hour candles for structure hour_bias. */
export function hourBarsFromReplayMinutes(bars: Bar[]): CapitalPriceCandle[] {
  const buckets = new Map<number, Bar[]>();
  for (const b of bars) {
    const t = Number(b.ts_ms) || 0;
    const hour = Math.floor(t / 3_600_000) * 3_600_000;
    const list = buckets.get(hour) || [];
    list.push(b);
    buckets.set(hour, list);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, group]) => {
      const first = group[0]!;
      const last = group[group.length - 1]!;
      let high = first.high;
      let low = first.low;
      for (const g of group) {
        if (g.high > high) high = g.high;
        if (g.low < low) low = g.low;
      }
      return {
        open: first.open,
        high,
        low,
        close: last.close,
        snapshotTime: new Date(hour).toISOString(),
      };
    });
}

function quoteFromClose(bar: Bar, spread: number, epic: string): Quote {
  const mid = bar.close;
  return {
    bid: mid - spread / 2,
    ask: mid + spread / 2,
    mid,
    spread,
    ts_ms: bar.ts_ms ?? 0,
    epic,
  };
}

/** Adverse extreme so protectiveMark can hit SL from bar wick (BUY→low, SELL→high). */
function adverseProtectiveQuote(
  side: Side,
  bar: Bar,
  spread: number,
  epic: string
): Quote {
  if (side === 'BUY') {
    const bid = bar.low;
    return {
      bid,
      ask: bid + spread,
      mid: bid + spread / 2,
      spread,
      ts_ms: bar.ts_ms ?? 0,
      epic,
    };
  }
  const ask = bar.high;
  return {
    bid: ask - spread,
    ask,
    mid: ask - spread / 2,
    spread,
    ts_ms: bar.ts_ms ?? 0,
    epic,
  };
}

/** Favorable extreme so protectiveMark can hit TP from bar wick. */
function favorableProtectiveQuote(
  side: Side,
  bar: Bar,
  spread: number,
  epic: string
): Quote {
  if (side === 'BUY') {
    const bid = bar.high;
    return {
      bid,
      ask: bid + spread,
      mid: bid + spread / 2,
      spread,
      ts_ms: bar.ts_ms ?? 0,
      epic,
    };
  }
  const ask = bar.low;
  return {
    bid: ask - spread,
    ask,
    mid: ask - spread / 2,
    spread,
    ts_ms: bar.ts_ms ?? 0,
    epic,
  };
}

/**
 * At index i the pipeline only sees bars[0..i] (inclusive).
 * Fills use next bar open ± slippage (latency_bars).
 * Exits use live PositionManager.manageTick (hard wick pass + soft close pass).
 */
export async function replayMaster(opts: ReplayOptions): Promise<{
  opportunities: OpportunityRecord[];
  performance: ReturnType<typeof computePerformance>;
  monte_carlo: ReturnType<typeof monteCarlo>;
  equity_curve: number[];
  day_start_equity: number;
  daily_pnl_day: string;
}> {
  const warmup = opts.warmup ?? 25;
  const cfg: MasterConfig = {
    ...DEFAULT_MASTER_CONFIG,
    ...opts.cfg,
    mode: 'BACKTEST',
  };
  const pipe = new MasterPipeline('BACKTEST');
  if (opts.expectancy_seed?.length) {
    pipe.expectancy.hydrate(opts.expectancy_seed);
  }
  const spread = opts.spread ?? 0.4;
  const slip = opts.slippage_pts ?? 0.1;
  const commission = opts.commission ?? 0.05;
  const latency = Math.max(0, opts.latency_bars ?? 1);

  let equity = opts.starting_equity ?? 10_000;
  let peak = equity;
  let day_start_equity = equity;
  let daily_pnl = 0;
  let daily_pnl_day = '';
  let consecutive_losses = 0;
  let last_loss_ms = 0;
  /** Soft-exit AI gate — refreshed each bar when ai_mode !== 'off' (live last_ai_allow_close). */
  let allow_close = cfg.ai_mode === 'off';
  /** Live post-exit / fingerprint rearm — no same-signal re-entry until cool elapses. */
  let post_exit_until_ms = 0;
  let last_entry_fingerprint: string | null = null;
  /** Live reject / inflight peers (broker reject backoff + OPEN-in-flight). */
  let reject_until_ms = Math.max(0, opts.reject_until_ms || 0);
  let inflight_until_ms = Math.max(0, opts.inflight_until_ms || 0);
  let spreadHistory: number[] = [];

  const equity_curve: number[] = [equity];
  const epic = String(opts.epic || GOLD_SPEC.epic || 'GOLD').trim() || 'GOLD';
  const instrument = specForEpic(epic);
  const pv = instrument.value_per_point_per_lot;

  // One authoritative exit brain — same PositionManager as live runtime
  const pm = new PositionManager();
  const paper = new PaperBroker();
  paper.hydrateAccount({ equity, balance: equity });

  const applyManagedClosed = (
    closed: Array<{ outcome: TradeOutcome; reason: string }>,
    ts_ms: number
  ) => {
    // PaperBroker already applied gross−fees into equity on close
    equity = paper.equity;
    peak = Math.max(peak, equity);
    for (const c of closed) {
      const pnl = c.outcome.pnl;
      daily_pnl += pnl;
      if (pnl <= 0) {
        consecutive_losses += 1;
        last_loss_ms = ts_ms;
      } else consecutive_losses = 0;
      const cool = Math.max(0, cfg.post_exit_cooldown_ms || 0);
      post_exit_until_ms = Math.max(post_exit_until_ms, ts_ms + cool);
      last_entry_fingerprint = `${epic}:${c.outcome.side}`;
    }
  };

  const runManage = async (
    quote: Quote,
    visible: Bar[],
    optsManage: { hard_only: boolean; allow_close: boolean }
  ) => {
    paper.setQuote({
      epic,
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      spread: quote.spread,
      ts_ms: quote.ts_ms,
    });
    const structure = visible.length >= 5 ? analyzeBars(visible, spread, quote.ts_ms) : null;
    const trailBuf =
      structure && structure.atr > 0
        ? structure.atr * cfg.trailing_buffer_atr_mult
        : 0;
    const e1 = emaPairFromBars(visible, 1);
    const e3 = emaPairFromBars(visible, 3);
    const ema3 = e3?.cur ?? (visible.length >= 3 ? emaFromBars(visible, 3) : null);
    const managed = await pm.manageTick({
      broker: paper,
      pipeline: pipe,
      quote,
      now_ms: quote.ts_ms,
      hard_only: optsManage.hard_only,
      instrument_point_value: pv,
      max_hold_ms: optsManage.hard_only ? 0 : cfg.max_hold_ms,
      time_stop_max_bars: optsManage.hard_only ? 0 : cfg.time_stop_max_bars,
      breakeven_progress: cfg.breakeven_progress,
      breakeven_offset: cfg.breakeven_offset,
      be_start: cfg.be_start,
      trail_start: cfg.trail_start,
      trail_lock: cfg.trail_lock,
      partial_close_progress: cfg.partial_close_progress,
      partial_close_volume: cfg.partial_close_volume,
      volume_step: instrument.volume_step,
      swing_low: structure?.swing_low ?? null,
      swing_high: structure?.swing_high ?? null,
      trailing_buffer: trailBuf,
      ema3,
      ema1: e1?.cur ?? null,
      ema1_prev: e1?.prev ?? null,
      ema3_prev: e3?.prev ?? null,
      ema1_prev2: e1?.prev2 ?? null,
      ema3_prev2: e3?.prev2 ?? null,
      allow_close: optsManage.allow_close,
      close_all_profit: cfg.close_all_profit,
      close_all_loss: cfg.close_all_loss,
      breakeven_activation_money: cfg.breakeven_activation_money,
      soft_trail_money_arm: cfg.soft_trail_money_arm,
      soft_trail_pips: cfg.soft_trail_pips,
      scalp_pct_chase: cfg.scalp_pct_chase,
      scalp_lock_pct: cfg.scalp_lock_pct,
      live_regime: structure?.regime ?? null,
    });
    applyManagedClosed(managed.closed, quote.ts_ms);
    return managed;
  };

  for (let i = warmup; i < opts.bars.length; i++) {
    const visible = opts.bars.slice(0, i + 1);
    const last = visible[visible.length - 1]!;
    const quote = quoteFromClose(last, spread, epic);
    // Roll UTC day like live — day_start_equity drives profit_lock / daily_loss_limit
    const day = new Date(quote.ts_ms).toISOString().slice(0, 10);
    if (daily_pnl_day !== day) {
      daily_pnl = 0;
      daily_pnl_day = day;
      day_start_equity = equity;
    }

    // Manage open via live PositionManager (hard wick → soft close)
    if (pm.count() > 0) {
      if (opts.force_allow_close != null) {
        allow_close = opts.force_allow_close;
      } else if (cfg.ai_mode === 'off') {
        allow_close = true;
      } else {
        const aGate = analyzeBars(visible, spread, quote.ts_ms);
        const adv = await resolveAdvisor(aGate, cfg.ai_mode);
        allow_close = adv.advisor == null ? false : adv.advisor.allow_close !== false;
      }
      const pos = pm.list()[0]!;
      // 1) Adverse extreme — STOP_HIT from wick (hard_only)
      await runManage(adverseProtectiveQuote(pos.side, last, spread, epic), visible, {
        hard_only: true,
        allow_close: false,
      });
      // 2) Favorable extreme — TP_HIT from wick
      if (pm.count() > 0) {
        await runManage(
          favorableProtectiveQuote(pos.side, last, spread, epic),
          visible,
          { hard_only: true, allow_close: false }
        );
      }
      // 3) Close mark — soft exits / BE / trail / TIME_STOP (live peer)
      if (pm.count() > 0) {
        await runManage(quote, visible, {
          hard_only: false,
          allow_close,
        });
      }
      if (pm.count() > 0) {
        equity_curve.push(equity);
        continue;
      }
    }

    // Flat + post-exit elapsed → clear sticky fingerprint (live peer)
    if (quote.ts_ms >= post_exit_until_ms && last_entry_fingerprint) {
      last_entry_fingerprint = null;
    }

    const spreadSnap = updateSpreadModel(
      spreadHistory,
      quote.spread,
      cfg.spread_lookback_bars ?? 20
    );
    spreadHistory = spreadSnap.history;

    const cycleT0 = Date.now();
    const cycle = await pipe.runCycle({
      bars: visible,
      quote,
      account: {
        equity,
        balance: equity,
        currency: 'GBP',
        open_positions: 0,
        daily_pnl,
        peak_equity: peak,
        consecutive_losses,
        day_start_equity,
      },
      instrument,
      cfg,
      last_loss_ms,
      now_ms: quote.ts_ms,
      relative_spread:
        spreadSnap.history.length >= 3 ? spreadSnap.relative_spread : null,
      ...(opts.desk_confirm === false
        ? {}
        : {
            closed_10s: closed10sFromReplayBar(last),
            hour_bars: hourBarsFromReplayMinutes(visible),
          }),
    });

    const postExitCool = quote.ts_ms < post_exit_until_ms;
    const rejectCool = quote.ts_ms < reject_until_ms;
    const inflight = quote.ts_ms < inflight_until_ms;
    const cycleBudgetMs = Number(cfg.cycle_max_duration_ms);
    const cycleTimedOut =
      Number.isFinite(cycleBudgetMs) &&
      cycleBudgetMs > 0 &&
      Date.now() - cycleT0 > cycleBudgetMs;
    const signalFp =
      cycle.decision.kind === 'BUY' || cycle.decision.kind === 'SELL'
        ? `${epic}:${cycle.decision.kind}`
        : null;
    const sameSignal =
      !!signalFp &&
      !!last_entry_fingerprint &&
      last_entry_fingerprint === signalFp &&
      postExitCool;

    if (
      cycle.risk.allowed &&
      (cycle.decision.kind === 'BUY' || cycle.decision.kind === 'SELL') &&
      cycle.decision.side &&
      !postExitCool &&
      !sameSignal &&
      !rejectCool &&
      !inflight &&
      !cycleTimedOut
    ) {
      const fillIndex = Math.min(opts.bars.length - 1, i + latency);
      const fillBar = opts.bars[fillIndex]!;
      const side = cycle.decision.side;
      const cand = side === 'BUY' ? cycle.decision.buy : cycle.decision.sell;
      const raw =
        side === 'BUY' ? fillBar.open + spread / 2 + slip : fillBar.open - spread / 2 - slip;
      const intent = pipe.newIntentId(cycle.decision.decision_id);
      inflight_until_ms = Math.max(
        inflight_until_ms,
        (fillBar.ts_ms ?? quote.ts_ms) + 90_000
      );
      if (pipe.claimIntent(intent)) {
        pipe.markExecuted(cycle.opportunity.id, {
          intent_id: intent,
          order_id: `bt-${i}`,
          accepted: true,
          fill_price: raw,
          detail: 'backtest_fill',
          paper: true,
        });
        inflight_until_ms = 0;
        const open_ts = fillBar.ts_ms ?? fillIndex * 60_000;
        const sl =
          cand.stop_loss != null &&
          Number.isFinite(cand.stop_loss) &&
          cand.stop_loss > 0
            ? cand.stop_loss
            : null;
        let tp = cand.take_profit;
        const multi =
          cfg.multi_tp_count >= 2
            ? buildEqualMultiTpPlan({
                side,
                entry: raw,
                initial_volume: cycle.risk.volume,
                count: cfg.multi_tp_count,
                atr: Math.max(cycle.decision.analysis.atr || 1, 0.5),
                atr_tp_mult: cfg.multi_tp_atr_mult || 1.5,
                volume_step: 0.01,
              })
            : undefined;
        if (multi?.length) {
          const final = multiTpFinalPrice(multi);
          if (final != null) tp = final;
        }
        const position_id = `bt-${fillIndex}`;
        pm.register({
          position_id,
          opportunity_id: cycle.opportunity.id,
          intent_id: intent,
          epic,
          side,
          size: cycle.risk.volume,
          entry: raw,
          stop_loss: sl,
          take_profit: tp,
          decision: cycle.decision,
          multi_tp_levels: multi,
          entry_at: new Date(open_ts).toISOString(),
        });
        // Stamp playbook/setup from decision (register already maps; keep meta aligned)
        const held = pm.get(position_id);
        if (held) {
          held.playbook_at_entry = mapRegimeToPlaybook(
            cycle.decision.analysis.regime,
            cycle.decision.analysis
          );
          held.entry_setup = entrySetupFromRegime(
            cycle.decision.analysis.regime,
            cycle.decision.analysis
          );
        }
        paper.seedOpens([
          {
            position_id,
            epic,
            side,
            size: cycle.risk.volume,
            open_level: raw,
            stop_level: sl,
            profit_level: tp,
          },
        ]);
        allow_close = cycle.ai.allow_close !== false;
        last_entry_fingerprint = `${epic}:${side}`;
        i = fillIndex;
      } else {
        reject_until_ms = Math.max(reject_until_ms, quote.ts_ms + 30_000);
        inflight_until_ms = 0;
      }
    }

    equity_curve.push(equity);
  }

  // Force-close leftover at last close
  if (pm.count() > 0) {
    const last = opts.bars[opts.bars.length - 1]!;
    const pos = pm.list()[0]!;
    const fill = last.close;
    const q = quoteFromClose(last, spread, epic);
    paper.setQuote({
      epic,
      bid: fill - spread / 2,
      ask: fill + spread / 2,
      mid: fill,
      spread,
      ts_ms: last.ts_ms ?? 0,
    });
    // Prefer mark close through broker so book clears; journal EOD explicitly
    const closeRes = await paper.closePosition(pos.position_id);
    const exitPx = closeRes.fill_price ?? protectiveMark(pos.side, q);
    const pnlGross =
      pos.side === 'BUY'
        ? (exitPx - pos.entry) * pos.size * pv
        : (pos.entry - exitPx) * pos.size * pv;
    const pnl = pnlGross - commission;
    const risk = Math.abs(pos.entry - (pos.stop_loss ?? pos.entry)) * pos.size || 1;
    pipe.recordTradeClose(pos.opportunity_id, pos.decision, {
      position_id: `bt-eod`,
      side: pos.side,
      entry: pos.entry,
      exit: exitPx,
      volume: pos.size,
      pnl,
      fees: commission,
      slippage: 0,
      mae: Math.abs(Math.min(0, -pos.mae)),
      mfe: Math.max(0, pos.mfe),
      r_multiple: pnl / risk,
      hold_ms: Math.max(0, (last.ts_ms ?? 0) - new Date(pos.entry_at).getTime()),
      exit_reason: 'EOD',
    });
    equity += pnl;
    paper.hydrateAccount({ equity, balance: equity });
    equity_curve.push(equity);
    pm.fromJSON([]);
  }

  const traded = pipe.journal.traded();
  const pnls = traded.map((t) => t.outcome!.pnl);
  return {
    opportunities: pipe.journal.opportunities,
    performance: computePerformance(traded),
    monte_carlo: monteCarlo(pnls, 300),
    equity_curve,
    /** Last UTC day_start_equity after rolls — live profit_lock / daily_loss parity */
    day_start_equity,
    daily_pnl_day,
  };
}

/** Rolling walk-forward: train windows seed expectancy; OOS honors require_positive_expectancy. */
export async function walkForward(opts: {
  bars: Bar[];
  train: number;
  test: number;
  step: number;
  cfg?: Partial<MasterConfig>;
}): Promise<{
  windows: Array<{
    train_from: number;
    train_to: number;
    test_from: number;
    test_to: number;
    in_sample: ReturnType<typeof computePerformance>;
    out_of_sample: ReturnType<typeof computePerformance>;
  }>;
}> {
  const windows = [];
  const train = opts.train;
  const test = opts.test;
  const step = opts.step;
  for (let start = 0; start + train + test <= opts.bars.length; start += step) {
    const trainBars = opts.bars.slice(start, start + train);
    const testBars = opts.bars.slice(start + train - 25, start + train + test);
    const is = await replayMaster({
      bars: trainBars,
      cfg: { ...opts.cfg, require_positive_expectancy: false },
    });
    const expectancy_seed = is.opportunities
      .filter((t) => t.outcome && t.decision.side)
      .map((t) => ({
        setup_key: setupKey(
          t.decision.analysis,
          t.decision.side!,
          t.epic,
          t.decision.desk_entry_source
        ),
        outcome: t.outcome!,
      }));
    const oos = await replayMaster({
      bars: testBars,
      cfg: opts.cfg,
      expectancy_seed,
    });
    windows.push({
      train_from: start,
      train_to: start + train,
      test_from: start + train,
      test_to: start + train + test,
      in_sample: is.performance,
      out_of_sample: oos.performance,
    });
  }
  return { windows };
}

/** AI on/off A/B — same bars, empirical delta only (no promised edge). */
export async function abCompareAi(opts: ReplayOptions): Promise<{
  off: Awaited<ReturnType<typeof replayMaster>>;
  on: Awaited<ReturnType<typeof replayMaster>>;
  delta_expectancy: number;
  note: string;
}> {
  const off = await replayMaster({
    ...opts,
    cfg: { ...opts.cfg, ai_mode: 'off' },
  });
  const on = await replayMaster({
    ...opts,
    cfg: { ...opts.cfg, ai_mode: 'advisory' },
  });
  return {
    off,
    on,
    delta_expectancy: on.performance.expectancy - off.performance.expectancy,
    note: 'Empirical A/B on identical bars — heuristic AI advisory vs off. Not a profit claim.',
  };
}
