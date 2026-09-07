/** MASTER runtime — full PAPER/LIVE cycle owner + dashboard facade. */
import { analyzeBars } from './analysis.js';
import type { MasterBroker } from './broker.js';
import { CapitalBroker, Mt4FileBroker, PaperBroker } from './broker.js';
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
import {
  syncPositionsWithBroker,
  type EmptyBrokerDebounce,
} from './positionSync.js';
import {
  DEFAULT_MASTER_CONFIG,
  GOLD_SPEC,
  MasterPipeline,
  specForEpic,
} from './pipeline.js';
import { computePerformance, monteCarlo } from './performance.js';
import {
  floatingUnrealizedPnl,
  PositionManager,
  protectiveMark,
  stableRecoverUuid,
  type ManagedPosition,
} from './positionManager.js';
import { evaluateRisk } from './risk.js';
import { setupKey } from './decision.js';
import { loadRuntimeGates, saveRuntimeGates } from './runtimeGates.js';
import { loadOwnsPipelinePref, saveOwnsPipelinePref } from './ownsPipelinePref.js';
import { resolveNewsWindow, type NewsWindowState } from './newsGate.js';
import { refreshNewsCalendar } from './newsCalendar.js';
import { SpreadHistory } from './spreadModel.js';
import {
  applyManageConfigPatch,
  loadManageConfig,
  pickManageConfig,
  saveManageConfig,
  SCALP_MANAGE_PRESET,
  type ManageConfigPatch,
} from './manageConfig.js';
import type {
  AccountSnapshot,
  Bar,
  MasterConfig,
  Mode,
  Quote,
  TradeOutcome,
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
  /** Live quote snapshot for dashboard freshness */
  quote: {
    mid: number;
    bid: number;
    ask: number;
    spread: number;
    age_ms: number;
    stream_healthy: boolean | null;
  } | null;
  floating_pnl: number;
  manage: ManageConfigPatch;
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
  /**
   * Last AI allow_close from pipeline cycle — soft exits on next manageTick.
   * Defaults true (AI off / unknown).
   */
  last_ai_allow_close = true;
  /** null = follow MASTER_OWNS_PIPELINE env; else dashboard override */
  owns_pipeline_pref: boolean | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private liveFeedTimer: ReturnType<typeof setInterval> | null = null;
  private seenIntentSnapshot: string[] = [];
  /** Serialize tick() across live-feed / API / desk so opens+persist never race. */
  private tickChain: Promise<unknown> = Promise.resolve();
  /** Reader relative-spread rolling history */
  private spreadLookback = DEFAULT_MASTER_CONFIG.spread_lookback_bars;
  private spreadHistory = new SpreadHistory(this.spreadLookback);
  /** VS-System: 5 consecutive empty successful lists before ghost wipe */
  private emptyBrokerDebounce: EmptyBrokerDebounce = { consecutive_empty: 0 };
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

  /** Apply + persist manage/exit knobs (dashboard / operator). */
  patchManageConfig(patch: ManageConfigPatch): MasterConfig {
    this.cfg = applyManageConfigPatch(this.cfg, patch);
    saveManageConfig(pickManageConfig(this.cfg));
    return this.cfg;
  }

  /** VS-System SCALPING manage preset — chase + soft trail + money BE + multi-TP. */
  armScalpManagePreset(): MasterConfig {
    return this.patchManageConfig(SCALP_MANAGE_PRESET);
  }

  /** Hydrate manage knobs from disk after restart. */
  hydrateManageConfig() {
    const saved = loadManageConfig();
    if (saved) this.cfg = applyManageConfigPatch(this.cfg, saved);
  }

  /** Positions enriched with live UPL for dashboard. */
  positionsForApi(): Array<
    ManagedPosition & { upl: number; mark: number | null }
  > {
    const quote = this.last_quote;
    const pv = specForEpic(this.epic).value_per_point_per_lot;
    return this.positions.list().map((p) => {
      if (!quote) return { ...p, upl: 0, mark: null };
      const mark = protectiveMark(p.side, quote);
      const pts = p.side === 'BUY' ? mark - p.entry : p.entry - mark;
      return { ...p, upl: pts * p.size * pv, mark };
    });
  }

  /**
   * Operator close — bypass soft close_requires_sl for emergency flatten.
   * Still journals outcome against opportunity when present.
   */
  async closePositionManual(
    positionId: string,
    reason = 'OPERATOR_CLOSE'
  ): Promise<{ ok: boolean; detail: string; pnl?: number }> {
    const broker = this.broker;
    if (!broker) return { ok: false, detail: 'no_broker' };
    const pos = this.positions.get(positionId);
    if (!pos) return { ok: false, detail: 'not_found' };
    const quote = this.last_quote || {
      bid: pos.entry,
      ask: pos.entry,
      mid: pos.entry,
      spread: 0,
      ts_ms: Date.now(),
    };
    const mark = protectiveMark(pos.side, quote);
    const closeRes = await broker.closePosition(positionId);
    if (!closeRes.ok) {
      return { ok: false, detail: closeRes.detail || 'close_failed' };
    }
    const fill =
      closeRes.fill_price != null && Number.isFinite(closeRes.fill_price)
        ? Number(closeRes.fill_price)
        : mark;
    const instrument = specForEpic(pos.epic);
    const pnlPts = pos.side === 'BUY' ? fill - pos.entry : pos.entry - fill;
    const pnl = pnlPts * pos.size * instrument.value_per_point_per_lot;
    const heldMs = Date.now() - new Date(pos.entry_at).getTime();
    const riskDist = Math.max(
      Math.abs((pos.stop_loss ?? pos.entry) - pos.entry),
      Number.EPSILON
    );
    const outcome: TradeOutcome = {
      position_id: pos.position_id,
      side: pos.side,
      entry: pos.entry,
      exit: fill,
      volume: pos.size,
      pnl,
      fees: 0,
      slippage: Math.abs(fill - quote.mid),
      mae: pos.mae,
      mfe: pos.mfe,
      r_multiple: pnlPts / riskDist,
      hold_ms: heldMs,
      exit_reason: reason,
    };
    this.pipeline.recordTradeClose(pos.opportunity_id, pos.decision, outcome, {
      epic: pos.epic,
    });
    this.positions.drop(positionId);
    this.account.daily_pnl += pnl;
    if (pnl < 0) {
      this.account.consecutive_losses += 1;
      this.last_loss_ms = Date.now();
    } else {
      this.account.consecutive_losses = 0;
    }
    this.last_exit_reason = reason;
    this.trackPersist('outcome', persistOutcome(pos.opportunity_id, outcome, null));
    this.trackPersist('open_positions', saveOpenPositions(this.positions.list()));
    return { ok: true, detail: reason, pnl };
  }

  async flattenAll(reason = 'OPERATOR_FLATTEN'): Promise<{
    ok: boolean;
    closed: number;
    failed: string[];
  }> {
    const ids = this.positions.list().map((p) => p.position_id);
    const failed: string[] = [];
    let closed = 0;
    for (const id of ids) {
      const r = await this.closePositionManual(id, reason);
      if (r.ok) closed += 1;
      else failed.push(`${id}:${r.detail}`);
    }
    return { ok: failed.length === 0, closed, failed };
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
    // Reader EXTERNAL_PARTIAL_CLOSE — journal closed slice when broker size shrinks
    for (const partial of sync.external_partials || []) {
      const instrument = specForEpic(partial.epic);
      const exit = quote
        ? partial.side === 'BUY'
          ? quote.bid
          : quote.ask
        : partial.mark_proxy;
      const pnlPts =
        partial.side === 'BUY' ? exit - partial.entry : partial.entry - exit;
      const outcome = {
        position_id: partial.position_id,
        side: partial.side,
        entry: partial.entry,
        exit,
        volume: partial.closed_size,
        pnl: pnlPts * partial.closed_size * instrument.value_per_point_per_lot,
        fees: 0,
        slippage: 0,
        mae: partial.mae,
        mfe: partial.mfe,
        r_multiple: 0,
        hold_ms: 0,
        exit_reason: 'EXTERNAL_PARTIAL_CLOSE',
      };
      const exists = this.pipeline.journal.opportunities.some(
        (o) => o.id === partial.opportunity_id
      );
      if (!exists) {
        this.pipeline.journal.recordOpportunity({
          id: partial.opportunity_id,
          mode: this.cfg.mode,
          epic: partial.epic,
          decision: partial.decision,
          risk: {
            allowed: true,
            volume: partial.closed_size + partial.remaining_size,
            risk_amount: 0,
            reasons: ['external_partial'],
          },
          executed: true,
          execution: {
            accepted: true,
            intent_id: partial.intent_id,
            order_id: null,
            fill_price: partial.entry,
            detail: 'external_partial',
            paper: this.broker?.paper ?? true,
          },
        });
      }
      this.pipeline.recordTradeClose(partial.opportunity_id, partial.decision, outcome, {
        epic: partial.epic,
      });
      this.account.daily_pnl += outcome.pnl;
      this.trackPersist(
        'external_partial',
        persistOutcome(partial.opportunity_id, outcome, null)
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
    this.last_ai_allow_close = cycle.ai.allow_close !== false;
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

  private async tickUnlocked(bars: Bar[], quoteIn: Quote): Promise<TickResult> {
    // Always stamp runtime epic — public/desk quotes often omit it (news targeting).
    const quote: Quote = { ...quoteIn, epic: quoteIn.epic || this.epic };
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
      if (typeof acct.trade_allowed === 'boolean') {
        this.account.trade_allowed = acct.trade_allowed;
      }
      this.account.peak_equity = Math.max(this.account.peak_equity, acct.equity);
      if (!this.account.day_start_equity) {
        this.account.day_start_equity = acct.equity;
      }
    }

    // Reader relative spread — update history every tick
    if (this.cfg.spread_lookback_bars !== this.spreadLookback) {
      this.spreadLookback = this.cfg.spread_lookback_bars;
      this.spreadHistory = new SpreadHistory(this.spreadLookback);
    }
    const spreadSnap = this.spreadHistory.push(quote.spread);

    // Refresh Forex Factory news calendar cache (VS-System) before entry filters
    await refreshNewsCalendar().catch(() => undefined);

    // 0) Reconcile broker truth every tick — drop ghosts, adopt orphans (VS-System-)
    // Empty-book ghost wipe requires 5 consecutive successful empties (debounce).
    const sync = await syncPositionsWithBroker(
      this.positions,
      broker,
      this.epic,
      this.emptyBrokerDebounce
    );
    if (!sync.skipped && !sync.ghost_drop_deferred) {
      this.applySyncJournal(sync, quote);
    }

    this.account.open_positions = this.positions.count();
    const instrument = specForEpic(this.epic);

    // Structure for Reader swing trail (from current bars — before entry cycle)
    const structure = bars.length >= 5 ? analyzeBars(bars, quote.spread) : null;
    const trailBuf =
      structure && structure.atr > 0
        ? structure.atr * this.cfg.trailing_buffer_atr_mult
        : 0;

    // 1) Manage exits first (position manager owns open risk)
    const liveMinStop =
      broker instanceof CapitalBroker
        ? broker.liveMinStopDistance(this.epic)
        : quote.min_stop_distance ?? null;
    const managed = await this.positions.manageTick({
      broker,
      pipeline: this.pipeline,
      quote,
      instrument_point_value: instrument.value_per_point_per_lot,
      max_hold_ms: this.cfg.max_hold_ms,
      breakeven_progress: this.cfg.breakeven_progress,
      breakeven_offset: this.cfg.breakeven_offset,
      be_start: this.cfg.be_start,
      trail_start: this.cfg.trail_start,
      trail_lock: this.cfg.trail_lock,
      partial_close_progress: this.cfg.partial_close_progress,
      partial_close_volume: this.cfg.partial_close_volume,
      volume_step: instrument.volume_step,
      swing_low: structure?.swing_low ?? null,
      swing_high: structure?.swing_high ?? null,
      trailing_buffer: trailBuf,
      allow_close:
        this.cfg.ai_mode === 'off' ? true : this.last_ai_allow_close,
      close_all_profit: this.cfg.close_all_profit,
      close_all_loss: this.cfg.close_all_loss,
      min_stop_distance: liveMinStop,
      breakeven_activation_money: this.cfg.breakeven_activation_money,
      soft_trail_money_arm: this.cfg.soft_trail_money_arm,
      soft_trail_pips: this.cfg.soft_trail_pips,
      scalp_pct_chase: this.cfg.scalp_pct_chase,
      scalp_lock_pct: this.cfg.scalp_lock_pct,
      stale_quote_ms: this.cfg.stale_quote_ms,
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
      relative_spread:
        spreadSnap.history.length >= 3 ? spreadSnap.relative_spread : null,
    });
    this.last_decision = cycle.decision;
    this.last_risk = cycle.risk;
    this.last_ai_allow_close = cycle.ai.allow_close !== false;
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
      // VS-System fail-closed: force-list broker opens before entry — local book
      // alone is unsafe when sync was skipped or ghosts lag.
      let brokerVerifyOk = true;
      try {
        const listed = await broker.listOpenPositions(this.epic);
        if (!listed.ok) {
          brokerVerifyOk = false;
          execution_detail = `broker_verify_failed:${listed.detail || 'list_failed'}`;
          this.last_execution_detail = execution_detail;
        } else if (listed.positions.length > 0) {
          brokerVerifyOk = false;
          execution_detail = `one_trade_broker_open:${listed.positions.length}`;
          this.last_execution_detail = execution_detail;
        }
      } catch (err) {
        brokerVerifyOk = false;
        execution_detail = `broker_verify_failed:${err instanceof Error ? err.message : 'list_threw'}`;
        this.last_execution_detail = execution_detail;
      }

      if (brokerVerifyOk) {
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
        let multiLevels: import('./multiTp.js').MultiTpLevel[] | undefined;
        if (this.cfg.multi_tp_count >= 2) {
          const { buildEqualMultiTpPlan } = await import('./multiTp.js');
          const atr = Math.max(
            cycle.decision.analysis?.atr ?? 0,
            Math.abs(fill) * 0.0003,
            0.5
          );
          const plan = buildEqualMultiTpPlan({
            side: cycle.decision.side!,
            entry: fill,
            initial_volume: place.fill_size ?? cycle.risk.volume,
            count: this.cfg.multi_tp_count,
            atr,
            atr_tp_mult: this.cfg.multi_tp_atr_mult,
            volume_step: instrument.volume_step,
          });
          if (plan.length >= 2) multiLevels = plan;
        }
        this.positions.register({
          position_id: place.position_id,
          opportunity_id: cycle.opportunity.id,
          intent_id: execution.intent_id,
          epic: this.epic,
          side: cycle.decision.side!,
          size: place.fill_size ?? cycle.risk.volume,
          entry: fill,
          stop_loss: rebased.stop_loss,
          take_profit: multiLevels
            ? multiLevels[multiLevels.length - 1]!.price
            : rebased.take_profit,
          decision: cycle.decision,
          multi_tp_levels: multiLevels,
        });
        // Sync broker protection to fill-rebased geometry (local-only rebase left Capital at planned SL)
        if (
          broker.modifyPosition &&
          (rebased.stop_loss != null ||
            (multiLevels
              ? multiLevels[multiLevels.length - 1]!.price
              : rebased.take_profit) != null)
        ) {
          const mod = await broker.modifyPosition({
            position_id: place.position_id,
            stop_level: rebased.stop_loss ?? undefined,
            profit_level: multiLevels
              ? multiLevels[multiLevels.length - 1]!.price
              : rebased.take_profit ?? undefined,
          });
          if (!mod.ok) {
            this.broker_detail =
              `post_fill_sl_sync_fail:${mod.detail}`.slice(0, 400);
          }
        }
      } else if (!execution.accepted) {
        // Ambiguous OPEN ACK timeout — keep inflight so we do not double-open
        // while EA may still fill (Check- holds pending_open until ACK/timeout window).
        const ambiguousTimeout =
          /ack_timeout|ACK_TIMEOUT|not_confirmed|unconfirmed/i.test(
            execution.detail || ''
          );
        if (!ambiguousTimeout) {
          this.inflight_until_ms = 0;
        }
        if (
          /reject|RISK_CHECK|not_confirmed|CAPITAL_SL|unconfirmed|ack_timeout|ACK_TIMEOUT/i.test(
            execution.detail
          )
        ) {
          const { capitalModifyRejectBackoffMs } = await import('./capitalConfirm.js');
          const backoff = ambiguousTimeout
            ? Math.max(30_000, capitalModifyRejectBackoffMs(execution.detail))
            : capitalModifyRejectBackoffMs(execution.detail);
          this.reject_until_ms = Date.now() + backoff;
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
      } // brokerVerifyOk
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
    this.hydrateManageConfig();
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
      // Reader apply_ack_to_instance_state — OPEN SUCCESS before status sync
      const booked = new Set(this.positions.list().map((p) => p.position_id));
      const fromAck = this.broker.adoptOpenFromAckJournal(booked);
      for (const row of fromAck.adopted) {
        if (this.positions.get(row.ticket)) continue;
        const recoverId = stableRecoverUuid(row.ticket);
        this.positions.register({
          position_id: row.ticket,
          opportunity_id: recoverId,
          intent_id: row.intent_id || row.command_id,
          epic: row.epic || this.epic,
          side: row.side,
          size: row.volume,
          entry: row.fill_price ?? 0,
          stop_loss: row.sl,
          take_profit: row.tp,
          decision: {
            decision_id: recoverId,
            kind: row.side,
            side: row.side,
            score: 0,
            block_reason: null,
            buy: null as never,
            sell: null as never,
            analysis: {
              regime: 'UNKNOWN',
              market_state: 'ack_recover',
              momentum_score: 0,
              momentum_dir: 'NEUTRAL',
              trend_dir: 'SIDEWAYS',
              trend_strength: 0,
              structure_bias: 'NEUTRAL',
              swing_high: row.fill_price ?? 0,
              swing_low: row.fill_price ?? 0,
              buy_pressure: 0,
              sell_pressure: 0,
              behavior_bull: 0,
              behavior_bear: 0,
              impact_score: 0,
              context_quality: 0,
              volatility: 0,
              atr: 0,
              data_quality: 0.5,
              session: 'UNKNOWN',
            },
            expectancy: null,
          },
        });
      }
      if (fromAck.adopted.length) {
        this.broker_detail = [
          this.broker_detail,
          `ack_adopt:${fromAck.adopted.length}`,
        ]
          .filter(Boolean)
          .join(';');
      }
    }

    if (this.broker) {
      const sync = await syncPositionsWithBroker(
        this.positions,
        this.broker,
        this.epic,
        this.emptyBrokerDebounce
      );
      if (!sync.skipped && !sync.ghost_drop_deferred) {
        this.applySyncJournal(sync);
      }
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

    // Prefer Capital streaming when available — faster manage ticks
    if (this.broker instanceof CapitalBroker) {
      void this.broker.ensureMarketStream([this.epic]);
    }
    // Capital: poll at 1s (stream cache makes getQuote cheap when WS healthy)
    const intervalMs =
      this.broker instanceof CapitalBroker ? Math.min(pollMs, 1000) : pollMs;

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
          const streamNote =
            this.broker instanceof CapitalBroker && this.broker.isMarketStreamHealthy()
              ? 'stream:ok'
              : 'stream:rest';
          this.broker_detail = `${this.broker_detail || brokerName};broker_feed:${brokerName};seed:${seedDetail};${streamNote}`.slice(
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
          epic: q.epic || this.epic,
          ts_ms: q.ts_ms,
          min_stop_distance: q.min_stop_distance,
        });
      } finally {
        busy = false;
      }
    };

    await cycle();
    this.liveFeedTimer = setInterval(() => {
      void cycle();
    }, intervalMs);
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
    // Refuse empty overwrite before recover — otherwise Stop on a fresh
    // process wipes durable opens that recover() has not loaded yet.
    if (this.positions.count() === 0 && !this.recovered) {
      return;
    }
    this.trackPersist('open_positions', saveOpenPositions(this.positions.list()));
  }

  status(): MasterStatus {
    const perf = computePerformance(this.pipeline.journal.traded());
    const pnls = this.pipeline.journal
      .traded()
      .map((t) => t.outcome!.pnl);
    const quote = this.last_quote;
    const pv = specForEpic(this.epic).value_per_point_per_lot;
    const floating = quote
      ? floatingUnrealizedPnl(this.positions.list(), quote, pv)
      : 0;
    const streamHealthy =
      this.broker instanceof CapitalBroker
        ? this.broker.isMarketStreamHealthy()
        : null;
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
      news_window: resolveNewsWindow(Date.now(), this.epic),
      quote: quote
        ? {
            mid: quote.mid,
            bid: quote.bid,
            ask: quote.ask,
            spread: quote.spread,
            age_ms: Math.max(0, Date.now() - (quote.ts_ms || 0)),
            stream_healthy: streamHealthy,
          }
        : null,
      floating_pnl: floating,
      manage: pickManageConfig(this.cfg),
    };
  }
}

export const masterRuntime = new MasterRuntime();
