/** MASTER runtime — full PAPER/LIVE cycle owner + dashboard facade. */
import type { MasterBroker } from './broker.js';
import { PaperBroker } from './broker.js';
import { decide } from './decision.js';
import { executeDecision } from './execution.js';
import {
  loadJournalHistory,
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
  specForEpic,
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
  epic: string;
  ai_mode: MasterConfig['ai_mode'];
  owns_pipeline: boolean;
  broker: string | null;
  broker_detail: string | null;
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
  persist_ok: boolean;
  last_persist_error: string | null;
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
    daily_pnl_day: null,
    day_start_equity: 10_000,
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
  persist_ok = true;
  last_persist_error: string | null = null;
  /** VS-System- style: block new entries while an order is in-flight without a position yet. */
  private inflight_until_ms = 0;
  /** VS-System-: cool down after broker reject (e.g. RISK_CHECK). */
  private reject_until_ms = 0;
  broker_detail: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private liveFeedTimer: ReturnType<typeof setInterval> | null = null;
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

  /** Roll daily_pnl at UTC day boundary; seed day_start_equity for max_daily_loss. */
  private rollDailyPnl(nowMs = Date.now()) {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (this.account.daily_pnl_day !== day) {
      this.account.daily_pnl = 0;
      this.account.daily_pnl_day = day;
      this.account.day_start_equity = this.account.equity > 0 ? this.account.equity : this.account.balance;
    }
  }

  /** Journal stubs for broker orphans + synthetic flat for local ghosts after sync. */
  private applySyncJournal(sync: Awaited<ReturnType<typeof syncPositionsWithBroker>>, quote?: Quote) {
    for (const ghost of sync.orphans_local) {
      const exit = quote
        ? ghost.side === 'BUY'
          ? quote.bid
          : quote.ask
        : ghost.entry;
      const pnlPts = ghost.side === 'BUY' ? exit - ghost.entry : ghost.entry - exit;
      const instrument = specForEpic(ghost.epic);
      const outcome = {
        position_id: ghost.position_id,
        side: ghost.side,
        entry: ghost.entry,
        exit,
        volume: ghost.size,
        pnl: pnlPts * ghost.size * instrument.value_per_point_per_lot,
        fees: 0,
        slippage: 0,
        mae: ghost.mae,
        mfe: ghost.mfe,
        r_multiple: 0,
        hold_ms: Date.now() - new Date(ghost.entry_at).getTime(),
        exit_reason: 'broker_flat',
      };
      const exists = this.pipeline.journal.opportunities.some((o) => o.id === ghost.opportunity_id);
      if (!exists) {
        this.pipeline.journal.recordOpportunity({
          id: ghost.opportunity_id,
          mode: this.cfg.mode,
          epic: ghost.epic,
          decision: ghost.decision,
          risk: {
            allowed: true,
            volume: ghost.size,
            risk_amount: 0,
            reasons: ['broker_flat'],
          },
          executed: true,
          execution: {
            accepted: true,
            intent_id: ghost.intent_id,
            order_id: null,
            fill_price: ghost.entry,
            detail: 'broker_flat',
            paper: this.broker?.paper ?? true,
          },
        });
      }
      this.pipeline.recordTradeClose(ghost.opportunity_id, ghost.decision, outcome);
      this.account.daily_pnl += outcome.pnl;
      this.trackPersist(
        'outcome',
        persistOutcome(ghost.opportunity_id, outcome, null)
      );
    }
    for (const orphan of sync.orphans_broker) {
      const pos = this.positions.get(orphan.position_id);
      if (!pos) continue;
      const exists = this.pipeline.journal.opportunities.some((o) => o.id === pos.opportunity_id);
      if (exists) continue;
      this.pipeline.journal.recordOpportunity({
        id: pos.opportunity_id,
        mode: this.cfg.mode,
        epic: pos.epic,
        decision: pos.decision,
        risk: {
          allowed: true,
          volume: pos.size,
          risk_amount: 0,
          reasons: ['recover_orphan'],
        },
        executed: true,
        execution: {
          accepted: true,
          intent_id: pos.intent_id,
          order_id: null,
          fill_price: pos.entry,
          detail: 'recover_orphan',
          paper: this.broker?.paper ?? true,
        },
      });
    }
  }

  /** Track persist Promise<boolean> results for dashboard health. */
  private trackPersist(label: string, p: Promise<boolean>) {
    void p.then((ok) => {
      if (ok) {
        this.persist_ok = true;
        this.last_persist_error = null;
      } else {
        this.persist_ok = false;
        this.last_persist_error = `${label}:failed`;
      }
    }).catch((err) => {
      this.persist_ok = false;
      this.last_persist_error = `${label}:${err instanceof Error ? err.message : String(err)}`;
    });
  }

  /** Attach broker — PAPER uses in-memory PaperBroker by default. */
  attachBroker(broker: MasterBroker) {
    this.broker = broker;
  }

  ensurePaperBroker(): PaperBroker {
    this.broker = this.paperBroker;
    return this.paperBroker;
  }

  /** Pure evaluation for dashboard — does not send orders (same cycle as tick, no execute). */
  async evaluate(bars: Bar[], quote: Quote) {
    this.last_bars = bars;
    this.last_quote = quote;
    const instrument = specForEpic(this.epic);
    const cycle = await this.pipeline.runCycle({
      bars,
      quote,
      account: {
        ...this.account,
        open_positions: this.positions.count(),
      },
      instrument,
      cfg: this.cfg,
      symbol_open: this.positions.countForEpic(this.epic),
      last_loss_ms: this.last_loss_ms,
    });
    this.last_decision = cycle.decision;
    this.last_risk = cycle.risk;
    this.trackPersist('opportunity', persistOpportunity(cycle.opportunity));
    return {
      decision: cycle.decision,
      risk: cycle.risk,
      analysis: cycle.decision.analysis,
      opportunity: cycle.opportunity,
      ai: cycle.ai,
    };
  }

  /**
   * One authoritative cycle:
   * MARKET → … → DECISION → RISK → EXECUTION → POSITION MANAGE → JOURNAL
   */
  async tick(bars: Bar[], quote: Quote): Promise<TickResult> {
    this.last_bars = bars;
    this.last_quote = quote;
    this.rollDailyPnl();
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
    }

    // Refresh equity from whatever broker is attached (paper or Capital)
    const acct = await broker.getAccount();
    if (acct && acct.equity > 0) {
      this.account.equity = acct.equity;
      this.account.balance = acct.balance;
      this.account.currency = acct.currency;
      this.account.peak_equity = Math.max(this.account.peak_equity, acct.equity);
      if (!this.account.day_start_equity) {
        this.account.day_start_equity = acct.equity;
      }
    }

    // 0) Reconcile broker truth every tick — drop ghosts, adopt orphans (VS-System-)
    const sync = await syncPositionsWithBroker(this.positions, broker, this.epic);
    if (!sync.skipped) this.applySyncJournal(sync, quote);

    this.account.open_positions = this.positions.count();
    const instrument = specForEpic(this.epic);

    // 1) Manage exits first (position manager owns open risk)
    const managed = await this.positions.manageTick({
      broker,
      pipeline: this.pipeline,
      quote,
      instrument_point_value: instrument.value_per_point_per_lot,
      max_hold_ms: this.cfg.max_hold_ms,
      breakeven_progress: this.cfg.breakeven_progress,
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
      this.trackPersist(
        'outcome',
        persistOutcome(c.position.opportunity_id, c.outcome, sk)
      );
    }

    // 2) Decision + risk
    const cycle = await this.pipeline.runCycle({
      bars,
      quote,
      account: {
        ...this.account,
        open_positions: this.positions.count(),
      },
      instrument,
      cfg: this.cfg,
      symbol_open: this.positions.countForEpic(this.epic),
      last_loss_ms: this.last_loss_ms,
    });
    this.last_decision = cycle.decision;
    this.last_risk = cycle.risk;
    this.trackPersist('opportunity', persistOpportunity(cycle.opportunity));

    // 3) Execution gate
    const allow_live =
      this.cfg.mode === 'LIVE' && process.env.MASTER_LIVE_ENABLED === 'true';
    let executed = false;
    let execution_detail: string | null = null;

    const inflight =
      Date.now() < this.inflight_until_ms || this.positions.count() > 0;
    const rejectCool = Date.now() < this.reject_until_ms;
    if (
      this.running &&
      (this.cfg.mode === 'PAPER' || allow_live) &&
      (cycle.decision.kind === 'BUY' || cycle.decision.kind === 'SELL') &&
      cycle.risk.allowed &&
      !inflight &&
      !rejectCool
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
      this.trackPersist(
        'opportunity_exec',
        persistOpportunity({
          ...cycle.opportunity,
          executed: execution.accepted,
          execution,
        })
      );

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
          size: place.fill_size ?? cycle.risk.volume,
          entry: fill,
          stop_loss: cand.stop_loss,
          take_profit: cand.take_profit,
          decision: cycle.decision,
        });
      } else if (!execution.accepted) {
        this.inflight_until_ms = 0;
        if (/reject|RISK_CHECK|not_confirmed|CAPITAL_SL|unconfirmed/i.test(execution.detail)) {
          const { capitalModifyRejectBackoffMs } = await import('./capitalConfirm.js');
          this.reject_until_ms = Date.now() + capitalModifyRejectBackoffMs(execution.detail);
        }
      }
    } else if (cycle.decision.kind === 'BUY' || cycle.decision.kind === 'SELL') {
      execution_detail = !this.running
        ? 'runtime_stopped'
        : rejectCool
          ? 'reject_cooldown'
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
    this.trackPersist('open_positions', saveOpenPositions(this.positions.list()));
    if (this.seenIntentSnapshot.length) {
      this.trackPersist('seen_intents', saveSeenIntents(this.seenIntentSnapshot));
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

  /** Restart recovery — reload positions, intents, journal, expectancy; reconcile broker. */
  async recover(): Promise<{
    positions: number;
    intents: number;
    opportunities: number;
    outcomes: number;
  }> {
    const loaded = await loadOpenPositions();
    const valid = loaded.filter((p) => p.decision && p.position_id);
    this.positions.fromJSON(valid);

    const intents = await loadSeenIntents();
    for (const id of intents) this.pipeline.claimIntent(id);
    this.seenIntentSnapshot = [...intents];

    const hist = await loadJournalHistory();
    this.pipeline.journal.hydrate(hist.opportunities);
    this.pipeline.expectancy.hydrate(
      hist.outcomes.map((o) => ({
        setup_key: o.setup_key || 'unknown',
        outcome: o.outcome,
      }))
    );
    // Recompute account daily/peak from recovered outcomes (today only for daily_pnl)
    this.rollDailyPnl();
    const today = this.account.daily_pnl_day!;
    let pnlToday = 0;
    let losses = 0;
    let pnlAll = 0;
    for (const o of hist.outcomes) {
      pnlAll += o.outcome.pnl;
      const day = String(o.created_at || '').slice(0, 10);
      if (!day || day === today) pnlToday += o.outcome.pnl;
      if (o.outcome.pnl < 0) losses += 1;
      else losses = 0;
    }
    this.account.daily_pnl = pnlToday;
    this.account.consecutive_losses = losses;
    this.account.day_start_equity =
      this.account.day_start_equity || this.account.balance;
    this.account.equity = this.account.balance + pnlAll;
    if (this.account.equity > this.account.peak_equity) {
      this.account.peak_equity = this.account.equity;
    }

    if (this.broker) {
      const sync = await syncPositionsWithBroker(this.positions, this.broker, this.epic);
      if (!sync.skipped) this.applySyncJournal(sync);
    }

    this.account.open_positions = this.positions.count();
    this.recovered = true;
    return {
      positions: this.positions.count(),
      intents: intents.length,
      opportunities: hist.opportunities.length,
      outcomes: hist.outcomes.length,
    };
  }

  async start(opts?: { interval_ms?: number; broker?: MasterBroker; live_feed?: boolean }) {
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
    const wantFeed =
      opts?.live_feed === true || process.env.MASTER_AUTO_LIVE_FEED === 'true';
    if (wantFeed) await this.startPublicLiveFeed();
  }

  /** Attach public internet quote loop so /api/master/start trades without a separate script. */
  async startPublicLiveFeed(pollMs = 2500) {
    if (this.liveFeedTimer) return;
    const { fetchLiveMarket, LiveBarBuilder } = await import('./liveFeed.js');
    const builder = new LiveBarBuilder(10_000, 80);
    let seeded = false;
    let busy = false;

    const cycle = async () => {
      if (!this.running || busy) return;
      busy = true;
      try {
        const snap = await fetchLiveMarket(this.epic);
        if (!snap.ok || !snap.quote) return;
        if (!seeded) {
          const seedDetail = await builder.seedFromPublic(this.epic, snap.quote.mid, 50);
          seeded = true;
          this.broker_detail = `${this.broker_detail || this.broker?.name || 'paper'};live_feed:${snap.detail};seed:${seedDetail}`;
        } else {
          const refreshed = await builder.refreshStructureIfStale(
            this.epic,
            snap.quote.mid,
            120_000
          );
          if (refreshed) {
            this.broker_detail = `${this.broker_detail || ''};${refreshed}`.slice(-400);
          }
        }
        const { bars } = builder.pushTick(snap.quote.mid);
        if (bars.length < 5) return;
        await this.tick(bars, snap.quote);
      } finally {
        busy = false;
      }
    };

    // Seed+first tick before interval so overlapping polls cannot race empty bars
    await cycle();
    this.liveFeedTimer = setInterval(() => {
      void cycle();
    }, pollMs);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.liveFeedTimer) {
      clearInterval(this.liveFeedTimer);
      this.liveFeedTimer = null;
    }
    this.trackPersist('open_positions', saveOpenPositions(this.positions.list()));
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
      epic: this.epic,
      ai_mode: this.cfg.ai_mode,
      owns_pipeline: process.env.MASTER_OWNS_PIPELINE === 'true',
      broker: this.broker?.name ?? null,
      broker_detail: this.broker_detail,
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
        : !this.persist_ok
          ? 'PERSIST_DEGRADED'
          : this.cfg.mode === 'LIVE'
            ? this.running
              ? 'LIVE_RUNNING'
              : 'LIVE_ARMED'
            : this.running
              ? 'PAPER_RUNNING'
              : 'OK',
      recovered: this.recovered,
      persist_ok: this.persist_ok,
      last_persist_error: this.last_persist_error,
    };
  }
}

export const masterRuntime = new MasterRuntime();
