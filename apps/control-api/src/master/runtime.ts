/** MASTER runtime facade — PAPER/LIVE status for dashboard + cycle driver. */
import { analyzeBars } from './analysis.js';
import { decide } from './decision.js';
import {
  DEFAULT_MASTER_CONFIG,
  GOLD_SPEC,
  MasterPipeline,
} from './pipeline.js';
import { computePerformance, monteCarlo } from './performance.js';
import { evaluateRisk } from './risk.js';
import type {
  AccountSnapshot,
  Bar,
  MasterConfig,
  Mode,
  Quote,
} from './types.js';

export type MasterStatus = {
  mode: Mode;
  running: boolean;
  kill_switch: boolean;
  last_decision: ReturnType<typeof decide> | null;
  last_risk: ReturnType<typeof evaluateRisk> | null;
  last_block_reason: string | null;
  buy_score: number;
  sell_score: number;
  regime: string;
  market_state: string;
  account: AccountSnapshot | null;
  performance: ReturnType<typeof computePerformance>;
  monte_carlo: ReturnType<typeof monteCarlo> | null;
  opportunities: number;
  traded: number;
  blocked: number;
  health: string;
};

class MasterRuntime {
  pipeline = new MasterPipeline('PAPER');
  cfg: MasterConfig = { ...DEFAULT_MASTER_CONFIG };
  running = false;
  account: AccountSnapshot = {
    equity: 10_000,
    balance: 10_000,
    currency: 'GBP',
    open_positions: 0,
    daily_pnl: 0,
    peak_equity: 10_000,
    consecutive_losses: 0,
  };
  last_decision: ReturnType<typeof decide> | null = null;
  last_risk: ReturnType<typeof evaluateRisk> | null = null;
  last_bars: Bar[] = [];
  last_quote: Quote | null = null;

  setMode(mode: Mode) {
    this.cfg = { ...this.cfg, mode };
    this.pipeline.mode = mode;
  }

  setKillSwitch(on: boolean) {
    this.cfg = { ...this.cfg, kill_switch: on };
  }

  /** Pure evaluation for dashboard / paper — does not send broker orders here. */
  evaluate(bars: Bar[], quote: Quote) {
    this.last_bars = bars;
    this.last_quote = quote;
    const analysis = analyzeBars(bars, quote.spread);
    const decision = decide(analysis, quote, this.cfg, (k) =>
      this.pipeline.expectancy.lookup(k)
    );
    const risk = evaluateRisk(decision, this.account, GOLD_SPEC, quote, this.cfg, {
      symbol_open: this.account.open_positions,
    });
    this.last_decision = decision;
    this.last_risk = risk;
    this.pipeline.journal.recordOpportunity({
      mode: this.cfg.mode,
      epic: GOLD_SPEC.epic,
      decision,
      risk,
      executed: false,
    });
    return { decision, risk, analysis };
  }

  status(): MasterStatus {
    const perf = computePerformance(this.pipeline.journal.traded());
    const pnls = this.pipeline.journal
      .traded()
      .map((t) => t.outcome!.pnl);
    return {
      mode: this.cfg.mode,
      running: this.running,
      kill_switch: this.cfg.kill_switch,
      last_decision: this.last_decision,
      last_risk: this.last_risk,
      last_block_reason:
        this.last_decision?.block_reason ||
        this.last_risk?.reasons.join(',') ||
        null,
      buy_score: this.last_decision?.buy.score ?? 0,
      sell_score: this.last_decision?.sell.score ?? 0,
      regime: this.last_decision?.analysis.regime ?? 'UNKNOWN',
      market_state: this.last_decision?.analysis.market_state ?? '—',
      account: this.account,
      performance: perf,
      monte_carlo: pnls.length ? monteCarlo(pnls, 200) : null,
      opportunities: this.pipeline.journal.opportunities.length,
      traded: this.pipeline.journal.traded().length,
      blocked: this.pipeline.journal.blocked().length,
      health: this.cfg.kill_switch
        ? 'KILL_SWITCH'
        : this.cfg.mode === 'LIVE'
          ? 'LIVE_ARMED'
          : 'OK',
    };
  }
}

export const masterRuntime = new MasterRuntime();
