/** MASTER runtime — full PAPER/LIVE cycle owner + dashboard facade. */
import { analyzeBars } from './analysis.js';
import type { MasterBroker } from './broker.js';
import { PaperBroker } from './broker.js';
import { decide } from './decision.js';
import { executeDecision } from './execution.js';
import {
  loadOpenPositions,
  loadSeenIntents,
  persistOpportunity,
  persistOutcome,
  saveOpenPositions,
  saveSeenIntents,
} from './persist.js';
import { syncPositionsWithBroker } from './positionSync.js';
import {
  DEFAULT_MASTER_CONFIG,
  GOLD_SPEC,
  MasterPipeline,
} from './pipeline.js';
import { computePerformance, monteCarlo } from './performance.js';
import { PositionManager } from './positionManager.js';
import { evaluateRisk } from './risk.js';
import { setupKey } from './decision.js';
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
  broker: string | null;
  last_decision: ReturnType<typeof decide> | null;
  last_risk: ReturnType<typeof evaluateRisk> | null;
  last_block_reason: string | null;
  last_execution_detail: string | null;
  last_exit_reason: string | null;
  buy_score: number;
  sell_score: number;
  regime: string;
  market_state: string;
  account: AccountSnapshot | null;
  open_positions: number;
  performance: ReturnType<typeof computePerformance>;
  monte_carlo: ReturnType<typeof monteCarlo> | null;
  opportunities: number;
  traded: number;
  blocked: number;
  health: string;
  recovered: boolean;
};

export type TickResult = {
  decision: ReturnType<typeof decide>;
  risk: ReturnType<typeof evaluateRisk>;
  executed: boolean;
  execution_detail: string | null;
  exits: number;
  exit_reasons: string[];
};

class MasterRuntime {
  pipeline = new MasterPipeline('PAPER');
  positions = new PositionManager();
  cfg: MasterConfig = { ...DEFAULT_MASTER_CONFIG };
  running = false;
  broker: MasterBroker | null = null;
  paperBroker = new PaperBroker();
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
  last_execution_detail: string | null = null;
  last_exit_reason: string | null = null;
  last_loss_ms = 0;
  recovered = false;
  /** VS-System- style: block new entries while an order is in-flight without a position yet. */
  private inflight_until_ms = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seenIntentSnapshot: string[] = [];
  epic = GOLD_SPEC.epic;

  setMode(mode: Mode) {
    this.cfg = { ...this.cfg, mode };
    this.pipeline.mode = mode;
  }

  setKillSwitch(on: boolean) {
    this.cfg = { ...this.cfg, kill_switch: on };
  }

  setEpic(epic: string) {
    this.epic = epic;
  }

  /** Attach broker — PAPER uses in-memory PaperBroker by default. */
  attachBroker(broker: MasterBroker) {
    this.broker = broker;
  }

  ensurePaperBroker(): PaperBroker {
    this.broker = this.paperBroker;
    return this.paperBroker;
  }

  /** Pure evaluation for dashboard — does not send orders. */
  evaluate(bars: Bar[], quote: Quote) {
    this.last_bars = bars;
    this.last_quote = quote;
    const analysis = analyzeBars(bars, quote.spread);
    const decision = decide(analysis, quote, this.cfg, (k) =>
      this.pipeline.expectancy.lookup(k)
    );
    const risk = evaluateRisk(decision, this.account, GOLD_SPEC, quote, this.cfg, {
      symbol_open: this.positions.countForEpic(this.epic),
      last_loss_ms: this.last_loss_ms,
    });
    this.last_decision = decision;
    this.last_risk = risk;
    const opp = this.pipeline.journal.recordOpportunity({
      mode: this.cfg.mode,
      epic: this.epic,
      decision,
      risk,
      executed: false,
    });
    void persistOpportunity(opp);
    return { decision, risk, analysis, opportunity: opp };
  }

  /**
   * One authoritative cycle:
   * MARKET → … → DECISION → RISK → EXECUTION → POSITION MANAGE → JOURNAL
   */
  async tick(bars: Bar[], quote: Quote): Promise<TickResult> {
    this.last_bars = bars;
    this.last_quote = quote;
    const broker = this.broker || this.ensurePaperBroker();

    if (broker instanceof PaperBroker) {
      broker.setQuote({
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        spread: quote.spread,
        epic: this.epic,
        ts_ms: quote.ts_ms,
      });
      broker.markToMarket();
      const acct = await broker.getAccount();
      if (acct) {
        this.account.equity = acct.equity;
        this.account.balance = acct.balance;
        this.account.currency = acct.currency;
        this.account.peak_equity = Math.max(this.account.peak_equity, acct.equity);
      }
    }

    this.account.open_positions = this.positions.count();

    // 1) Manage exits first (position manager owns open risk)
    const managed = await this.positions.manageTick({
      broker,
      pipeline: this.pipeline,
      quote,
      instrument_point_value: GOLD_SPEC.value_per_point_per_lot,
    });
    const exit_reasons = managed.closed.map((c) => c.reason);
    if (exit_reasons.length) this.last_exit_reason = exit_reasons.at(-1)!;
    for (const c of managed.closed) {
      this.account.daily_pnl += c.outcome.pnl;
      if (c.outcome.pnl < 0) {
        this.account.consecutive_losses += 1;
        this.last_loss_ms = Date.now();
      } else {
        this.account.consecutive_losses = 0;
      }
      const sk = c.position.decision.side
        ? setupKey(c.position.decision.analysis, c.position.decision.side)
        : null;
      void persistOutcome(c.position.opportunity_id, c.outcome, sk);
    }

    // 2) Decision + risk
    const cycle = this.pipeline.runCycle({
      bars,
      quote,
      account: {
        ...this.account,
        open_positions: this.positions.count(),
      },
      instrument: { ...GOLD_SPEC, epic: this.epic },
      cfg: this.cfg,
      symbol_open: this.positions.countForEpic(this.epic),
      last_loss_ms: this.last_loss_ms,
    });
    this.last_decision = cycle.decision;
    this.last_risk = cycle.risk;
    void persistOpportunity(cycle.opportunity);

    // 3) Execution gate
    const allow_live =
      this.cfg.mode === 'LIVE' && process.env.MASTER_LIVE_ENABLED === 'true';
    let executed = false;
    let execution_detail: string | null = null;

    const inflight =
      Date.now() < this.inflight_until_ms || this.positions.count() > 0;
    if (
      this.running &&
      (this.cfg.mode === 'PAPER' || allow_live) &&
      (cycle.decision.kind === 'BUY' || cycle.decision.kind === 'SELL') &&
      cycle.risk.allowed &&
      !inflight
    ) {
      this.inflight_until_ms = Date.now() + 90_000;
      const { execution, place } = await executeDecision({
        broker,
        pipeline: this.pipeline,
        opportunity: cycle.opportunity,
        decision: cycle.decision,
        risk: cycle.risk,
        epic: this.epic,
        allow_live: allow_live || broker.paper,
      });
      execution_detail = execution.detail;
      this.last_execution_detail = execution.detail;
      void persistOpportunity({
        ...cycle.opportunity,
        executed: execution.accepted,
        execution,
      });

      if (execution.accepted && place?.position_id) {
        executed = true;
        this.inflight_until_ms = 0;
        this.seenIntentSnapshot.push(execution.intent_id);
        const fill =
          place.fill_price ??
          (cycle.decision.side === 'BUY' ? quote.ask : quote.bid);
        const cand =
          cycle.decision.side === 'BUY' ? cycle.decision.buy : cycle.decision.sell;
        this.positions.register({
          position_id: place.position_id,
          opportunity_id: cycle.opportunity.id,
          intent_id: execution.intent_id,
          epic: this.epic,
          side: cycle.decision.side!,
          size: cycle.risk.volume,
          entry: fill,
          stop_loss: cand.stop_loss,
          take_profit: cand.take_profit,
          decision: cycle.decision,
        });
      } else if (!execution.accepted) {
        this.inflight_until_ms = 0;
      }
    } else if (cycle.decision.kind === 'BUY' || cycle.decision.kind === 'SELL') {
      execution_detail = !this.running
        ? 'runtime_stopped'
        : inflight
          ? this.positions.count() > 0
            ? 'one_trade_open'
            : 'inflight_order'
          : !cycle.risk.allowed
            ? `risk:${cycle.risk.reasons.join(',')}`
            : this.cfg.mode === 'LIVE' && !allow_live
              ? 'live_gate_off'
              : 'not_armed';
      this.last_execution_detail = execution_detail;
    }

    this.account.open_positions = this.positions.count();
    void saveOpenPositions(this.positions.list());
    if (this.seenIntentSnapshot.length) {
      void saveSeenIntents(this.seenIntentSnapshot);
    }

    return {
      decision: cycle.decision,
      risk: cycle.risk,
      executed,
      execution_detail,
      exits: managed.closed.length,
      exit_reasons,
    };
  }

  /** Restart recovery — reload open positions + seen intents from DB, reconcile broker. */
  async recover(): Promise<{ positions: number; intents: number }> {
    const loaded = await loadOpenPositions();
    const valid = loaded.filter((p) => p.decision && p.position_id);
    this.positions.fromJSON(valid);

    const intents = await loadSeenIntents();
    for (const id of intents) this.pipeline.claimIntent(id);
    this.seenIntentSnapshot = [...intents];

    if (this.broker) {
      const sync = await syncPositionsWithBroker(this.positions, this.broker, this.epic);
      void sync;
    }

    this.account.open_positions = this.positions.count();
    this.recovered = true;
    return { positions: this.positions.count(), intents: intents.length };
  }

  async start(opts?: { interval_ms?: number; broker?: MasterBroker }) {
    if (opts?.broker) this.attachBroker(opts.broker);
    else if (!this.broker) this.ensurePaperBroker();
    if (this.broker) await this.broker.connect();
    await this.recover();
    this.running = true;
    const ms = opts?.interval_ms ?? 0;
    if (ms > 0 && !this.timer) {
      this.timer = setInterval(() => {
        if (!this.running || !this.last_bars.length || !this.last_quote) return;
        void this.tick(this.last_bars, this.last_quote);
      }, ms);
    }
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    void saveOpenPositions(this.positions.list());
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
      broker: this.broker?.name ?? null,
      last_decision: this.last_decision,
      last_risk: this.last_risk,
      last_block_reason:
        this.last_decision?.block_reason ||
        this.last_risk?.reasons.join(',') ||
        null,
      last_execution_detail: this.last_execution_detail,
      last_exit_reason: this.last_exit_reason,
      buy_score: this.last_decision?.buy?.score ?? 0,
      sell_score: this.last_decision?.sell?.score ?? 0,
      regime: this.last_decision?.analysis.regime ?? 'UNKNOWN',
      market_state: this.last_decision?.analysis.market_state ?? '—',
      account: this.account,
      open_positions: this.positions.count(),
      performance: perf,
      monte_carlo: pnls.length ? monteCarlo(pnls, 200) : null,
      opportunities: this.pipeline.journal.opportunities.length,
      traded: this.pipeline.journal.traded().length,
      blocked: this.pipeline.journal.blocked().length,
      health: this.cfg.kill_switch
        ? 'KILL_SWITCH'
        : this.cfg.mode === 'LIVE'
          ? this.running
            ? 'LIVE_RUNNING'
            : 'LIVE_ARMED'
          : this.running
            ? 'PAPER_RUNNING'
            : 'OK',
      recovered: this.recovered,
    };
  }
}

export const masterRuntime = new MasterRuntime();
