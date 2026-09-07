/** MASTER runtime — full PAPER/LIVE cycle owner + dashboard facade. */
import { analyzeBars } from './analysis.js';
import type { MasterBroker } from './broker.js';
import { Mt4FileBroker, PaperBroker } from './broker.js';
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
import { loadRuntimeGates, saveRuntimeGates } from './runtimeGates.js';
import { loadOwnsPipelinePref, saveOwnsPipelinePref } from './ownsPipelinePref.js';
import { resolveNewsWindow, type NewsWindowState } from './newsGate.js';
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
  entries_armed: boolean;
  entries_pause_reason: string | null;
  news_window: NewsWindowState;
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
  /** When false, manage exits still run but new entries are blocked (desk dual-brain guard). */
  entries_armed = true;
  entries_pause_reason: string | null = null;
  /** null = follow MASTER_OWNS_PIPELINE env; else dashboard override */
  owns_pipeline_pref: boolean | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private liveFeedTimer: ReturnType<typeof setInterval> | null = null;
  private seenIntentSnapshot: string[] = [];
  /** Serialize tick() across live-feed / API / desk so opens+persist never race. */
  private tickChain: Promise<unknown> = Promise.resolve();
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

  /** Desk single-owner toggle — persists preference for restart. */
  setOwnsPipeline(on: boolean) {
    this.owns_pipeline_pref = on;
    saveOwnsPipelinePref(on);
  }

  ownsPipelineEffective(): boolean {
    if (this.owns_pipeline_pref != null) return this.owns_pipeline_pref;
    return process.env.MASTER_OWNS_PIPELINE === 'true';
  }

  hydrateOwnsPipelinePref() {
    const pref = loadOwnsPipelinePref();
    if (pref != null) this.owns_pipeline_pref = pref;
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
      this.pipeline.recordTradeClose(ghost.opportunity_id, ghost.decision, outcome, {
        epic: ghost.epic,
      });
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
      const stub = this.pipeline.journal.recordOpportunity({
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
      this.trackPersist('recover_orphan', persistOpportunity(stub));
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

  /**
   * Desk dual-brain guard: when Capital LIVE manage is deferred to desk,
   * pause MASTER autonomous entries while exits still run.
   */
  setEntriesArmed(armed: boolean, reason?: string) {
    this.entries_armed = armed;
    this.entries_pause_reason = armed ? null : reason || 'entries_paused';
    if (!armed) {
      this.broker_detail = `${this.broker_detail || ''};entries_paused:${this.entries_pause_reason}`.slice(
        -400
      );
    }
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
   * Serialized — concurrent callers share one chain (live feed + /tick + desk).
   */
  async tick(bars: Bar[], quote: Quote): Promise<TickResult> {
    const run = () => this.tickUnlocked(bars, quote);
    const result = this.tickChain.then(run, run);
    this.tickChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async tickUnlocked(bars: Bar[], quote: Quote): Promise<TickResult> {
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
      this.account.available_to_deal =
        acct.available != null && Number.isFinite(acct.available)
          ? acct.available
          : this.account.available_to_deal ?? null;
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

    // Structure for Reader swing trail (from current bars — before entry cycle)
    const structure = bars.length >= 5 ? analyzeBars(bars, quote.spread) : null;
    const trailBuf =
      structure && structure.atr > 0
        ? structure.atr * this.cfg.trailing_buffer_atr_mult
        : 0;

    // 1) Manage exits first (position manager owns open risk)
    const managed = await this.positions.manageTick({
      broker,
      pipeline: this.pipeline,
      quote,
      instrument_point_value: instrument.value_per_point_per_lot,
      max_hold_ms: this.cfg.max_hold_ms,
      breakeven_progress: this.cfg.breakeven_progress,
      partial_close_progress: this.cfg.partial_close_progress,
      partial_close_volume: this.cfg.partial_close_volume,
      volume_step: instrument.volume_step,
      swing_low: structure?.swing_low ?? null,
      swing_high: structure?.swing_high ?? null,
      trailing_buffer: trailBuf,
    });
    const exit_reasons = managed.closed.map((c) => c.reason);
    if (exit_reasons.length) this.last_exit_reason = exit_reasons.at(-1)!;
    if (managed.close_failed.length) {
      const fail = managed.close_failed[0]!;
      this.broker_detail = `close_fail:${fail.position_id}:${fail.detail}`.slice(0, 400);
      if (!exit_reasons.length) {
        this.last_exit_reason = `CLOSE_FAIL · ${fail.exit_reason} · ${fail.detail}`;
      }
    }
    for (const c of managed.closed) {
      this.account.daily_pnl += c.outcome.pnl;
      if (c.outcome.pnl < 0) {
        this.account.consecutive_losses += 1;
        this.last_loss_ms = Date.now();
        this.trackPersist(
          'runtime_gates',
          Promise.resolve(
            saveRuntimeGates({
              last_loss_ms: this.last_loss_ms,
              reject_until_ms: this.reject_until_ms,
            })
          )
        );
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
      this.entries_armed &&
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
        const { rebaseStopsFromFill } = await import('./positionManager.js');
        const rebased = rebaseStopsFromFill(
          cand.entry,
          fill,
          cand.stop_loss,
          cand.take_profit
        );
        this.positions.register({
          position_id: place.position_id,
          opportunity_id: cycle.opportunity.id,
          intent_id: execution.intent_id,
          epic: this.epic,
          side: cycle.decision.side!,
          size: place.fill_size ?? cycle.risk.volume,
          entry: fill,
          stop_loss: rebased.stop_loss,
          take_profit: rebased.take_profit,
          decision: cycle.decision,
        });
      } else if (!execution.accepted) {
        this.inflight_until_ms = 0;
        if (/reject|RISK_CHECK|not_confirmed|CAPITAL_SL|unconfirmed/i.test(execution.detail)) {
          const { capitalModifyRejectBackoffMs } = await import('./capitalConfirm.js');
          this.reject_until_ms = Date.now() + capitalModifyRejectBackoffMs(execution.detail);
          this.trackPersist(
            'runtime_gates',
            Promise.resolve(
              saveRuntimeGates({
                last_loss_ms: this.last_loss_ms,
                reject_until_ms: this.reject_until_ms,
              })
            )
          );
        }
      }
    } else if (cycle.decision.kind === 'BUY' || cycle.decision.kind === 'SELL') {
      execution_detail = !this.running
        ? 'runtime_stopped'
        : !this.entries_armed
          ? this.entries_pause_reason || 'entries_paused'
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
      // Only today's outcomes — never treat missing/epoch created_at as today
      if (day === today) pnlToday += o.outcome.pnl;
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

    const gates = loadRuntimeGates();
    if (gates) {
      this.last_loss_ms = Math.max(this.last_loss_ms, gates.last_loss_ms || 0);
      this.reject_until_ms = Math.max(this.reject_until_ms, gates.reject_until_ms || 0);
    }

    // PAPER restart: empty in-memory book must be reseeded before sync or every
    // restored open looks like a ghost and is wiped as broker_flat.
    if (this.broker instanceof PaperBroker) {
      this.broker.seedOpens(
        this.positions.list().map((p) => ({
          position_id: p.position_id,
          epic: p.epic,
          side: p.side,
          size: p.size,
          open_level: p.entry,
          stop_level: p.stop_loss,
          profit_level: p.take_profit,
        }))
      );
    }

    // MT4: archive acked cmds / expire stale unacked before sync (Reader recover_pending_ack)
    if (this.broker instanceof Mt4FileBroker) {
      const pending = this.broker.recoverPendingCommands();
      if (pending.applied || pending.expired || pending.still_pending) {
        this.broker_detail = [
          this.broker_detail,
          `mt4_recover:applied=${pending.applied},expired=${pending.expired},pending=${pending.still_pending}`,
        ]
          .filter(Boolean)
          .join(';');
      }
    }

    if (this.broker) {
      const sync = await syncPositionsWithBroker(this.positions, this.broker, this.epic);
      if (!sync.skipped) this.applySyncJournal(sync);
    }

    // Hydrate last exit for dashboard after restart
    if (hist.outcomes.length && !this.last_exit_reason) {
      const latest = [...hist.outcomes].sort((a, b) =>
        String(b.created_at || '').localeCompare(String(a.created_at || ''))
      )[0];
      if (latest?.outcome?.exit_reason) {
        this.last_exit_reason = latest.outcome.exit_reason;
      }
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
    const wantPublicFeed =
      opts?.live_feed === true || process.env.MASTER_AUTO_LIVE_FEED === 'true';
    if (wantPublicFeed) {
      await this.startPublicLiveFeed();
    } else if (this.broker && !this.broker.paper) {
      // LIVE Capital/MT4: poll broker quotes — do not leave runtime silent
      await this.startBrokerLiveFeed();
    }
  }

  /**
   * LIVE broker market loop — CAPITAL/MT4 getQuote → bars → tick.
   * Public Yahoo feed stays PAPER-only; marks/exits use broker bid/ask.
   */
  async startBrokerLiveFeed(pollMs = 2500) {
    if (this.liveFeedTimer) return;
    if (!this.broker || this.broker.paper) return;
    const { LiveBarBuilder } = await import('./liveFeed.js');
    const builder = new LiveBarBuilder(10_000, 80);
    let seeded = false;
    let busy = false;
    const brokerName = this.broker.name;

    const cycle = async () => {
      if (!this.running || busy || !this.broker || this.broker.paper) return;
      busy = true;
      try {
        let q: Awaited<ReturnType<MasterBroker['getQuote']>> = null;
        try {
          q = await Promise.race([
            this.broker.getQuote(this.epic),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
          ]);
        } catch {
          q = null;
        }
        if (!q) {
          // Feed miss must not freeze exits — manage on last bars/quote
          if (this.last_bars.length >= 5 && this.last_quote) {
            await this.tick(this.last_bars, {
              ...this.last_quote,
              ts_ms: Date.now(),
            });
          }
          return;
        }
        if (!seeded) {
          // Structure: Capital OHLC when broker provides it; else Yahoo; ticks from broker.
          // Vitest uses synthetic seed to avoid flaky Yahoo network in unit tests.
          let seedDetail: string;
          if (process.env.VITEST || process.env.MASTER_BROKER_FEED_SYNTHETIC === 'true') {
            builder.seedAround(q.mid, 50);
            seedDetail = 'synthetic_broker_seed';
          } else {
            let brokerHist: Awaited<ReturnType<NonNullable<MasterBroker['getHistoryBars']>>> | null =
              null;
            if (typeof this.broker.getHistoryBars === 'function') {
              try {
                brokerHist = await Promise.race([
                  this.broker.getHistoryBars(this.epic, 60),
                  new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
                ]);
              } catch {
                brokerHist = null;
              }
            }
            seedDetail = await builder.seedFromBrokerOrPublic(
              this.epic,
              q.mid,
              50,
              brokerHist
            );
          }
          seeded = true;
          this.broker_detail = `${this.broker_detail || brokerName};broker_feed:${brokerName};seed:${seedDetail}`.slice(
            -400
          );
        } else if (!process.env.VITEST) {
          let brokerHist: Awaited<ReturnType<NonNullable<MasterBroker['getHistoryBars']>>> | null =
            null;
          if (typeof this.broker.getHistoryBars === 'function') {
            try {
              brokerHist = await this.broker.getHistoryBars(this.epic, 60);
            } catch {
              brokerHist = null;
            }
          }
          const refreshed = await builder.refreshStructureIfStale(
            this.epic,
            q.mid,
            120_000,
            brokerHist
          );
          if (refreshed) {
            this.broker_detail = `${this.broker_detail || ''};${refreshed}`.slice(-400);
          }
        }
        const { bars } = builder.pushTick(q.mid);
        if (bars.length < 5) return;
        await this.tick(bars, {
          bid: q.bid,
          ask: q.ask,
          mid: q.mid,
          spread: q.spread,
          ts_ms: q.ts_ms,
        });
      } finally {
        busy = false;
      }
    };

    await cycle();
    this.liveFeedTimer = setInterval(() => {
      void cycle();
    }, pollMs);
  }

  /** Attach public internet quote loop so /api/master/start trades without a separate script. */
  async startPublicLiveFeed(pollMs = 2500) {
    if (this.liveFeedTimer) return;
    const { fetchLiveMarket, LiveBarBuilder } = await import('./liveFeed.js');
    const builder = new LiveBarBuilder(10_000, 80);
    let seeded = false;
    let busy = false;
    let lastMid: number | null = null;
    let frozenPolls = 0;

    const cycle = async () => {
      if (!this.running || busy) return;
      busy = true;
      try {
        let snap: Awaited<ReturnType<typeof fetchLiveMarket>> | null = null;
        try {
          snap = await Promise.race([
            fetchLiveMarket(this.epic),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
          ]);
        } catch {
          snap = null;
        }
        // Feed failure must not freeze exits (TIME_STOP / SL) — manage on last bars
        if (!snap?.ok || !snap.quote) {
          if (this.last_bars.length >= 5 && this.last_quote) {
            await this.tick(this.last_bars, {
              ...this.last_quote,
              ts_ms: Date.now(),
            });
          }
          return;
        }
        if (lastMid != null && Math.abs(snap.quote.mid - lastMid) < 1e-9) {
          frozenPolls += 1;
        } else {
          frozenPolls = 0;
        }
        lastMid = snap.quote.mid;
        // Frozen consensus mid (~60s): stamp quote stale so entries gate; exits still run
        const quote =
          frozenPolls >= 24
            ? { ...snap.quote, ts_ms: Date.now() - 60_000 }
            : snap.quote;
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
          if (frozenPolls >= 24 && frozenPolls % 24 === 0) {
            this.broker_detail = `${this.broker_detail || ''};frozen_mid:${frozenPolls}`.slice(
              -400
            );
          }
        }
        const { bars } = builder.pushTick(snap.quote.mid);
        if (bars.length < 5) return;
        await this.tick(bars, quote);
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
      owns_pipeline: this.ownsPipelineEffective(),
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
      entries_armed: this.entries_armed,
      entries_pause_reason: this.entries_pause_reason,
      news_window: resolveNewsWindow(),
    };
  }
}

export const masterRuntime = new MasterRuntime();
