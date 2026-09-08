/** Event-driven replay — same analysis/decision/risk code as production. No look-ahead. */
import { decideBestOutcomeExit } from '../services/exitManage.js';
import { setupKey } from './decision.js';
import {
  decideSoftTrailArm,
  softTrailDistancePrice,
  softTrailExitHit,
  softTrailExitLevel,
  updateSoftTrailPeak,
} from './moneyExit.js';
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
  toDeskRegime,
} from './positionManager.js';
import type {
  Bar,
  MasterConfig,
  OpportunityRecord,
  Quote,
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
  /** Seed expectancy before replay (walk-forward OOS from IS trades). */
  expectancy_seed?: Array<{ setup_key: string; outcome: TradeOutcome }>;
};

/**
 * At index i the pipeline only sees bars[0..i] (inclusive).
 * Fills use next bar open ± slippage (latency_bars).
 */
export async function replayMaster(opts: ReplayOptions): Promise<{
  opportunities: OpportunityRecord[];
  performance: ReturnType<typeof computePerformance>;
  monte_carlo: ReturnType<typeof monteCarlo>;
  equity_curve: number[];
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
  let daily_pnl = 0;
  let consecutive_losses = 0;
  let last_loss_ms = 0;
  let open: {
    oppId: string;
    decision: OpportunityRecord['decision'];
    side: 'BUY' | 'SELL';
    entry: number;
    volume: number;
    sl: number;
    tp: number;
    open_i: number;
    open_ts: number;
    mfe: number;
    mae: number;
    playbook: 'LONG' | 'SCALP' | 'FADE';
    entry_setup: string;
    soft_trail_armed: boolean;
    soft_trail_peak: number | null;
  } | null = null;

  const equity_curve: number[] = [equity];
  const pv = GOLD_SPEC.value_per_point_per_lot;

  for (let i = warmup; i < opts.bars.length; i++) {
    const visible = opts.bars.slice(0, i + 1);
    const last = visible[visible.length - 1]!;
    const quote: Quote = {
      bid: last.close - spread / 2,
      ask: last.close + spread / 2,
      mid: last.close,
      spread,
      ts_ms: last.ts_ms ?? i * 60_000,
    };

    // Manage open position on current bar (no future bars)
    if (open) {
      const hi = last.high;
      const lo = last.low;
      const mark = last.close;
      const fav =
        open.side === 'BUY' ? mark - open.entry : open.entry - mark;
      open.mfe = Math.max(open.mfe, fav);
      open.mae = Math.min(open.mae, fav);
      const moneyPnl = fav * open.volume * pv;
      const peakRetention =
        open.mfe > 1e-9 ? Math.max(0, Math.min(1, fav / open.mfe)) : null;

      // Live-parity manage: BE + scalp chase + soft trail + BestOutcome + time stop
      if (cfg.be_start > 0 && open.mfe >= cfg.be_start) {
        const be =
          open.side === 'BUY'
            ? open.entry + (cfg.breakeven_offset || 0)
            : open.entry - (cfg.breakeven_offset || 0);
        if (open.side === 'BUY' && be > open.sl) open.sl = be;
        if (open.side === 'SELL' && be < open.sl) open.sl = be;
      }
      if (cfg.scalp_pct_chase && open.mfe > 0) {
        const lock = cfg.scalp_lock_pct ?? 0.2;
        if (open.side === 'BUY') {
          const chase = mark - lock * open.mfe;
          if (chase > open.sl) open.sl = chase;
        } else {
          const chase = mark + lock * open.mfe;
          if (chase < open.sl) open.sl = chase;
        }
      }

      const softArm = cfg.soft_trail_money_arm ?? 0;
      if (softArm > 0 && cfg.scalp_pct_chase) {
        const arm = decideSoftTrailArm({
          money_pnl: moneyPnl,
          money_arm: softArm,
          already_armed: open.soft_trail_armed,
          scalp_enabled: true,
        });
        if (arm.run) {
          if (!open.soft_trail_armed) {
            open.soft_trail_armed = true;
            open.soft_trail_peak = mark;
          } else {
            open.soft_trail_peak = updateSoftTrailPeak(
              open.side,
              mark,
              open.soft_trail_peak
            );
          }
        }
      }

      let exitPx: number | null = null;
      let reason = '';
      if (
        open.soft_trail_armed &&
        open.soft_trail_peak != null &&
        Number.isFinite(open.soft_trail_peak)
      ) {
        const dist = softTrailDistancePrice('GOLD', cfg.soft_trail_pips ?? 0.3);
        const exitLvl = softTrailExitLevel(open.side, open.soft_trail_peak, dist);
        if (softTrailExitHit(open.side, mark, exitLvl)) {
          exitPx = mark;
          reason = 'SOFT_TRAIL';
        }
      }
      if (exitPx == null) {
        const heldMs = Math.max(0, quote.ts_ms - open.open_ts);
        const bo = decideBestOutcomeExit(
          {
            open_side: open.side,
            entry_price: open.entry,
            entry_at: new Date(Date.now() - heldMs).toISOString(),
            mfe: open.mfe,
            mae: Math.abs(Math.min(0, open.mae)),
            peak_retention: peakRetention,
            regime: toDeskRegime(
              open.decision.analysis.regime,
              open.decision.analysis
            ),
            playbook: open.playbook,
            entry_setup: open.entry_setup,
          },
          mark
        );
        if (bo.exit) {
          exitPx = mark;
          reason = bo.reason || 'BEST_OUTCOME';
        }
      }
      if (exitPx == null) {
        if (cfg.max_hold_ms > 0 && quote.ts_ms - open.open_ts >= cfg.max_hold_ms) {
          exitPx = mark;
          reason = 'TIME_STOP';
        } else if (open.side === 'BUY') {
          if (lo <= open.sl) {
            exitPx = open.sl;
            reason = 'SL';
          } else if (hi >= open.tp) {
            exitPx = open.tp;
            reason = 'TP';
          }
        } else {
          if (hi >= open.sl) {
            exitPx = open.sl;
            reason = 'SL';
          } else if (lo <= open.tp) {
            exitPx = open.tp;
            reason = 'TP';
          }
        }
      }
      if (exitPx != null) {
        const slipSigned = open.side === 'BUY' ? -slip : slip;
        const fill = exitPx + slipSigned;
        const pnlGross =
          open.side === 'BUY'
            ? (fill - open.entry) * open.volume
            : (open.entry - fill) * open.volume;
        const pnl = pnlGross - commission;
        const risk = Math.abs(open.entry - open.sl) * open.volume || 1;
        const outcome: TradeOutcome = {
          position_id: `bt-${open.open_i}`,
          side: open.side,
          entry: open.entry,
          exit: fill,
          volume: open.volume,
          pnl,
          fees: commission,
          slippage: Math.abs(slipSigned) * open.volume,
          mae: Math.abs(Math.min(0, open.mae)),
          mfe: Math.max(0, open.mfe),
          r_multiple: pnl / risk,
          hold_ms: (i - open.open_i) * 60_000,
          exit_reason: reason,
        };
        pipe.recordTradeClose(open.oppId, open.decision, outcome);
        equity += pnl;
        daily_pnl += pnl;
        peak = Math.max(peak, equity);
        if (pnl <= 0) {
          consecutive_losses += 1;
          last_loss_ms = quote.ts_ms;
        } else consecutive_losses = 0;
        open = null;
      }
    }

    if (open) {
      equity_curve.push(equity);
      continue;
    }

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
      },
      instrument: specForEpic(GOLD_SPEC.epic),
      cfg,
      last_loss_ms,
      now_ms: quote.ts_ms,
    });

    if (
      cycle.risk.allowed &&
      (cycle.decision.kind === 'BUY' || cycle.decision.kind === 'SELL') &&
      cycle.decision.side
    ) {
      const fillIndex = Math.min(opts.bars.length - 1, i + latency);
      // Fill uses only bar at fillIndex open — known after latency, still no look-ahead beyond that bar
      const fillBar = opts.bars[fillIndex]!;
      const side = cycle.decision.side;
      const cand = side === 'BUY' ? cycle.decision.buy : cycle.decision.sell;
      const raw =
        side === 'BUY' ? fillBar.open + spread / 2 + slip : fillBar.open - spread / 2 - slip;
      const intent = pipe.newIntentId(cycle.decision.decision_id);
      if (pipe.claimIntent(intent)) {
        pipe.markExecuted(cycle.opportunity.id, {
          intent_id: intent,
          order_id: `bt-${i}`,
          accepted: true,
          fill_price: raw,
          detail: 'backtest_fill',
          paper: true,
        });
        open = {
          oppId: cycle.opportunity.id,
          decision: cycle.decision,
          side,
          entry: raw,
          volume: cycle.risk.volume,
          sl: cand.stop_loss,
          tp: cand.take_profit,
          open_i: fillIndex,
          open_ts: fillBar.ts_ms ?? fillIndex * 60_000,
          mfe: 0,
          mae: 0,
          playbook: mapRegimeToPlaybook(
            cycle.decision.analysis.regime,
            cycle.decision.analysis
          ),
          entry_setup: entrySetupFromRegime(
            cycle.decision.analysis.regime,
            cycle.decision.analysis
          ),
          soft_trail_armed: false,
          soft_trail_peak: null,
        };
        // skip ahead to fill bar index to avoid using future beyond fill for entry decision already taken
        i = fillIndex;
      }
    }

    equity_curve.push(equity);
  }

  // Force-close leftover at last close
  if (open) {
    const last = opts.bars[opts.bars.length - 1]!;
    const fill = last.close;
    const pnlGross =
      open.side === 'BUY'
        ? (fill - open.entry) * open.volume
        : (open.entry - fill) * open.volume;
    const pnl = pnlGross - commission;
    const risk = Math.abs(open.entry - open.sl) * open.volume || 1;
    pipe.recordTradeClose(open.oppId, open.decision, {
      position_id: `bt-eod`,
      side: open.side,
      entry: open.entry,
      exit: fill,
      volume: open.volume,
      pnl,
      fees: commission,
      slippage: 0,
      mae: Math.abs(Math.min(0, open.mae)),
      mfe: Math.max(0, open.mfe),
      r_multiple: pnl / risk,
      hold_ms: (opts.bars.length - 1 - open.open_i) * 60_000,
      exit_reason: 'EOD',
    });
    equity += pnl;
    equity_curve.push(equity);
    open = null;
  }

  const traded = pipe.journal.traded();
  const pnls = traded.map((t) => t.outcome!.pnl);
  return {
    opportunities: pipe.journal.opportunities,
    performance: computePerformance(traded),
    monte_carlo: monteCarlo(pnls, 300),
    equity_curve,
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
        setup_key: setupKey(t.decision.analysis, t.decision.side!),
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
