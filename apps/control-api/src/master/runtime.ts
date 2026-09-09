/** MASTER runtime — full PAPER/LIVE cycle owner + dashboard facade. */
import {
  analyzeBars,
  emaFromBars,
  emaPairFromBars,
  emaTickLiveFromBars,
} from './analysis.js';
import type { MasterBroker } from './broker.js';
import { CapitalBroker, Mt4FileBroker, PaperBroker, capitalApiEpic, epicsMatch } from './broker.js';
import { capitalEnvPresent } from './envBroker.js';
import { decide } from './decision.js';
import { backfillDeskEntrySources } from './deskEntryHydrate.js';
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
import { computePerformance, deskSourceFromSetupKey, fromOutcomes, monteCarlo, performanceByDeskEntry } from './performance.js';
import { expectancyByDeskSource } from './expectancy.js';
import {
  entrySetupFromRegime,
  floatingUnrealizedPnl,
  mapRegimeToPlaybook,
  PositionManager,
  protectiveMark,
  quoteMatchesPosition,
  stableRecoverUuid,
  toDeskRegime,
  type ManagedPosition,
  type ManageTickResult,
} from './positionManager.js';
import { evaluateRisk } from './risk.js';
import { setupKey } from './decision.js';
import { capitalLiveEntriesAllowed } from './liveFeed.js';
import {
  capitalCloseExitReason,
  preferCloseFillPnl,
  priceResolvedCloseMoney,
  resolveCloseMoneyPnl,
  resolveCloseExitFill,
  resolveFloatingMoneyPnl,
  rMultipleFromClose,
  usableBrokerUpl,
} from './moneyExit.js';
import { loadMasterErrors, logMasterError } from './errorJournal.js';
import { CycleMonitor } from './monitoring.js';
import { logDecisionEvent, loadDecisionEvents } from './decisionJournal.js';
import { logTradeEvent, loadTradeEvents, normalizeTradeDeskSource } from './tradeEventJournal.js';
import { resolvePersistBackend } from './persistBackend.js';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  alertsBlockEntries,
  dispatchCycleAlerts,
} from './cycleAlerts.js';
import { loadRuntimeGates, saveRuntimeGates } from './runtimeGates.js';
import { loadOwnsPipelinePref, saveOwnsPipelinePref } from './ownsPipelinePref.js';
import { loadMarketCache, saveMarketCache } from './marketCache.js';
import {
  loadEpicCycleStash,
  saveEpicCycleStash,
  type EpicCycleRow,
  type EpicSetupSnap,
} from './epicCycleStash.js';
import { validateMarket } from './marketData.js';
import { newsBlocksEntries, resolveNewsWindow, type NewsWindowState } from './newsGate.js';
import { refreshNewsCalendar } from './newsCalendar.js';
import { SpreadHistory } from './spreadModel.js';
import { isWeekendUtc } from './filters.js';
import { withinTradingHours } from './tradingHours.js';
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
  MasterDecision,
  Mode,
  Quote,
  TradeOutcome,
} from './types.js';
import { buildFanoutCloseOutcome } from './masterClientFanout.js';

export type MasterStatus = {
  mode: Mode;
  running: boolean;
  kill_switch: boolean;
  epic: string;
  ai_mode: MasterConfig['ai_mode'];
  owns_pipeline: boolean;
  /** False while owns_pipeline — Market Core EntryReady HTTP is 409 */
  market_core_intents_allowed: boolean;
  /**
   * Who owns exits: MASTER | DESK_DEFERRED_HARD (owns-pipeline but Capital unsafe —
   * hard SL only) | DESK (legacy dual-brain when owns off).
   */
  manage_owner: 'MASTER' | 'DESK_DEFERRED_HARD' | 'DESK';
  broker: string | null;
  broker_detail: string | null;
  /** Primary LIVE venue — Capital.com API direct (not MT4 bridge) */
  primary_live_venue: 'capital.com_api_direct';
  /** Whether CAPITAL_* env secrets are present in this process */
  capital_env_present: boolean;
  /** True when MASTER has CAPITAL broker in LIVE mode */
  capital_live_attached: boolean;
  /** Capital venue open count (local book alone can miss orphans). */
  capital_venue_opens: number;
  /** False when last Capital list failed — do not treat venue as flat. */
  capital_venue_opens_proven: boolean;
  /**
   * True when sealed prior-day gates apply for operators: open-book mark /
   * Capital unproven (roll execution deferred), OR daily_pnl_day lags UTC today
   * (entries fail-closed — including flat paper before the next roll tick).
   */
  utc_day_roll_deferred: boolean;
  last_decision: ReturnType<typeof decide> | null;
  last_risk: ReturnType<typeof evaluateRisk> | null;
  last_block_reason: string | null;
  last_execution_detail: string | null;
  last_exit_reason: string | null;
  /** MASTER-owns Client fanout after last accepted OPEN (multi-account). */
  last_client_fanout: {
    attempted: boolean;
    subscribers: number;
    ok_count: number;
    fail_count: number;
    detail: string;
    journaled_count?: number;
  } | null;
  /** Last manage close failure (broker refused / AI veto) — dashboard honesty */
  last_close_failed: {
    position_id: string;
    exit_reason: string;
    detail: string;
    ts: string;
  } | null;
  /** Soft-exit AI gate — false means soft exits vetoed until cycle proves allow */
  last_ai_allow_close: boolean;
  buy_score: number;
  sell_score: number;
  /** Dual-candidate filter stage — dashboard must show BUY/SELL gate, not scores alone */
  buy_filter: {
    ok: boolean;
    reason: string | null;
    score: number;
    valid: boolean;
  } | null;
  sell_filter: {
    ok: boolean;
    reason: string | null;
    score: number;
    valid: boolean;
  } | null;
  /**
   * Authoritative stage map for dashboard — one card per pipeline stage.
   * Derived from last cycle (never forged).
   */
  pipeline_stages: {
    market_validation: { ok: boolean; detail: string };
    normalization: { ok: boolean; detail: string };
    analysis_regime: { ok: boolean; detail: string };
    dual_candidates: { ok: boolean; detail: string };
    filters: { ok: boolean; detail: string };
    decision: { ok: boolean; detail: string };
    risk: { ok: boolean; detail: string };
    execution: { ok: boolean; detail: string };
    broker: { ok: boolean; detail: string };
    position_manager: { ok: boolean; detail: string };
    exit: { ok: boolean; detail: string };
    journal: { ok: boolean; detail: string };
    performance: { ok: boolean; detail: string };
  };
  regime: string;
  market_state: string;
  /** Last market validation/normalization snapshot (quality + drop reasons). */
  last_market: {
    ok: boolean;
    quality: number;
    reasons: string[];
    bars_in: number;
    bars_out: number;
  } | null;
  /** Setups that would trip require_positive_expectancy if armed. */
  expectancy_would_block: Array<{
    setup_key: string;
    ev: number;
    samples: number;
  }>;
  expectancy_gate_armed: boolean;
  /** Desk sticky SETUP used by decide (kind/side/status). */
  market_setup: {
    kind: string;
    side: 'BUY' | 'SELL' | null;
    status: string;
    reason: string;
    confirm: number;
  } | null;
  /**
   * Per-epic cycle snapshots — desk multi-epic ticks must not erase evidence.
   * Keyed by Capital API epic (GOLD/SILVER aliases collapsed).
   */
  cycles_by_epic: Record<
    string,
    {
      at: string;
      market_setup: MasterStatus['market_setup'];
      last_market: MasterStatus['last_market'];
      decision_kind: string | null;
      buy_score: number | null;
      sell_score: number | null;
    }
  >;
  /** True when cycles_by_epic came from disk stash (cleared on live tick). */
  cycles_by_epic_hydrated: boolean;
  /** True when require_armed_setup is on (LIVE default). */
  setup_gate_armed: boolean;
  /** Last desk 10s SETUP/MOVE confirm from pipeline (null = none this cycle). */
  desk_entry: {
    side: 'BUY' | 'SELL';
    source: 'setup' | 'move';
    reason: string;
    setup_kind: string;
    playbook: string | null;
  } | null;
  /** Desk 1h structure bias (UNKNOWN when hour_bars absent). */
  hour_bias: 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN' | null;
  /** True when last tick had sticky/desk closed_10s (confirm gate armed). */
  closed_10s_present: boolean;
  /** Sticky closed_10s restored from disk market_cache (bar-armed, not journal-only). */
  closed_10s_cached: boolean;
  /** disk_cache | live | journal provenance for Closed 10s card. */
  closed_10s_source: 'disk_cache' | 'live' | 'journal' | null;
  /** Live entry gate honesty for dashboard (news/hours/weekend). */
  entry_gates: {
    news_cfg_on: boolean;
    news_blocks: boolean;
    news_detail: string | null;
    block_off_hours: boolean;
    weekend: boolean;
    session: string;
    session_blocks: boolean;
    hours_ok: boolean;
    /** Journal session label without a live cycle — not authoritative. */
    session_hydrated: boolean;
  };
  /** Null money fields when Capital LIVE account is unproven (never forged £0). */
  account: (Omit<
    AccountSnapshot,
    'equity' | 'balance' | 'daily_pnl' | 'peak_equity' | 'consecutive_losses'
  > & {
    equity: number | null;
    balance: number | null;
    daily_pnl: number | null;
    peak_equity: number | null;
    consecutive_losses: number | null;
  }) | null;
  open_positions: number;
  performance: ReturnType<typeof computePerformance>;
  /** Closed trades sliced by desk 10s confirm source (setup/move/none). */
  performance_by_desk_entry: ReturnType<typeof performanceByDeskEntry>;
  /** ExpectancyStore rollup by desk confirm suffix on setupKey. */
  expectancy_by_desk_entry: ReturnType<typeof expectancyByDeskSource>;
  monte_carlo: ReturnType<typeof monteCarlo> | null;
  opportunities: number;
  traded: number;
  blocked: number;
  health: string;
  recovered: boolean;
  /** Operator intended running before crash — durable via runtime_gates */
  desired_running: boolean;
  persist_ok: boolean;
  last_persist_error: string | null;
  entries_armed: boolean;
  entries_pause_reason: string | null;
  /** Live structure seed provenance (capital_ohlc required for Capital LIVE entries) */
  structure_seed_source: string;
  /** Cached OHLC bar count available for replay / manage (0 until feed seeds). */
  bars_available: number;
  /** Bars currently from disk market_cache — not a live feed seed. */
  bars_cached: boolean;
  /** Cached 1h OHLC count for desk hour_bias (0 until feed or disk hydrate). */
  hour_bars_available: number;
  /** Hour bars from disk market_cache — not a live HOUR fetch. */
  hour_bars_cached: boolean;
  /** disk_cache | live provenance for Hour bars card. */
  hour_bars_source: 'disk_cache' | 'live' | null;
  news_window: NewsWindowState;
  /** Live quote snapshot for dashboard freshness */
  quote: {
    mid: number;
    bid: number;
    ask: number;
    spread: number;
    age_ms: number;
    /** Same threshold used for LIVE_QUOTE_STALE / entry stale gate */
    stale_quote_ms: number;
    /** age_ms > stale_quote_ms — dashboard Quote card must match health */
    stale: boolean;
    /** Disk market_cache restore — not a live tick (operator must not treat as live feed) */
    cached: boolean;
    /** Provenance for Quote card honesty */
    source: 'live' | 'disk_cache';
    stream_healthy: boolean | null;
  } | null;
  floating_pnl: number | null;
  /**
   * True when Float UPL was marked from a disk_cache quote — not a live tick.
   * Dashboard must not paint green/red as live mark-to-market.
   */
  floating_pnl_cached: boolean;
  /**
   * Float UPL only includes opens matching the active quote epic.
   * True when other-epic opens exist and were excluded from the mark.
   */
  floating_pnl_epic_scoped: boolean;
  /**
   * Multi-epic manage honesty — which epics got a quote this manage pass,
   * and which still open epics lack a usable mark (quote fetch failed).
   */
  manage_epics: {
    managed: string[];
    quote_fetch_failed: string[];
    unmanaged_open: string[];
    at: string | null;
  };
  /** Remaining reject cooldown ms (0 = clear) */
  reject_cooldown_ms: number;
  /** Remaining post-exit cooldown ms (VS re-entry settle) */
  post_exit_cooldown_ms: number;
  /** Newest durable cycle/broker errors */
  recent_errors: Array<{
    ts: string;
    module: string;
    error_type: string;
    message: string;
  }>;
  manage: ManageConfigPatch;
  monitoring: import('./monitoring.js').CycleMonitorSnapshot;
  recent_decisions: Array<{
    ts: string;
    kind: string;
    executed: boolean;
    block_reason: string | null;
    execution_detail: string | null;
    opportunity_id: string | null;
    buy_score?: number;
    sell_score?: number;
    desk_entry_source?: 'setup' | 'move' | null;
    desk_entry_side?: 'BUY' | 'SELL' | null;
    hour_bias?: 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN' | null;
    closed_10s_present?: boolean | null;
  }>;
  recent_trades: Array<{
    ts: string;
    event: string;
    broker: string;
    ok: boolean;
    detail: string | null;
    pnl: number | null;
    fees: number | null;
    opportunity_id: string | null;
    /** Desk confirm path for this close (joined from opportunity). */
    desk_entry_source?: 'setup' | 'move' | 'none' | null;
  }>;
  /** dual | file | memory | pool — where durable state is authoritative */
  persist_backend: 'dual' | 'file' | 'memory' | 'pool' | 'unknown';
  /** Decision/trade audit provenance — sidecars, counts, heal from PG/primary */
  journal_audit: {
    decisions: number;
    trades: number;
    decision_sidecar: boolean;
    trade_sidecar: boolean;
    healed_from_persist: boolean;
    last_hydrate: {
      decisions: number;
      trades: number;
      wrote_jsonl: boolean;
      at: string;
    } | null;
  };
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
  /** Durable intent to run cycles — survives crash; resume on boot when true */
  desired_running = false;
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
  last_market: MasterStatus['last_market'] = null;
  /** Sticky desk SETUP from last pipeline cycle */
  last_market_setup: MasterStatus['market_setup'] = null;
  /** Last desk 10s SETUP/MOVE confirm (dashboard honesty). */
  last_desk_entry: MasterStatus['desk_entry'] = null;
  /** Last structure hour_bias from pipeline (dashboard honesty). */
  last_hour_bias: MasterStatus['hour_bias'] = null;
  /** Sticky closed_10s present on last tick (desk last_closed parity). */
  last_closed_10s_present = false;
  /** Sticky closed_10s bar — survives restart via market_cache (confirm-armed). */
  private last_closed_10s: import('../services/tenSecondOhlc.js').TenSecBar | null =
    null;
  private closed10sFromDiskCache = false;
  /** Journal DecisionEvent flag only — no real TenSecBar yet. */
  private closed10sFromJournalOnly = false;
  /**
   * Per-epic sticky SETUP/structure — setEpic stashes/restores so GOLD↔SILVER
   * desk ticks do not wipe ARMED setup.
   */
  private setupByEpic = new Map<string, EpicSetupSnap>();
  /** Last cycle evidence per epic (dashboard / multi-robot honesty). */
  private cycleByEpic = new Map<string, EpicCycleRow>();
  /** True after disk hydrate until a live rememberCycleForEpic. */
  private epicCycleStashHydrated = false;
  last_bars: Bar[] = [];
  last_quote: Quote | null = null;
  /** True while last_quote was restored from market_cache (cleared on live quote). */
  private quoteFromDiskCache = false;
  /** True while last_bars were restored from market_cache (cleared on live bars). */
  private barsFromDiskCache = false;
  private hourBarsFromDiskCache = false;
  private last_hour_bars: import('./types.js').Bar[] = [];
  private last_hour_bars_detail: string | null = null;
  /** Cached public mids for READER-style feed divergence vs broker quote */
  private lastPublicReferenceMids: number[] | null = null;
  private lastPublicReferenceAtMs = 0;
  last_execution_detail: string | null = null;
  last_exit_reason: string | null = null;
  last_client_fanout: MasterStatus['last_client_fanout'] = null;
  /** Sticky last close_failed for status/dashboard until a successful close clears it. */
  last_close_failed: {
    position_id: string;
    exit_reason: string;
    detail: string;
    ts: string;
  } | null = null;
  last_loss_ms = 0;
  recovered = false;
  persist_ok = true;
  last_persist_error: string | null = null;
  /** VS-System- style: block new entries while an order is in-flight without a position yet. */
  private inflight_until_ms = 0;
  /** VS-System-: cool down after broker reject (e.g. RISK_CHECK). */
  private reject_until_ms = 0;
  broker_detail: string | null = null;
  /**
   * Brokers-page Capital creds seen via resolve/attach (desk path).
   * Env presence is still read live from CAPITAL_* each status().
   */
  private capitalDeskCredsSeen = false;
  /** Last proven Capital venue open count (positions + presence). */
  private capitalVenueOpens = 0;
  /** False when last Capital list failed — UI must not treat venue as flat. */
  private capitalVenueOpensProven = true;
  /** False until Capital equity read proves preferred CFD — do not trust sizing equity. */
  private capitalAccountProven = false;
  /**
   * After Capital attach, day_start/peak must reseed from first proven equity —
   * never inherit paper £10k baselines into LIVE daily-loss gates.
   */
  private capitalDayGatesSeeded = false;
  /**
   * Closes credited while daily_pnl_day lagged the calendar UTC day (defer window).
   * Restored into daily_pnl when rollDailyPnl finally advances the day — otherwise
   * today's closed losses are wiped and max_daily_loss fail-opens.
   */
  private pendingCalendarDayClosedPnl = 0;
  /** When false, manage exits still run but new entries are blocked (desk dual-brain guard). */
  entries_armed = true;
  entries_pause_reason: string | null = null;
  /**
   * Live structure OHLC provenance — Capital LIVE entries require capital_ohlc.
   * Yahoo/synthetic/mt4 must not drive regime against Capital marks.
   */
  structure_seed_source:
    | 'yahoo_ohlc'
    | 'capital_ohlc'
    | 'mt4_ohlc'
    | 'broker_ohlc'
    | 'synthetic_fallback'
    | 'none' = 'none';
  /**
   * Last AI allow_close from pipeline cycle — soft exits on next manageTick.
   * Defaults true (AI off / unknown).
   */
  last_ai_allow_close = true;
  /** null = follow MASTER_OWNS_PIPELINE env; else dashboard override */
  owns_pipeline_pref: boolean | null = null;
  /**
   * Last desk-reported manage owner hint (DESK_DEFERRED_HARD when Capital unsafe).
   * Status falls back to resolveManageOwner from venue opens.
   */
  private desk_manage_owner_hint: 'MASTER' | 'DESK_DEFERRED_HARD' | 'DESK' | null =
    null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private liveFeedTimer: ReturnType<typeof setInterval> | null = null;
  /** VS-System 1s trail/manage loop while a position is open (entry stays on slower feed). */
  private manageTimer: ReturnType<typeof setInterval> | null = null;
  /** Last successful manageTick wall time — stage honesty (never forge green). */
  private last_manage_tick_ms = 0;
  /** Last multi-epic manage pass — dashboard honesty for unmanaged opens. */
  private last_manage_epics: {
    managed: string[];
    quote_fetch_failed: string[];
    at: string;
  } | null = null;
  private lastFullTickAt = 0;
  private seenIntentSnapshot: string[] = [];
  /** Serialize tick() across live-feed / API / desk so opens+persist never race. */
  private tickChain: Promise<unknown> = Promise.resolve();
  /**
   * True after boot journal/opens hydrate (not full recover — no broker sync).
   * Prevents empty dashboard KPIs while durable state exists on disk.
   */
  private bookHydrated = false;
  /** Last audit-journal hydrate from DualPersist/PG primary (dashboard provenance). */
  private lastAuditJournalHydrate: {
    decisions: number;
    trades: number;
    wrote_jsonl: boolean;
    at: string;
  } | null = null;
  /** Reader relative-spread rolling history */
  private spreadLookback = DEFAULT_MASTER_CONFIG.spread_lookback_bars;
  private spreadHistory = new SpreadHistory(this.spreadLookback);
  /** VS-System: 5 consecutive empty successful lists before ghost wipe */
  private emptyBrokerDebounce: EmptyBrokerDebounce = {
    consecutive_empty: 0,
    miss_by_id: {},
  };
  private monitor = new CycleMonitor();
  private monitorHydrated = false;
  /** VS-System post-exit settle — block OPEN until this ms */
  private post_exit_until_ms = 0;
  /** epic:SIDE set only after protective SL sync confirms */
  private last_entry_fingerprint: string | null = null;
  epic = GOLD_SPEC.epic;

  setMode(mode: Mode) {
    this.cfg = {
      ...this.cfg,
      mode,
      // Desk SETUP-first: LIVE Capital path requires ARMED side; paper demos stay open
      require_armed_setup: mode === 'LIVE',
      // LIVE: refuse setups with proven negative EV once sample floor is met
      require_positive_expectancy: mode === 'LIVE',
    };
    this.pipeline.mode = mode;
    this.persistRuntimeGates();
  }

  setKillSwitch(on: boolean) {
    this.cfg = { ...this.cfg, kill_switch: on };
    this.persistRuntimeGates();
  }

  setEpic(epic: string) {
    const raw = String(epic || '').trim();
    // Capital.com markets epic is GOLD/SILVER — keep runtime aligned with API
    let next: string;
    if (this.broker?.name === 'CAPITAL') {
      next = capitalApiEpic(raw) || raw || 'GOLD';
    } else {
      next = raw || this.epic;
    }
    const prevKey = capitalApiEpic(this.epic) || String(this.epic || '').toUpperCase();
    const nextKey = capitalApiEpic(next) || String(next || '').toUpperCase();
    if (prevKey && nextKey && prevKey !== nextKey) {
      const snap = this.pipeline.snapshotMarketSetup();
      if (snap.setup || snap.structure) {
        this.setupByEpic.set(prevKey, snap);
      }
      const restored = this.setupByEpic.get(nextKey) || null;
      this.pipeline.restoreMarketSetup(restored);
    } else if (!this.pipeline.getMarketSetup() && nextKey) {
      const restored = this.setupByEpic.get(nextKey) || null;
      if (restored) this.pipeline.restoreMarketSetup(restored);
    }
    this.epic = next;
    this.persistRuntimeGates();
    this.persistEpicCycleStash();
  }

  /** Record last cycle evidence under the active epic key. */
  private rememberCycleForEpic() {
    const key = capitalApiEpic(this.epic) || String(this.epic || '').toUpperCase();
    if (!key) return;
    this.cycleByEpic.set(key, {
      at: new Date().toISOString(),
      market_setup: this.last_market_setup,
      last_market: this.last_market,
      decision_kind: this.last_decision?.kind ?? null,
      buy_score: this.last_decision?.buy?.score ?? null,
      sell_score: this.last_decision?.sell?.score ?? null,
    });
    const snap = this.pipeline.snapshotMarketSetup();
    if (snap.setup || snap.structure) {
      this.setupByEpic.set(key, snap);
    }
    this.epicCycleStashHydrated = false;
    this.persistEpicCycleStash();
  }

  private persistEpicCycleStash(): void {
    if (!this.setupByEpic.size && !this.cycleByEpic.size) return;
    saveEpicCycleStash({
      setups_by_epic: Object.fromEntries(this.setupByEpic.entries()),
      cycles_by_epic: Object.fromEntries(this.cycleByEpic.entries()),
    });
  }

  /** Restore multi-epic SETUP/cycle Maps from disk (restart honesty). */
  private hydrateEpicCycleStashFromDisk(): void {
    const cached = loadEpicCycleStash();
    if (!cached) return;
    for (const [epic, snap] of Object.entries(cached.setups_by_epic || {})) {
      if (!epic) continue;
      this.setupByEpic.set(epic, {
        setup: snap?.setup ?? null,
        structure: snap?.structure ?? null,
      });
    }
    for (const [epic, row] of Object.entries(cached.cycles_by_epic || {})) {
      if (!epic || !row) continue;
      this.cycleByEpic.set(epic, row);
    }
    if (this.setupByEpic.size || this.cycleByEpic.size) {
      this.epicCycleStashHydrated = true;
      const activeKey =
        capitalApiEpic(this.epic) || String(this.epic || '').toUpperCase();
      const restored = activeKey ? this.setupByEpic.get(activeKey) : null;
      if (restored && !this.pipeline.getMarketSetup()) {
        this.pipeline.restoreMarketSetup(restored);
      }
    }
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

  /**
   * Boot / status warm: load durable kill/ai/mode/epic/entries/close_fail from
   * runtime_gates without full recover — dashboard must not show cold defaults
   * while recent_decisions already read disk.
   */
  hydrateRuntimeGatesFromDisk(): boolean {
    const gates = loadRuntimeGates();
    if (!gates) return false;
    this.applyRuntimeGates(gates);
    return true;
  }

  /** Apply persisted gates into live runtime fields (recover + boot hydrate). */
  private applyRuntimeGates(gates: NonNullable<ReturnType<typeof loadRuntimeGates>>) {
    this.last_loss_ms = Math.max(this.last_loss_ms, gates.last_loss_ms || 0);
    this.reject_until_ms = Math.max(
      this.reject_until_ms,
      gates.reject_until_ms || 0
    );
    this.inflight_until_ms = Math.max(
      this.inflight_until_ms,
      gates.inflight_until_ms || 0
    );
    this.post_exit_until_ms = Math.max(
      this.post_exit_until_ms,
      gates.post_exit_until_ms || 0
    );
    if (gates.last_entry_fingerprint) {
      this.last_entry_fingerprint = gates.last_entry_fingerprint;
    }
    if (gates.daily_pnl_day) {
      this.account.daily_pnl_day = gates.daily_pnl_day;
    }
    if (
      gates.ai_mode === 'off' ||
      gates.ai_mode === 'advisory' ||
      gates.ai_mode === 'required'
    ) {
      this.cfg = { ...this.cfg, ai_mode: gates.ai_mode };
    }
    if (typeof gates.kill_switch === 'boolean') {
      this.cfg = { ...this.cfg, kill_switch: gates.kill_switch };
    }
    if (
      gates.mode === 'PAPER' ||
      gates.mode === 'LIVE' ||
      gates.mode === 'BACKTEST'
    ) {
      // LIVE defaults to desk SETUP ARMED gate + positive expectancy; manage config can override
      const manage = loadManageConfig();
      const armedDefault = gates.mode === 'LIVE';
      const require_armed_setup =
        manage && typeof manage.require_armed_setup === 'boolean'
          ? manage.require_armed_setup
          : armedDefault;
      const require_positive_expectancy =
        manage && typeof manage.require_positive_expectancy === 'boolean'
          ? manage.require_positive_expectancy
          : armedDefault;
      this.cfg = {
        ...this.cfg,
        mode: gates.mode,
        require_armed_setup,
        require_positive_expectancy,
      };
      this.pipeline.mode = gates.mode;
    }
    if (gates.epic && String(gates.epic).trim()) {
      this.epic = String(gates.epic).trim();
    }
    if (typeof gates.entries_armed === 'boolean') {
      this.entries_armed = gates.entries_armed;
      this.entries_pause_reason = gates.entries_armed
        ? null
        : gates.entries_pause_reason || 'entries_paused';
    }
    if (gates.last_close_failed && typeof gates.last_close_failed === 'object') {
      this.last_close_failed = gates.last_close_failed;
    }
    if (typeof gates.desired_running === 'boolean') {
      this.desired_running = gates.desired_running;
    }
    if (typeof gates.last_ai_allow_close === 'boolean') {
      this.last_ai_allow_close = gates.last_ai_allow_close;
    } else if (this.cfg.ai_mode !== 'off') {
      this.last_ai_allow_close = false;
    }
    const capitalAttached =
      this.broker instanceof CapitalBroker && !this.broker.paper;
    if (!capitalAttached || gates.capital_day_gates_seeded === true) {
      if (gates.day_start_equity != null && gates.day_start_equity > 0) {
        this.account.day_start_equity = gates.day_start_equity;
      }
      if (gates.peak_equity != null && gates.peak_equity > 0) {
        this.account.peak_equity = Math.max(
          this.account.peak_equity,
          gates.peak_equity
        );
      }
      if (capitalAttached && gates.capital_day_gates_seeded === true) {
        this.capitalDayGatesSeeded = true;
      }
    } else if (capitalAttached) {
      this.account.day_start_equity = 0;
      this.account.peak_equity = 0;
      this.capitalDayGatesSeeded = false;
    }
    if (
      gates.consecutive_losses != null &&
      Number.isFinite(gates.consecutive_losses)
    ) {
      this.account.consecutive_losses = Math.max(
        0,
        Math.floor(gates.consecutive_losses)
      );
    }
  }

  /**
   * After recover (API or Start): seed manage from cache/broker so opens are not
   * blind until the first poll. Safe to call when flat (no-op).
   */
  async bootstrapManageAfterRecoverPublic(): Promise<void> {
    await this.bootstrapManageAfterRecover();
  }

  /**
   * Test/desk: feed-miss manage fallback — same gate as broker/public live-feed
   * miss paths (quote alone; OHLC ≥5 optional). Returns whether manage ran.
   */
  async feedMissManageFallbackPublic(): Promise<{ managed: boolean; bars: number }> {
    const bars = this.last_bars.length;
    if (!this.last_quote) return { managed: false, bars };
    await this.manageOnlyTick(this.last_bars, this.last_quote);
    return { managed: true, bars };
  }

  /**
   * Demo/tests: stop background manage timer so fill→exit proof is observed
   * on tick()/exit_drive — not a silent 1s manage close between live polls.
   */
  pauseBackgroundManage(): void {
    this.clearManageLoop();
  }

  /**
   * Resume feed/entries after crash when durable desired_running is set.
   * PAPER uses public live feed; LIVE only when Capital/MT4 broker already attached
   * (never invents Capital credentials).
   */
  async resumeDesiredSession(): Promise<{ resumed: boolean; detail: string }> {
    if (!this.desired_running) {
      // Opens must still be managed even when operator had Stopped
      if (this.positions.count() > 0) {
        if (!this.broker) {
          if (this.cfg.mode === 'LIVE') {
            // Never paper-manage Capital LIVE opens
            return { resumed: false, detail: 'live_opens_need_capital' };
          }
          this.ensurePaperBroker();
        }
        await this.bootstrapManageAfterRecover();
        return { resumed: false, detail: 'manage_opens_only' };
      }
      return { resumed: false, detail: 'not_desired' };
    }
    if (this.running) {
      return { resumed: false, detail: 'already_running' };
    }
    if (this.cfg.kill_switch) {
      return { resumed: false, detail: 'kill_switch' };
    }
    if (this.cfg.mode === 'LIVE') {
      const liveBroker =
        !!this.broker && !this.broker.paper && this.broker.name !== 'PAPER';
      if (!liveBroker) {
        // Leave desired_running sticky — operator must Attach Capital then Start/Recover
        return { resumed: false, detail: 'live_needs_capital' };
      }
      await this.start({ live_feed: false });
      return { resumed: true, detail: 'live_broker_feed' };
    }
    await this.start({ live_feed: true });
    return { resumed: true, detail: 'paper_live_feed' };
  }

  /**
   * Boot warm: load opens + journal + expectancy + daily_pnl from disk without
   * broker sync. Dashboard must not forge an empty book when durable state exists.
   * Full recover() still required for Capital venue reconcile.
   */
  async hydrateBookFromDisk(): Promise<boolean> {
    if (this.recovered || this.bookHydrated) return true;
    try {
      const { ensureOperatorMetaFromStateDir } = await import('./filePersist.js');
      ensureOperatorMetaFromStateDir();
      // PG DualPersist primary → restore wiped decision/trade jsonl before status reads
      const { hydrateAuditJournalsFromPersist } = await import(
        './auditJournalHydrate.js'
      );
      const auditHydrate = await hydrateAuditJournalsFromPersist();
      this.lastAuditJournalHydrate = {
        decisions: auditHydrate.decisions,
        trades: auditHydrate.trades,
        wrote_jsonl: auditHydrate.wrote_jsonl,
        at: new Date().toISOString(),
      };
      const { hydrateMarketCacheFromPersist } = await import('./marketCache.js');
      await hydrateMarketCacheFromPersist();
      this.hydrateMarketCacheFromDisk();
      const { hydrateEpicCycleStashFromPersist } = await import(
        './epicCycleStash.js'
      );
      await hydrateEpicCycleStashFromPersist();
      this.hydrateEpicCycleStashFromDisk();
      const { hydrateRuntimeGatesFromPersist } = await import(
        './runtimeGates.js'
      );
      await hydrateRuntimeGatesFromPersist();
      this.hydrateRuntimeGatesFromDisk();
      const { hydrateManageConfigFromPersist } = await import(
        './manageConfig.js'
      );
      await hydrateManageConfigFromPersist();
      this.hydrateManageConfig();
      const { hydrateOwnsPipelineFromPersist } = await import(
        './ownsPipelinePref.js'
      );
      await hydrateOwnsPipelineFromPersist();
      this.hydrateOwnsPipelinePref();
      const { hydrateMonitoringSnapshotFromPersist } = await import(
        './monitoring.js'
      );
      await hydrateMonitoringSnapshotFromPersist();
      this.hydrateMonitorFromDisk();
      const { hydrateSpreadHistoryFromPersist, SpreadHistory: SH } =
        await import('./spreadModel.js');
      await hydrateSpreadHistoryFromPersist();
      this.spreadLookback = this.cfg.spread_lookback_bars;
      this.spreadHistory = new SH(this.spreadLookback);
      this.spreadHistory.load();
      const { hydrateTradeAckJournalFromPersist } = await import(
        './tradeAckJournal.js'
      );
      await hydrateTradeAckJournalFromPersist();
      const { hydrateErrorJournalFromPersist } = await import(
        './errorJournal.js'
      );
      await hydrateErrorJournalFromPersist();
      const { hydrateNewsWindowFromPersist } = await import('./newsGate.js');
      await hydrateNewsWindowFromPersist();
      const { hydrateClientFanoutFromPersist } = await import(
        './masterClientFanout.js'
      );
      const fanoutHydrate = await hydrateClientFanoutFromPersist();
      if (fanoutHydrate.summary) {
        this.last_client_fanout = fanoutHydrate.summary;
      }
      const { hydrateNewsCalendarFromPersist } = await import(
        './newsCalendar.js'
      );
      await hydrateNewsCalendarFromPersist();
      if (this.positions.count() === 0) {
        const loaded = await loadOpenPositions();
        const valid = loaded.filter((p) => p.decision && p.position_id);
        if (valid.length) this.positions.fromJSON(valid);
      }
      if (this.pipeline.journal.opportunities.length === 0) {
        const hist = await loadJournalHistory();
        this.pipeline.journal.hydrate(
          hist.opportunities,
          hist.outcomes.map((o) => o.outcome)
        );
        this.pipeline.journal.applyOutcomeSetupKeys(hist.outcomes);
        this.pipeline.expectancy.hydrate(
          hist.outcomes
            .filter((o) => !!o.setup_key && !!o.outcome)
            .map((o) => ({
              setup_key: String(o.setup_key),
              outcome: o.outcome,
            }))
        );
        this.seedDashboardFromHistory(hist);
        // Paper/boot: rebuild equity BEFORE UTC day-roll so day_start_equity seeds
        // from journal truth (not default £10k). Capital LIVE still needs recover
        // for venue-truth equity — do not invent Capital equity here.
        const capitalAttached =
          this.broker instanceof CapitalBroker && !this.broker.paper;
        const oppMode = new Map(
          hist.opportunities.map((o) => [String(o.id), String(o.mode || '')])
        );
        let pnlAll = 0;
        for (const o of hist.outcomes) {
          if (o.outcome.pnl_proven === false) continue;
          if (capitalAttached && oppMode.get(String(o.opportunity_id)) !== 'LIVE') {
            continue;
          }
          pnlAll += o.outcome.pnl;
        }
        if (!capitalAttached) {
          // Full journal closed PnL from paper start (£10k). Sync balance to
          // realized cash so seedPaperBroker/MTM do not prefer stale £10k cash.
          const paperStart = 10_000;
          const cash = paperStart + pnlAll;
          this.account.balance = cash;
          this.account.equity = cash;
          if (this.account.equity > this.account.peak_equity) {
            this.account.peak_equity = this.account.equity;
          }
        }
        // Open-book hydrate: MTM before UTC day-roll (parity with recover) so
        // day_start_equity seeds from cash+UPL — not cash-only before manage.
        // Use a throwaway PaperBroker — do not attach this.broker (restart
        // continuity keeps broker stage hydrated · awaiting attach until Start).
        if (
          !capitalAttached &&
          this.positions.count() > 0 &&
          this.quoteProvenForOpenDayRoll(this.last_quote)
        ) {
          const q = this.last_quote;
          const tmp = new PaperBroker();
          tmp.hydrateAccount({
            equity: this.account.equity,
            balance: this.account.balance,
          });
          tmp.seedOpens(
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
          tmp.setQuote({
            bid: q.bid,
            ask: q.ask,
            mid: q.mid,
            spread: q.spread,
            epic: q.epic || this.epic,
            ts_ms: q.ts_ms,
          });
          tmp.markToMarket();
          try {
            const acctPre = await tmp.getAccount();
            if (
              acctPre &&
              acctPre.equity > 0 &&
              Number.isFinite(acctPre.equity)
            ) {
              this.account.equity = acctPre.equity;
              if (acctPre.balance > 0 && Number.isFinite(acctPre.balance)) {
                this.account.balance = acctPre.balance;
              }
              this.account.peak_equity = Math.max(
                Number(this.account.peak_equity) || 0,
                acctPre.equity
              );
            }
          } catch {
            /* keep journal cash */
          }
        }
        // Opens without a live mark / Capital unproven: defer UTC day-roll —
        // disk/stale/missing quote or unread Capital would wipe/seal day_start
        // and leave max_daily_loss fail-open.
        const deferOpenDayRoll = this.shouldDeferUtcDayRoll(this.last_quote);
        const calToday = new Date().toISOString().slice(0, 10);
        let pnlToday = 0;
        for (const o of hist.outcomes) {
          if (o.outcome.pnl_proven === false) continue;
          if (
            capitalAttached &&
            oppMode.get(String(o.opportunity_id)) !== 'LIVE'
          ) {
            continue;
          }
          const day = String(o.created_at || '').slice(0, 10);
          if (day === calToday) pnlToday += o.outcome.pnl;
        }
        if (!deferOpenDayRoll) {
          this.rollDailyPnl();
          // After roll, surface today's closed daily_pnl
          if (!capitalAttached || this.capitalDayGatesSeeded) {
            this.pendingCalendarDayClosedPnl = 0;
            this.account.daily_pnl = pnlToday;
          }
        } else {
          // Defer: keep closed PnL for the still-sealed day — wiping to pnlToday
          // (often 0) would drop prior-day losses from max_daily_loss while
          // day_start_equity stays on yesterday.
          if (!capitalAttached || this.capitalDayGatesSeeded) {
            const sealedDay = this.account.daily_pnl_day;
            if (sealedDay) {
              let pnlSealed = 0;
              for (const o of hist.outcomes) {
                if (o.outcome.pnl_proven === false) continue;
                if (
                  capitalAttached &&
                  oppMode.get(String(o.opportunity_id)) !== 'LIVE'
                ) {
                  continue;
                }
                const day = String(o.created_at || '').slice(0, 10);
                if (day === sealedDay) pnlSealed += o.outcome.pnl;
              }
              this.account.daily_pnl = pnlSealed;
            }
          }
          // Park calendar-today journal closes for post-roll restore — memory
          // pending is lost across restart; rebuild from disk (parity with live
          // creditClosedDailyPnl during the defer window).
          this.pendingCalendarDayClosedPnl = pnlToday;
        }
      }
      // After opens + journal are available — heal missing desk confirm on decision
      if (this.positions.count() > 0) {
        const healed = backfillDeskEntrySources(this.positions.list(), {
          opportunities: this.pipeline.journal.opportunities,
          decisions: loadDecisionEvents(500),
        });
        if (healed > 0) {
          this.trackPersist(
            'open_positions',
            saveOpenPositions(this.positions.list())
          );
        }
      }
      this.account.open_positions = this.positions.count();
      this.bookHydrated = true;
      return true;
    } catch {
      return false;
    }
  }

  /** Seed last_exit / last_decision / last_risk cards from recovered journal history. */
  private seedDashboardFromHistory(hist: {
    opportunities: Array<{
      ts?: string;
      decision?: MasterDecision | null;
      risk?: ReturnType<typeof evaluateRisk> | null;
      execution?: { detail?: string | null } | null;
    }>;
    outcomes: Array<{
      created_at?: string;
      outcome?: { exit_reason?: string } | null;
    }>;
  }) {
    if (hist.outcomes.length && !this.last_exit_reason) {
      const latest = [...hist.outcomes].sort((a, b) =>
        String(b.created_at || '').localeCompare(String(a.created_at || ''))
      )[0];
      if (latest?.outcome?.exit_reason) {
        this.last_exit_reason = latest.outcome.exit_reason;
      }
    }
    if (!this.last_decision && hist.opportunities.length) {
      const withDecision = [...hist.opportunities]
        .filter((o) => o.decision)
        .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
      const latestOpp = withDecision[0];
      if (latestOpp?.decision) {
        this.last_decision = latestOpp.decision;
        if (!this.last_execution_detail && latestOpp.execution?.detail) {
          this.last_execution_detail = String(latestOpp.execution.detail);
        }
        // Seed Stage·risk evidence from journal opportunity — still red until live cycle
        if (
          !this.last_risk &&
          latestOpp.risk &&
          typeof latestOpp.risk === 'object' &&
          Array.isArray(latestOpp.risk.reasons)
        ) {
          this.last_risk = {
            allowed: !!latestOpp.risk.allowed,
            volume: Number(latestOpp.risk.volume) || 0,
            risk_amount: Number(latestOpp.risk.risk_amount) || 0,
            reasons: latestOpp.risk.reasons.map(String),
          };
        }
      }
    }
    if (!this.last_decision) {
      const ev = loadDecisionEvents(1)[0];
      if (ev) {
        this.last_decision = {
          decision_id: ev.opportunity_id || 'recovered',
          kind: (['BUY', 'SELL', 'WAIT', 'BLOCK'].includes(ev.kind)
            ? ev.kind
            : 'WAIT') as MasterDecision['kind'],
          side:
            ev.kind === 'BUY' || ev.kind === 'SELL'
              ? (ev.kind as 'BUY' | 'SELL')
              : null,
          score: Math.max(ev.buy_score || 0, ev.sell_score || 0),
          block_reason: ev.block_reason,
          buy: { score: ev.buy_score || 0 } as MasterDecision['buy'],
          sell: { score: ev.sell_score || 0 } as MasterDecision['sell'],
          analysis: {
            regime: 'UNKNOWN',
            market_state: 'recovered_from_decision_journal',
          } as MasterDecision['analysis'],
          expectancy: null,
          desk_entry_source:
            ev.desk_entry_source === 'setup' || ev.desk_entry_source === 'move'
              ? ev.desk_entry_source
              : 'none',
        };
        if (!this.last_execution_detail && ev.execution_detail) {
          this.last_execution_detail = ev.execution_detail;
        }
      }
    }
    // Opportunity seed often has decision but no execution payload — backfill
    // Stage·exec from decision_journal so restart is not blank (still hydrated).
    if (!this.last_execution_detail) {
      const withExec = loadDecisionEvents(24).find((e) => e.execution_detail);
      if (withExec?.execution_detail) {
        this.last_execution_detail = String(withExec.execution_detail);
      }
    }
    // Desk entry / hour_bias / closed_10s cards — seed from DecisionEvent when live cycle absent
    if (!this.last_desk_entry) {
      const withConfirm = loadDecisionEvents(96).find(
        (e) => e.desk_entry_source === 'setup' || e.desk_entry_source === 'move'
      );
      if (withConfirm && (withConfirm.desk_entry_side === 'BUY' || withConfirm.desk_entry_side === 'SELL')) {
        this.last_desk_entry = {
          side: withConfirm.desk_entry_side,
          source: withConfirm.desk_entry_source as 'setup' | 'move',
          reason: `hydrated · ${withConfirm.desk_entry_source}`,
          setup_kind: 'HYDRATED',
          playbook: null,
        };
      } else {
        const oppConfirm = [...hist.opportunities]
          .filter(
            (o) =>
              o.decision?.desk_entry_source === 'setup' ||
              o.decision?.desk_entry_source === 'move'
          )
          .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))[0];
        const src = oppConfirm?.decision?.desk_entry_source;
        const side = oppConfirm?.decision?.side;
        if (
          (src === 'setup' || src === 'move') &&
          (side === 'BUY' || side === 'SELL')
        ) {
          this.last_desk_entry = {
            side,
            source: src,
            reason: `hydrated · ${src}`,
            setup_kind: 'HYDRATED',
            playbook: null,
          };
        }
      }
    }
    if (this.last_hour_bias == null) {
      const withBias = loadDecisionEvents(96).find(
        (e) =>
          e.hour_bias === 'UP' ||
          e.hour_bias === 'DOWN' ||
          e.hour_bias === 'FLAT' ||
          e.hour_bias === 'UNKNOWN'
      );
      if (withBias?.hour_bias) this.last_hour_bias = withBias.hour_bias;
    }
    if (!this.last_closed_10s_present && !this.last_closed_10s) {
      const with10s = loadDecisionEvents(96).find(
        (e) => e.closed_10s_present === true
      );
      if (with10s) {
        this.last_closed_10s_present = true;
        this.closed10sFromJournalOnly = true;
      }
    }
  }

  /**
   * Operator AI mode — durable via runtime_gates.
   * Enabling AI (off → advisory/required) fail-closes soft exits until a cycle proves allow.
   */
  setAiMode(mode: MasterConfig['ai_mode']): MasterConfig {
    const prev = this.cfg.ai_mode;
    this.cfg = { ...this.cfg, ai_mode: mode };
    if (mode !== 'off' && prev === 'off') {
      this.last_ai_allow_close = false;
    }
    this.persistRuntimeGates();
    return this.cfg;
  }

  /** Positions enriched with live UPL for dashboard — null UPL when quote missing (never invent 0). */
  positionsForApi(): Array<
    ManagedPosition & {
      upl: number | null;
      mark: number | null;
      desk_entry_source: 'setup' | 'move' | 'none' | null;
    }
  > {
    const quote = this.last_quote;
    const pv = specForEpic(this.epic).value_per_point_per_lot;
    return this.positions.list().map((p) => {
      const raw = p.decision?.desk_entry_source;
      const desk_entry_source: 'setup' | 'move' | 'none' | null =
        raw === 'setup' || raw === 'move' || raw === 'none' ? raw : null;
      if (!quote) return { ...p, upl: null, mark: null, desk_entry_source };
      const mark = protectiveMark(p.side, quote);
      const capitalLive =
        this.broker instanceof CapitalBroker && !this.broker.paper;
      const upl =
        capitalLive && usableBrokerUpl(p.broker_upl) == null
          ? null
          : resolveFloatingMoneyPnl({
              side: p.side,
              entry: p.entry,
              mark,
              size: p.size,
              value_per_point_per_lot: pv,
              broker_upl: p.broker_upl,
              capitalLive,
            });
      return { ...p, upl, mark, desk_entry_source };
    });
  }

  /**
   * Operator close — bypass soft close_requires_sl for emergency flatten.
   * Still journals outcome against opportunity when present.
   * Serialized on tickChain so manage/sync cannot race CLOSE/journal.
   */
  async closePositionManual(
    positionId: string,
    reason = 'OPERATOR_CLOSE'
  ): Promise<{ ok: boolean; detail: string; pnl?: number }> {
    return this.runOnTickChain(() =>
      this.closePositionManualUnlocked(positionId, reason)
    );
  }

  private async closePositionManualUnlocked(
    positionId: string,
    reason = 'OPERATOR_CLOSE'
  ): Promise<{ ok: boolean; detail: string; pnl?: number }> {
    const broker = this.broker;
    if (!broker) return { ok: false, detail: 'no_broker' };
    const pos = this.positions.get(positionId);
    if (!pos) return { ok: false, detail: 'not_found' };
    const capitalLive = broker.name === 'CAPITAL' && !broker.paper;
    // Capital LIVE: never forge entry-as-quote mark when last_quote is missing
    if (capitalLive && !this.last_quote) {
      return { ok: false, detail: 'no_quote_capital_live' };
    }
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
      const detail = closeRes.detail || 'close_failed';
      this.broker_detail = `close_fail:${positionId}:${detail}`.slice(0, 400);
      this.last_exit_reason = `CLOSE_FAIL · ${reason} · ${detail}`;
      this.last_close_failed = {
        position_id: positionId,
        exit_reason: reason,
        detail,
        ts: new Date().toISOString(),
      };
      logTradeEvent({
        event: 'CLOSE',
        broker: broker.name,
        epic: pos.epic,
        side: pos.side,
        volume: pos.size,
        price: null,
        position_id: positionId,
        intent_id: pos.intent_id,
        opportunity_id: pos.opportunity_id,
        desk_entry_source: pos.decision?.desk_entry_source,
        ok: false,
        detail: `${reason} · ${detail}`,
      });
      this.persistRuntimeGates();
      return { ok: false, detail };
    }
    const { exit: fill, fill_proven } = resolveCloseExitFill({
      fill_price: closeRes.fill_price,
      mark,
      entry: pos.entry,
      capitalLive,
    });
    const instrument = specForEpic(pos.epic);
    const priced = priceResolvedCloseMoney({
      ...resolveCloseMoneyPnl({
        side: pos.side,
        entry: pos.entry,
        fill,
        size: pos.size,
        value_per_point_per_lot: instrument.value_per_point_per_lot,
        // Prefer close confirm; else last synced UPL (never treat UPL===0 as realized)
        fill_pnl: preferCloseFillPnl({
          fill_pnl: closeRes.fill_pnl,
          broker_upl: pos.broker_upl,
        }),
        capitalLive,
      }),
      volume: pos.size,
    });
    const heldMs = Date.now() - new Date(pos.entry_at).getTime();
    const outcome: TradeOutcome = {
      position_id: pos.position_id,
      side: pos.side,
      entry: pos.entry,
      exit: fill,
      volume: pos.size,
      pnl: priced.pnl,
      fees: priced.fees,
      pnl_proven: priced.pnl_proven,
      slippage: fill_proven ? Math.abs(fill - quote.mid) : 0,
      mae: pos.mae,
      mfe: pos.mfe,
      r_multiple: rMultipleFromClose({
        entry: pos.entry,
        stop_loss: pos.stop_loss,
        pnl_pts: priced.pnl_pts,
      }),
      hold_ms: heldMs,
      exit_reason: priced.pnl_proven
        ? reason
        : `${reason} · capital_close_pnl_unproven`,
    };
    this.pipeline.recordTradeClose(pos.opportunity_id, pos.decision, outcome, {
      epic: pos.epic,
    });
    this.positions.drop(positionId);
    if (priced.pnl_proven) {
      this.creditClosedDailyPnl(outcome.pnl);
      if (outcome.pnl < 0) {
        this.account.consecutive_losses += 1;
        this.last_loss_ms = Date.now();
      } else {
        this.account.consecutive_losses = 0;
      }
    }
    this.last_exit_reason = outcome.exit_reason;
    this.last_close_failed = null;
    const cool = Math.max(0, this.cfg.post_exit_cooldown_ms || 0);
    this.post_exit_until_ms = Math.max(
      this.post_exit_until_ms,
      Date.now() + cool
    );
    this.persistRuntimeGates();
    const sk = pos.decision?.side
      ? setupKey(
          pos.decision.analysis,
          pos.decision.side,
          pos.epic,
          pos.decision.desk_entry_source
        )
      : null;
    this.trackPersist('outcome', persistOutcome(pos.opportunity_id, outcome, sk));
    this.trackPersist('open_positions', saveOpenPositions(this.positions.list()));
    logTradeEvent({
      event: 'CLOSE',
      broker: broker.name,
      epic: pos.epic,
      side: pos.side,
      volume: pos.size,
      price: fill,
      position_id: pos.position_id,
      intent_id: pos.intent_id,
      opportunity_id: pos.opportunity_id,
      desk_entry_source: pos.decision?.desk_entry_source,
      ok: true,
      detail: outcome.exit_reason,
      // Omit pnl/fees when unproven — do not advertise forged 0 as a flat close
      ...(priced.pnl_proven
        ? { pnl: outcome.pnl, fees: outcome.fees }
        : {}),
    });
    // Desk Flatten/Close: refresh full venue account snapshot (equity/peak +
    // available/trade_allowed + Capital prove) — same as manageOnly / full tick.
    try {
      const acct = await broker.getAccount();
      await this.applyVenueAccountSnapshot(broker, acct, quote);
    } catch {
      /* keep */
    }
    return {
      ok: true,
      detail: outcome.exit_reason,
      // Omit pnl when unproven — do not advertise forged 0 as a flat close
      ...(priced.pnl_proven ? { pnl: outcome.pnl } : {}),
    };
  }

  async flattenAll(reason = 'OPERATOR_FLATTEN'): Promise<{
    ok: boolean;
    closed: number;
    failed: string[];
  }> {
    return this.runOnTickChain(async () => {
      const ids = this.positions.list().map((p) => p.position_id);
      const failed: string[] = [];
      let closed = 0;
      for (const id of ids) {
        const r = await this.closePositionManualUnlocked(id, reason);
        if (r.ok) closed += 1;
        else failed.push(`${id}:${r.detail}`);
      }
      // Venue orphans (Capital LIVE deals not in local book) — close so Start PAPER
      // / detach cannot leave unmanaged risk after a "successful" flatten.
      const broker = this.broker;
      if (broker && broker.name === 'CAPITAL' && !broker.paper) {
        const listed = await broker.listOpenPositions();
        if (!listed.ok) {
          const detail = listed.detail || 'list_failed';
          failed.push(`venue_list:${detail}`);
          this.capitalVenueOpensProven = false;
          this.broker_detail = `close_fail:venue_list:${detail}`.slice(0, 400);
          this.last_close_failed = {
            position_id: 'venue_list',
            exit_reason: reason,
            detail,
            ts: new Date().toISOString(),
          };
          this.last_exit_reason = `CLOSE_FAIL · ${reason} · venue_list · ${detail}`;
          this.persistRuntimeGates();
        } else {
          const venueIds = new Set<string>();
          for (const p of listed.positions) {
            if (p.position_id) venueIds.add(p.position_id);
          }
          for (const id of listed.presence_ids ?? []) {
            if (id) venueIds.add(id);
          }
          for (const id of venueIds) {
            if (ids.includes(id) || this.positions.get(id)) continue;
            const listedPos = listed.positions.find((p) => p.position_id === id);
            const r = await broker.closePosition(id);
            if (!r.ok) {
              const detail = r.detail || 'close_failed';
              failed.push(`${id}:venue:${detail}`);
              this.broker_detail = `close_fail:${id}:venue:${detail}`.slice(0, 400);
              this.last_close_failed = {
                position_id: id,
                exit_reason: reason,
                detail: `venue:${detail}`,
                ts: new Date().toISOString(),
              };
              this.last_exit_reason = `CLOSE_FAIL · ${reason} · venue · ${detail}`;
              this.persistRuntimeGates();
              logTradeEvent({
                event: 'CLOSE',
                broker: broker.name,
                epic: listedPos?.epic || this.epic,
                side: listedPos?.side ?? null,
                volume: listedPos?.size ?? null,
                price: null,
                position_id: id,
                ok: false,
                detail: `${reason} · venue:${detail}`,
              });
              continue;
            }
            closed += 1;
            // Journal venue-orphan flatten money when confirm/UPL proves it —
            // otherwise day gates would fail-open (close without realized PnL).
            const meta = (listed.presence_meta ?? []).find(
              (m) => m.position_id === id
            );
            const side = listedPos?.side ?? meta?.side ?? null;
            const sizeRaw =
              listedPos?.size != null &&
              Number.isFinite(listedPos.size) &&
              listedPos.size > 0
                ? Number(listedPos.size)
                : meta?.size != null &&
                    Number.isFinite(meta.size) &&
                    meta.size > 0
                  ? Number(meta.size)
                  : null;
            // Never invent BUY or lot=1 for presence-only / unknown book rows
            if (!side || sizeRaw == null) {
              this.last_exit_reason = `${reason}:venue_orphan · capital_close_meta_unproven`;
              logTradeEvent({
                event: 'CLOSE',
                broker: broker.name,
                epic: listedPos?.epic || meta?.epic || this.epic,
                side,
                volume: sizeRaw,
                price: r.fill_price ?? null,
                position_id: id,
                intent_id: null,
                opportunity_id: null,
                ok: true,
                detail: this.last_exit_reason,
              });
              continue;
            }
            const entryProven =
              listedPos != null &&
              listedPos.open_level_proven !== false &&
              Number.isFinite(listedPos.open_level) &&
              listedPos.open_level > 0
                ? Number(listedPos.open_level)
                : null;
            const entry =
              entryProven ??
              (r.fill_price != null &&
              Number.isFinite(r.fill_price) &&
              r.fill_price > 0
                ? Number(r.fill_price)
                : null);
            const quote = this.last_quote;
            const mark = quote
              ? protectiveMark(side, quote)
              : entry ?? 0;
            const { exit } = resolveCloseExitFill({
              fill_price: r.fill_price,
              mark: mark > 0 ? mark : entry ?? 0,
              entry: entry ?? (mark > 0 ? mark : 0),
              capitalLive: true,
            });
            const instrument = specForEpic(
              listedPos?.epic || meta?.epic || this.epic
            );
            const vol = sizeRaw;
            const priced = priceResolvedCloseMoney({
              ...resolveCloseMoneyPnl({
                side,
                entry: entry ?? exit,
                fill: exit,
                size: vol,
                value_per_point_per_lot: instrument.value_per_point_per_lot,
                fill_pnl: preferCloseFillPnl({
                  fill_pnl: r.fill_pnl,
                  broker_upl: listedPos?.upl,
                }),
                capitalLive: true,
              }),
              volume: vol,
            });
            if (priced.pnl_proven) {
              this.creditClosedDailyPnl(priced.pnl);
              if (priced.pnl < 0) {
                this.account.consecutive_losses += 1;
                this.last_loss_ms = Date.now();
              } else {
                this.account.consecutive_losses = 0;
              }
              this.persistRuntimeGates();
            }
            this.last_exit_reason = priced.pnl_proven
              ? `${reason}:venue_orphan`
              : `${reason}:venue_orphan · capital_close_pnl_unproven`;
            logTradeEvent({
              event: 'CLOSE',
              broker: broker.name,
              epic: listedPos?.epic || meta?.epic || this.epic,
              side,
              volume: vol,
              price: exit,
              position_id: id,
              intent_id: null,
              opportunity_id: null,
              ok: true,
              detail: this.last_exit_reason,
              ...(priced.pnl_proven
                ? { pnl: priced.pnl, fees: priced.fees }
                : {}),
            });
          }
          // Re-list so status capital_venue_opens reflects post-flatten truth
          await this.refreshCapitalVenueOpens();
        }
      }
      return { ok: failed.length === 0, closed, failed };
    });
  }

  /** Serialize operator/manage/full-tick work on one chain. */
  private runOnTickChain<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tickChain.then(fn, fn);
    this.tickChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Desk single-owner toggle — persists preference for restart.
   * Refuse Owns OFF while Capital LIVE is already running (dual-brain mid-session).
   */
  setOwnsPipeline(on: boolean): { ok: true } | { ok: false; detail: string } {
    if (
      !on &&
      this.running &&
      this.cfg.mode === 'LIVE' &&
      this.capitalBrokerAttached()
    ) {
      return {
        ok: false,
        detail:
          'Owns OFF refused — Capital LIVE is running (would dual-brain with Robot Desk). Stop MASTER first.',
      };
    }
    this.owns_pipeline_pref = on;
    saveOwnsPipelinePref(on);
    if (on) {
      // Sync clear stale OWN BRAIN flags so Client fanout is not starved
      void import('../services/robotDesk.js')
        .then((m) => m.disableDeskEntryBrainsWhileOwns())
        .catch(() => undefined);
    }
    return { ok: true };
  }

  ownsPipelineEffective(): boolean {
    if (this.owns_pipeline_pref != null) return this.owns_pipeline_pref;
    return process.env.MASTER_OWNS_PIPELINE === 'true';
  }

  /**
   * After MASTER accepts OPEN while owns_pipeline: fan EntryReady to Client
   * RUNNING subscriptions (Market Core path stays blocked).
   * Never throws into the tick — DB/Capital fanout failures are status-only.
   */
  async fanoutAcceptedOpenToClients(input: {
    side: 'BUY' | 'SELL';
    intent_id: string;
    reference_price?: number | null;
    regime?: string | null;
    setup_type?: string | null;
  }): Promise<MasterStatus['last_client_fanout']> {
    const {
      buildMasterFanoutIntent,
      summarizeFanoutResult,
      journalMasterFanoutFills,
    } = await import('./masterClientFanout.js');
    if (!this.ownsPipelineEffective()) {
      const summary = summarizeFanoutResult({ attempted: false });
      this.last_client_fanout = summary;
      const { saveClientFanoutSummary } = await import('./masterClientFanout.js');
      saveClientFanoutSummary(summary);
      return summary;
    }
    try {
      const { executeMasterOwnedFanout } = await import(
        '../services/intentFanout.js'
      );
      const intent = buildMasterFanoutIntent({
        epic: this.epic,
        side: input.side,
        intent_id: input.intent_id,
        reference_price: input.reference_price,
        regime: input.regime,
        setup_type: input.setup_type,
      });
      const fanout = await executeMasterOwnedFanout(intent);
      const journaled = journalMasterFanoutFills({
        journal: this.pipeline.journal,
        mode: this.cfg.mode,
        epic: this.epic,
        side: input.side,
        intent_id: input.intent_id,
        decision: this.last_decision,
        fills: fanout.executed,
      });
      for (const rec of journaled) {
        this.trackPersist('opportunity', persistOpportunity(rec));
        logTradeEvent({
          event: 'OPEN',
          broker: 'CAPITAL',
          epic: this.epic,
          side: input.side,
          volume: rec.risk.volume,
          price: rec.execution?.fill_price ?? null,
          position_id: null,
          intent_id: rec.execution?.intent_id || null,
          opportunity_id: rec.id,
          desk_entry_source: rec.decision?.desk_entry_source,
          ok: true,
          detail: rec.execution?.detail || 'client_fanout',
        });
      }
      const summary = summarizeFanoutResult({
        attempted: true,
        subscribers: fanout.subscribers,
        executed: fanout.executed,
        journaled_count: journaled.length,
      });
      this.last_client_fanout = summary;
      const { saveClientFanoutSummary } = await import('./masterClientFanout.js');
      saveClientFanoutSummary(summary);
      if (fanout.subscribers > 0) {
        this.last_execution_detail = `${this.last_execution_detail || 'open'};client_fanout=${summary.detail}`.slice(
          0,
          400
        );
      }
      return summary;
    } catch (err) {
      const summary = summarizeFanoutResult({
        attempted: true,
        error: err instanceof Error ? err.message : String(err),
      });
      this.last_client_fanout = summary;
      const { saveClientFanoutSummary } = await import('./masterClientFanout.js');
      saveClientFanoutSummary(summary);
      return summary;
    }
  }

  /**
   * Client fanout manage-only close → MASTER journal attach.
   * Does not touch PositionManager (Client lots stay on Client Capital accounts).
   * PnL stays unproven unless a future Capital confirm path sets proven.
   */
  recordFanoutClientClose(input: {
    opportunity_id: string;
    position_id: string | null;
    epic: string;
    side: string | null;
    volume: number | null;
    entry: number | null;
    exit: number | null;
    reason: string;
    ok: boolean;
    detail?: string | null;
    mae?: number;
    mfe?: number;
    hold_ms?: number;
  }): { journaled: boolean; booked: boolean } {
    if (!this.ownsPipelineEffective()) {
      return { journaled: false, booked: false };
    }
    const oppId = String(input.opportunity_id || '').trim();
    if (!oppId) return { journaled: false, booked: false };

    const detail = `FANOUT_CLIENT · ${input.reason}${
      input.detail ? ` · ${input.detail}` : ''
    }`.slice(0, 400);
    const fanoutOpp = this.pipeline.journal.opportunities.find((o) => o.id === oppId);
    logTradeEvent({
      event: 'CLOSE',
      broker: 'CAPITAL',
      epic: input.epic,
      side: input.side,
      volume: input.volume,
      price: input.exit,
      position_id: input.position_id,
      opportunity_id: oppId,
      desk_entry_source: fanoutOpp?.decision?.desk_entry_source,
      ok: input.ok,
      detail,
    });
    if (!input.ok) {
      this.last_close_failed = {
        position_id: input.position_id || oppId,
        exit_reason: input.reason,
        detail: input.detail || 'fanout_client_close_fail',
        ts: new Date().toISOString(),
      };
      return { journaled: true, booked: false };
    }

    const opp = this.pipeline.journal.opportunities.find((o) => o.id === oppId);
    const entryFromOpp =
      opp?.execution?.fill_price != null && Number.isFinite(opp.execution.fill_price)
        ? Number(opp.execution.fill_price)
        : null;
    const volFromOpp =
      opp?.risk.volume != null && Number.isFinite(opp.risk.volume)
        ? Number(opp.risk.volume)
        : null;
    const outcome = buildFanoutCloseOutcome({
      opportunity_id: oppId,
      position_id: input.position_id,
      epic: input.epic,
      side: input.side,
      volume: input.volume ?? volFromOpp,
      entry: input.entry ?? entryFromOpp,
      exit: input.exit,
      reason: input.reason,
      mae: input.mae,
      mfe: input.mfe,
      hold_ms: input.hold_ms,
    });
    const decision: MasterDecision =
      opp?.decision ??
      ({
        decision_id: oppId,
        kind: outcome.side,
        side: outcome.side,
        score: 0,
        block_reason: null,
        buy: { score: 0 } as never,
        sell: { score: 0 } as never,
        analysis: {
          regime: 'RANGE',
          market_state: 'fanout',
          momentum_score: 0,
          momentum_dir: 'NEUTRAL',
          trend_dir: 'SIDEWAYS',
          trend_strength: 0,
          structure_bias: 'NEUTRAL',
          swing_high: outcome.entry,
          swing_low: outcome.entry,
          buy_pressure: 0.5,
          sell_pressure: 0.5,
          behavior_bull: 0.5,
          behavior_bear: 0.5,
          impact_score: 0.5,
          context_quality: 0.5,
          volatility: 0.001,
          atr: 1,
          data_quality: 0.5,
          session: 'LONDON',
        } as never,
        expectancy: null,
      } as MasterDecision);

    this.pipeline.recordTradeClose(oppId, decision, outcome, {
      epic: input.epic,
    });
    const sk = decision.side
      ? setupKey(
          decision.analysis,
          decision.side,
          input.epic,
          decision.desk_entry_source
        )
      : null;
    this.trackPersist('outcome', persistOutcome(oppId, outcome, sk));
    this.last_exit_reason = outcome.exit_reason;
    this.last_close_failed = null;
    return { journaled: true, booked: true };
  }

  /** Desk tick reports who owns exits (avoids deskBridge↔runtime import cycle). */
  setDeskManageOwnerHint(owner: 'MASTER' | 'DESK_DEFERRED_HARD' | 'DESK') {
    this.desk_manage_owner_hint = owner;
  }

  /**
   * Operator-facing manage owner. Prefers last desk hint; else derives from
   * owns-pipeline + Capital LIVE attach + MASTER_LIVE_ENABLED + venue opens.
   */
  resolveManageOwnerStatus(): 'MASTER' | 'DESK_DEFERRED_HARD' | 'DESK' {
    if (this.desk_manage_owner_hint) return this.desk_manage_owner_hint;
    if (!this.ownsPipelineEffective()) return 'DESK';
    if (this.cfg.mode === 'LIVE' && this.broker?.name === 'CAPITAL') {
      return 'MASTER';
    }
    if (process.env.MASTER_LIVE_ENABLED === 'true') return 'DESK_DEFERRED_HARD';
    if (this.capitalVenueOpens > 0) return 'DESK_DEFERRED_HARD';
    if (this.broker != null) return 'MASTER';
    return 'DESK_DEFERRED_HARD';
  }

  /**
   * Desk hard-protective close while owns_pipeline (DESK_DEFERRED_HARD):
   * write MASTER trade journal + last_exit so dashboard/journal stage stay honest.
   * If a local ManagedPosition matches dealId/epic, book the outcome (pnl unproven).
   */
  recordDeskOwnedClose(input: {
    position_id: string | null;
    epic: string;
    side: string | null;
    volume: number | null;
    exit: number | null;
    reason: string;
    ok: boolean;
    detail?: string | null;
  }): { journaled: boolean; booked_local: boolean } {
    if (!this.ownsPipelineEffective()) {
      return { journaled: false, booked_local: false };
    }
    const detail = `DESK_DEFERRED_HARD · ${input.reason}${
      input.detail ? ` · ${input.detail}` : ''
    }`;
    logTradeEvent({
      event: 'CLOSE',
      broker: 'CAPITAL',
      epic: input.epic,
      side: input.side,
      volume: input.volume,
      price: input.exit,
      position_id: input.position_id,
      ok: input.ok,
      detail,
    });
    if (!input.ok) {
      this.last_close_failed = {
        position_id: input.position_id || 'desk',
        exit_reason: input.reason,
        detail: input.detail || 'desk_close_fail',
        ts: new Date().toISOString(),
      };
      this.setDeskManageOwnerHint('DESK_DEFERRED_HARD');
      return { journaled: true, booked_local: false };
    }
    this.last_exit_reason = `DESK_HARD · ${input.reason}`;
    this.last_close_failed = null;
    this.setDeskManageOwnerHint('DESK_DEFERRED_HARD');

    const epicKey = String(input.epic || '')
      .trim()
      .toUpperCase();
    const pos =
      (input.position_id && this.positions.get(input.position_id)) ||
      this.positions
        .list()
        .find((p) => String(p.epic || '').trim().toUpperCase() === epicKey) ||
      null;
    if (!pos) return { journaled: true, booked_local: false };

    const exitPx =
      input.exit != null && Number.isFinite(input.exit) ? Number(input.exit) : pos.entry;
    const holdMs = pos.entry_at
      ? Math.max(0, Date.now() - Date.parse(pos.entry_at))
      : 0;
    const outcome: TradeOutcome = {
      position_id: pos.position_id,
      side: pos.side,
      entry: pos.entry,
      exit: exitPx,
      volume: pos.size,
      pnl: 0,
      fees: 0,
      slippage: 0,
      mae: pos.mae,
      mfe: pos.mfe,
      r_multiple: 0,
      hold_ms: holdMs,
      exit_reason: `DESK_HARD · ${input.reason}`,
      pnl_proven: false,
    };
    this.pipeline.recordTradeClose(pos.opportunity_id, pos.decision, outcome, {
      epic: pos.epic,
    });
    this.positions.drop(pos.position_id);
    const sk = pos.decision?.side
      ? setupKey(
          pos.decision.analysis,
          pos.decision.side,
          pos.epic,
          pos.decision.desk_entry_source
        )
      : null;
    this.trackPersist('outcome', persistOutcome(pos.opportunity_id, outcome, sk));
    this.trackPersist('open_positions', saveOpenPositions(this.positions.list()));
    this.account.open_positions = this.positions.count();
    return { journaled: true, booked_local: true };
  }

  /**
   * Capital LIVE single-owner: default-on when unset; refuse when operator
   * explicitly turned owns_pipeline OFF (dual-brain with Robot Desk).
   */
  ensureOwnsPipelineForCapitalLive(): { ok: true } | { ok: false; detail: string } {
    if (this.owns_pipeline_pref === false) {
      return {
        ok: false,
        detail:
          'LIVE refused — MASTER owns_pipeline is OFF (dual-brain with Robot Desk). Turn Owns ON first.',
      };
    }
    if (!this.ownsPipelineEffective()) {
      this.setOwnsPipeline(true);
    }
    return { ok: true };
  }

  hydrateOwnsPipelinePref() {
    const pref = loadOwnsPipelinePref();
    if (pref != null) this.owns_pipeline_pref = pref;
  }

  /** Live regime/analysis for orphan adopt BestOutcome locks. */
  private liveAdoptContext(): {
    live_regime?: string | null;
    live_analysis?: {
      regime?: string;
      trend_dir?: string;
      structure_bias?: string;
    } | null;
  } {
    const a = this.last_decision?.analysis;
    if (!a) return {};
    return {
      live_regime: a.regime,
      live_analysis: {
        regime: a.regime,
        trend_dir: a.trend_dir,
        structure_bias: a.structure_bias,
      },
    };
  }

  /** Seed monitoring snapshot for dashboard before Start/Recover. */
  ensureMonitorHydrated() {
    if (this.monitorHydrated) return;
    this.monitor.hydrateFromDisk();
    this.monitorHydrated = true;
  }

  hydrateMonitorFromDisk() {
    this.monitor.hydrateFromDisk();
    this.monitorHydrated = true;
  }

  /**
   * Open-book UTC day-roll may seed day_start_equity only from a live mark.
   * Missing, disk_cache, or age > stale_quote_ms → unproven (defer roll).
   */
  private quoteProvenForOpenDayRoll(
    quote: Quote | null | undefined,
    nowMs = Date.now()
  ): boolean {
    if (!quote) return false;
    if (this.quoteFromDiskCache) return false;
    const staleMs = Math.max(0, Number(this.cfg.stale_quote_ms) || 0);
    if (staleMs > 0) {
      const ts = Number(quote.ts_ms);
      if (!Number.isFinite(ts) || ts <= 0) return false;
      if (nowMs - ts > staleMs) return false;
    }
    return true;
  }

  /**
   * UTC day-roll must not seal/wipe day_start until the venue baseline is proven.
   * Capital LIVE: wait for capitalAccountProven (never zero restored day_start).
   * Paper: wait for live mark when opens exist (parity with quoteProvenForOpenDayRoll).
   */
  private shouldDeferUtcDayRoll(
    quote: Quote | null | undefined = this.last_quote
  ): boolean {
    if (this.broker instanceof CapitalBroker && !this.broker.paper) {
      return !this.capitalAccountProven;
    }
    return (
      this.positions.count() > 0 && !this.quoteProvenForOpenDayRoll(quote)
    );
  }

  /**
   * Credit a proven close into daily_pnl. When the sealed day lags calendar today
   * (UTC day-roll deferred), also park the PnL so post-roll rebuild keeps it.
   */
  private creditClosedDailyPnl(pnl: number) {
    this.account.daily_pnl += pnl;
    const today = new Date().toISOString().slice(0, 10);
    if (this.account.daily_pnl_day && this.account.daily_pnl_day !== today) {
      this.pendingCalendarDayClosedPnl += pnl;
    }
  }

  /** Roll daily_pnl at UTC day boundary; seed day_start_equity for max_daily_loss. */
  private rollDailyPnl(nowMs = Date.now()): boolean {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (this.account.daily_pnl_day !== day) {
      // Capital LIVE unproven: do not advance day or wipe restored day_start —
      // first prove + later roll seeds from venue equity (never paper £10k).
      if (
        this.broker instanceof CapitalBroker &&
        !this.broker.paper &&
        !this.capitalAccountProven
      ) {
        return false;
      }
      // Restore closes that landed during the defer window (calendar today while
      // daily_pnl_day was still yesterday). Live paths park via creditClosedDailyPnl;
      // hydrate/recover rebuild pending from journal before the first live roll.
      const pendingToday = this.pendingCalendarDayClosedPnl;
      this.pendingCalendarDayClosedPnl = 0;
      this.account.daily_pnl = pendingToday;
      this.account.daily_pnl_day = day;
      if (this.broker instanceof CapitalBroker && !this.broker.paper) {
        this.account.day_start_equity =
          this.account.equity > 0 ? this.account.equity : this.account.balance;
        this.capitalDayGatesSeeded = true;
      } else {
        this.account.day_start_equity =
          this.account.equity > 0 ? this.account.equity : this.account.balance;
      }
      this.persistRuntimeGates();
      return true;
    }
    return false;
  }

  /** Persist cooldowns + equity baselines so restart keeps daily $ gates honest. */
  private persistRuntimeGates() {
    const existing = loadRuntimeGates();
    const capitalAttached =
      this.broker instanceof CapitalBroker && !this.broker.paper;
    // Session setters (mode/epic/entries) must not clobber proven Capital day/peak
    // with unproven zeros before equity is seeded.
    let dayStart = this.account.day_start_equity ?? null;
    let peak = this.account.peak_equity;
    let seeded = this.capitalDayGatesSeeded;
    let day = this.account.daily_pnl_day ?? null;
    let streak = this.account.consecutive_losses;
    if (capitalAttached && !this.capitalDayGatesSeeded && existing) {
      if (existing.day_start_equity != null && existing.day_start_equity > 0) {
        dayStart = existing.day_start_equity;
      }
      if (existing.peak_equity != null && existing.peak_equity > 0) {
        peak = Math.max(peak || 0, existing.peak_equity);
      }
      if (existing.capital_day_gates_seeded === true) {
        seeded = true;
      }
      if (existing.daily_pnl_day) day = existing.daily_pnl_day;
      if (existing.consecutive_losses != null) {
        streak = Math.max(streak || 0, existing.consecutive_losses);
      }
    } else if (existing?.peak_equity != null && peak != null) {
      peak = Math.max(peak, existing.peak_equity);
    }
    this.trackPersist(
      'runtime_gates',
      Promise.resolve(
        saveRuntimeGates({
          last_loss_ms: this.last_loss_ms,
          reject_until_ms: this.reject_until_ms,
          inflight_until_ms: this.inflight_until_ms,
          post_exit_until_ms: this.post_exit_until_ms,
          last_entry_fingerprint: this.last_entry_fingerprint,
          day_start_equity: dayStart,
          peak_equity: peak,
          daily_pnl_day: day,
          consecutive_losses: streak,
          capital_day_gates_seeded: seeded,
          last_ai_allow_close: this.last_ai_allow_close,
          ai_mode: this.cfg.ai_mode,
          kill_switch: this.cfg.kill_switch,
          mode: this.cfg.mode,
          epic: this.epic,
          entries_armed: this.entries_armed,
          entries_pause_reason: this.entries_pause_reason,
          last_close_failed: this.last_close_failed,
          desired_running: this.desired_running,
        })
      )
    );
  }

  /** Journal stubs for broker orphans + synthetic flat for local ghosts after sync. */
  private async applySyncJournal(
    sync: Awaited<ReturnType<typeof syncPositionsWithBroker>>,
    quote?: Quote
  ) {
    const capitalLive =
      this.broker instanceof CapitalBroker && !(this.broker.paper ?? false);
    for (const ghost of sync.orphans_local) {
      // Paper VS-System auto SL/TP: prefer venue fill + STOP_HIT/TP_HIT over broker_flat
      const paperAuto =
        this.broker instanceof PaperBroker
          ? this.broker.takeRecentAutoFill(ghost.position_id)
          : null;
      const mark = quote
        ? ghost.side === 'BUY'
          ? quote.bid
          : quote.ask
        : ghost.entry;
      const { exit } = resolveCloseExitFill({
        fill_price: paperAuto?.fill_price ?? null,
        mark,
        entry: ghost.entry,
        capitalLive,
      });
      const instrument = specForEpic(ghost.epic);
      const priced = priceResolvedCloseMoney({
        ...resolveCloseMoneyPnl({
          side: ghost.side,
          entry: ghost.entry,
          fill: exit,
          size: ghost.size,
          value_per_point_per_lot: instrument.value_per_point_per_lot,
          // Prefer paper auto-fill net pnl; else last non-zero broker UPL
          fill_pnl:
            paperAuto?.fill_pnl != null && Number.isFinite(paperAuto.fill_pnl)
              ? Number(paperAuto.fill_pnl)
              : usableBrokerUpl(ghost.broker_upl),
          capitalLive,
        }),
        volume: ghost.size,
      });
      const flatReason = paperAuto?.reason ?? 'broker_flat';
      const r_multiple = rMultipleFromClose({
        entry: ghost.entry,
        stop_loss: ghost.stop_loss,
        pnl_pts: priced.pnl_pts,
      });
      const outcome = {
        position_id: ghost.position_id,
        side: ghost.side,
        entry: ghost.entry,
        exit,
        volume: ghost.size,
        pnl: priced.pnl,
        fees: priced.fees,
        pnl_proven: priced.pnl_proven,
        slippage: 0,
        mae: ghost.mae,
        mfe: ghost.mfe,
        r_multiple,
        hold_ms: Date.now() - new Date(ghost.entry_at).getTime(),
        exit_reason: capitalCloseExitReason(flatReason, priced.pnl_proven),
      };
      const exists = this.pipeline.journal.opportunities.some((o) => o.id === ghost.opportunity_id);
      if (!exists) {
        const stub = this.pipeline.journal.recordOpportunity({
          id: ghost.opportunity_id,
          mode: this.cfg.mode,
          epic: ghost.epic,
          decision: ghost.decision,
          risk: {
            allowed: true,
            volume: ghost.size,
            risk_amount: 0,
            reasons: [flatReason],
          },
          executed: true,
          execution: {
            accepted: true,
            intent_id: ghost.intent_id,
            order_id: null,
            fill_price: ghost.entry,
            detail: paperAuto?.detail ?? 'broker_flat',
            paper: this.broker?.paper ?? true,
          },
        });
        this.trackPersist('ghost_stub', persistOpportunity(stub));
      }
      this.pipeline.recordTradeClose(ghost.opportunity_id, ghost.decision, outcome, {
        epic: ghost.epic,
      });
      this.last_exit_reason = outcome.exit_reason;
      if (priced.pnl_proven) {
        this.creditClosedDailyPnl(outcome.pnl);
        if (outcome.pnl < 0) {
          this.account.consecutive_losses += 1;
          this.last_loss_ms = Date.now();
          this.persistRuntimeGates();
        } else {
          this.account.consecutive_losses = 0;
        }
      }
      const sk = ghost.decision?.side
        ? setupKey(
            ghost.decision.analysis,
            ghost.decision.side,
            ghost.epic,
            ghost.decision.desk_entry_source
          )
        : null;
      this.trackPersist(
        'outcome',
        persistOutcome(ghost.opportunity_id, outcome, sk)
      );
      logTradeEvent({
        event: 'CLOSE',
        broker: this.broker?.name || 'UNKNOWN',
        epic: ghost.epic,
        side: ghost.side,
        volume: ghost.size,
        price: exit,
        position_id: ghost.position_id,
        intent_id: ghost.intent_id,
        opportunity_id: ghost.opportunity_id,
        desk_entry_source: ghost.decision?.desk_entry_source,
        ok: true,
        detail: outcome.exit_reason,
        ...(outcome.pnl_proven !== false
          ? { pnl: outcome.pnl, fees: outcome.fees }
          : {}),
      });
    }
    // Reader EXTERNAL_PARTIAL_CLOSE — journal closed slice when broker size shrinks
    for (const partial of sync.external_partials || []) {
      const instrument = specForEpic(partial.epic);
      const mark = quote
        ? partial.side === 'BUY'
          ? quote.bid
          : quote.ask
        : partial.mark_proxy;
      const { exit, fill_proven: _fp } = resolveCloseExitFill({
        fill_price: null,
        mark,
        entry: partial.entry,
        capitalLive,
      });
      const priced = priceResolvedCloseMoney({
        ...resolveCloseMoneyPnl({
          side: partial.side,
          entry: partial.entry,
          fill: exit,
          size: partial.closed_size,
          value_per_point_per_lot: instrument.value_per_point_per_lot,
          fill_pnl: usableBrokerUpl(partial.broker_upl_closed),
          capitalLive,
        }),
        volume: partial.closed_size,
      });
      const outcome = {
        position_id: partial.position_id,
        side: partial.side,
        entry: partial.entry,
        exit,
        volume: partial.closed_size,
        pnl: priced.pnl,
        fees: priced.fees,
        pnl_proven: priced.pnl_proven,
        slippage: 0,
        mae: partial.mae,
        mfe: partial.mfe,
        r_multiple: rMultipleFromClose({
          entry: partial.entry,
          stop_loss: partial.stop_loss,
          pnl_pts: priced.pnl_pts,
        }),
        hold_ms: 0,
        exit_reason: capitalCloseExitReason(
          'EXTERNAL_PARTIAL_CLOSE',
          priced.pnl_proven
        ),
      };
      const exists = this.pipeline.journal.opportunities.some(
        (o) => o.id === partial.opportunity_id
      );
      if (!exists) {
        const stub = this.pipeline.journal.recordOpportunity({
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
        this.trackPersist('external_partial_stub', persistOpportunity(stub));
      }
      this.pipeline.recordTradeClose(partial.opportunity_id, partial.decision, outcome, {
        epic: partial.epic,
      });
      if (priced.pnl_proven) {
        this.creditClosedDailyPnl(outcome.pnl);
        if (outcome.pnl < 0) {
          this.account.consecutive_losses += 1;
          this.last_loss_ms = Date.now();
          this.persistRuntimeGates();
        } else {
          this.account.consecutive_losses = 0;
        }
      }
      const sk = partial.decision?.side
        ? setupKey(
            partial.decision.analysis,
            partial.decision.side,
            partial.epic,
            partial.decision.desk_entry_source
          )
        : null;
      this.trackPersist(
        'external_partial',
        persistOutcome(partial.opportunity_id, outcome, sk)
      );
      logTradeEvent({
        event: 'CLOSE',
        broker: this.broker?.name || 'UNKNOWN',
        epic: partial.epic,
        side: partial.side,
        volume: partial.closed_size,
        price: exit,
        position_id: partial.position_id,
        intent_id: partial.intent_id,
        opportunity_id: partial.opportunity_id,
        desk_entry_source: partial.decision?.desk_entry_source,
        ok: true,
        detail: outcome.exit_reason,
        ...(outcome.pnl_proven !== false
          ? { pnl: outcome.pnl, fees: outcome.fees }
          : {}),
      });
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
    // Sync-ghost / external-partial closes move venue equity (paper auto-fill)
    // without manage/manual close — settle like manage: post-exit cool + full
    // venue account snapshot (Capital prove / trade gate parity with manageOnly).
    const syncClosed =
      (sync.orphans_local?.length || 0) + (sync.external_partials?.length || 0);
    if (syncClosed > 0) {
      const cool = Math.max(0, this.cfg.post_exit_cooldown_ms || 0);
      this.post_exit_until_ms = Math.max(
        this.post_exit_until_ms,
        Date.now() + cool
      );
      this.persistRuntimeGates();
      if (this.broker) {
        try {
          const acct = await this.broker.getAccount();
          await this.applyVenueAccountSnapshot(this.broker, acct, quote);
        } catch {
          /* keep */
        }
      }
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

  /**
   * Refresh public secondary mids (Orbit/READER) for feed_divergent validation.
   * Cached ~15s so Capital ticks do not hammer public endpoints every cycle.
   */
  async refreshPublicReferenceMids(
    epic = this.epic,
    force = false
  ): Promise<number[]> {
    const now = Date.now();
    if (
      !force &&
      this.lastPublicReferenceMids &&
      now - this.lastPublicReferenceAtMs < 15_000
    ) {
      return this.lastPublicReferenceMids;
    }
    try {
      const { fetchLiveMarket } = await import('./liveFeed.js');
      const snap = await fetchLiveMarket(epic);
      const mids = (snap.mids || []).filter(
        (m) => typeof m === 'number' && Number.isFinite(m)
      );
      this.lastPublicReferenceMids = mids.length ? mids : null;
      this.lastPublicReferenceAtMs = now;
      return mids;
    } catch {
      return this.lastPublicReferenceMids || [];
    }
  }

  /** Attach broker — PAPER uses in-memory PaperBroker by default. */
  attachBroker(broker: MasterBroker) {
    if (
      this.broker instanceof CapitalBroker &&
      this.broker !== broker
    ) {
      this.broker.stopMarketStream();
    }
    this.broker = broker;
    // MT4: align desk epic to EA chart Symbol() when aliases match (GOLD→XAUUSD)
    if (broker instanceof Mt4FileBroker) {
      this.syncEpicFromMt4Chart(broker);
    }
    // Capital: normalize XAUUSD→GOLD (API epic) so quote/open/stream share one id
    if (broker instanceof CapitalBroker) {
      this.setEpic(this.epic);
      // Fail-closed until first successful equity read — Start LIVE must not
      // advertise LIVE_RUNNING / proven before getAccount proves preferred CFD.
      if (!broker.paper) {
        this.capitalAccountProven = false;
        this.capitalDayGatesSeeded = false;
        this.capitalVenueOpens = 0;
        this.capitalVenueOpensProven = false;
        // Drop paper £10k sizing / day gates / journal-poisoned daily money
        this.account.equity = 0;
        this.account.balance = 0;
        this.account.day_start_equity = 0;
        this.account.peak_equity = 0;
        this.account.daily_pnl = 0;
        this.account.consecutive_losses = 0;
        this.account.available_to_deal = null;
        this.account.trade_allowed = false;
      }
    } else {
      this.capitalDayGatesSeeded = false;
    }
    if (!(broker instanceof CapitalBroker) || broker.paper) {
      this.capitalVenueOpens = 0;
      this.capitalVenueOpensProven = true;
    }
  }

  /**
   * Record Capital credential source from resolve/attach detail so status can
   * show Brokers-DB readiness when CAPITAL_* env is empty.
   */
  noteCapitalCredentialSource(detail: string | null | undefined) {
    const d = String(detail || '');
    if (/capital_desk/i.test(d)) this.capitalDeskCredsSeen = true;
  }

  private capitalLiveAttached(): boolean {
    return (
      this.broker?.name === 'CAPITAL' &&
      this.cfg.mode === 'LIVE' &&
      !this.broker.paper
    );
  }

  /** True when Capital non-paper broker is attached (mode may still be PAPER until set). */
  capitalBrokerAttached(): boolean {
    return this.broker?.name === 'CAPITAL' && !this.broker.paper;
  }

  private capitalCredentialSource(): 'env' | 'desk' | null {
    if (capitalEnvPresent()) return 'env';
    if (this.capitalDeskCredsSeen) return 'desk';
    return null;
  }

  /** Check- parity: OrderSend uses chart symbol; keep runtime epic in sync. */
  private syncEpicFromMt4Chart(broker: Mt4FileBroker) {
    const chart = broker.chartSymbol();
    if (chart && epicsMatch(chart, this.epic) && chart !== this.epic) {
      this.setEpic(chart);
    }
  }

  /** Capital quote epic (GOLD) wins over MT4-style aliases when they match. */
  private syncEpicFromCapitalQuote(q: { epic?: string | null }) {
    const api = String(q.epic || '').trim();
    if (api && epicsMatch(api, this.epic) && api !== this.epic) {
      this.setEpic(api);
    }
  }

  ensurePaperBroker(): PaperBroker {
    this.broker = this.paperBroker;
    return this.paperBroker;
  }

  /**
   * Refuse detaching Capital while LIVE deals remain — Start PAPER must not
   * stop the Capital stream with unmanaged venue risk. Prove against venue
   * list (not local book alone): orphans / pre-recover gaps can empty local
   * while Capital still has opens.
   */
  async refuseDetachCapitalWithOpens(): Promise<
    { ok: true } | { ok: false; detail: string }
  > {
    const b = this.broker;
    if (!b || b.name !== 'CAPITAL' || b.paper) {
      this.capitalVenueOpens = 0;
      this.capitalVenueOpensProven = true;
      return { ok: true };
    }
    const local = this.positions.count();
    const listed = await b.listOpenPositions();
    if (!listed.ok) {
      this.capitalVenueOpensProven = false;
      return {
        ok: false,
        detail: `refuse_paper_capital_list_unproven:${listed.detail || 'list_failed'} — cannot prove Capital flat`,
      };
    }
    const venueIds = new Set<string>();
    for (const p of listed.positions) {
      if (p.position_id) venueIds.add(p.position_id);
    }
    for (const id of listed.presence_ids ?? []) {
      if (id) venueIds.add(id);
    }
    const venue = venueIds.size;
    this.capitalVenueOpens = venue;
    this.capitalVenueOpensProven = true;
    const opens = Math.max(local, venue);
    if (opens > 0) {
      return {
        ok: false,
        detail: `refuse_paper_with_capital_opens:${opens} (local=${local} venue=${venue}) — Flatten all first`,
      };
    }
    return { ok: true };
  }

  /** Refresh Capital venue open count for dashboard / status honesty. */
  async refreshCapitalVenueOpens(): Promise<number> {
    const b = this.broker;
    if (!b || b.name !== 'CAPITAL' || b.paper) {
      this.capitalVenueOpens = 0;
      this.capitalVenueOpensProven = true;
      return 0;
    }
    const listed = await b.listOpenPositions();
    if (!listed.ok) {
      this.capitalVenueOpensProven = false;
      return this.capitalVenueOpens;
    }
    const venueIds = new Set<string>();
    for (const p of listed.positions) {
      if (p.position_id) venueIds.add(p.position_id);
    }
    for (const id of listed.presence_ids ?? []) {
      if (id) venueIds.add(id);
    }
    this.capitalVenueOpens = venueIds.size;
    this.capitalVenueOpensProven = true;
    return this.capitalVenueOpens;
  }

  /** Drop stale venue UPL + soft/native trail arm so money exits cannot fire on unread Capital book. */
  private clearStaleBrokerUpl() {
    for (const p of this.positions.list()) {
      p.broker_upl = null;
      p.soft_trail_armed_at = null;
      p.soft_trail_peak = null;
      p.native_trail_armed = false;
    }
  }

  /**
   * Flat + post-exit elapsed → clear sticky fingerprint (VS lastFingerprint).
   * manageOnly must mirror full tick so Stop-with-opens does not persist a spent
   * GOLD:BUY fingerprint across restart when no later full tick runs.
   */
  private clearSpentEntryFingerprint(): void {
    if (
      this.positions.count() === 0 &&
      Date.now() >= this.post_exit_until_ms &&
      this.last_entry_fingerprint
    ) {
      this.last_entry_fingerprint = null;
      this.persistRuntimeGates();
    }
  }

  /**
   * After manage closes: copy venue equity/balance and raise peak_equity.
   * Same-tick risk + manageOnly Peak eq KPI must not lag.
   * Also copies currency / available_to_deal / trade_allowed when the venue
   * returns them (Stop-with-opens must not leave Available/Tradeable stale).
   */
  private applyVenueAccountAfterClose(acct: {
    equity: number;
    balance: number;
    currency?: string;
    available?: number | null;
    trade_allowed?: boolean | null;
  }): void {
    if (!(acct && acct.equity > 0 && Number.isFinite(acct.equity))) return;
    this.account.equity = acct.equity;
    this.account.balance = acct.balance;
    if (acct.currency) this.account.currency = acct.currency;
    this.account.available_to_deal =
      acct.available != null && Number.isFinite(acct.available)
        ? acct.available
        : this.account.available_to_deal ?? null;
    if (typeof acct.trade_allowed === 'boolean') {
      this.account.trade_allowed = acct.trade_allowed;
    }
    const prevPeak = this.account.peak_equity;
    const prevDayStart = this.account.day_start_equity;
    this.account.peak_equity = Math.max(
      Number(this.account.peak_equity) || 0,
      acct.equity
    );
    if (!this.account.day_start_equity) {
      this.account.day_start_equity = acct.equity;
    }
    if (
      this.account.peak_equity !== prevPeak ||
      this.account.day_start_equity !== prevDayStart
    ) {
      this.persistRuntimeGates();
    }
  }

  /**
   * Full-tick / manageOnly venue account snapshot — equity fields plus Capital
   * prove, first-prove day/peak seed, and market trade gate (parity with tick).
   */
  private async applyVenueAccountSnapshot(
    broker: MasterBroker,
    acct: {
      equity: number;
      balance: number;
      currency?: string;
      available?: number | null;
      trade_allowed?: boolean | null;
    } | null,
    quote?: { market_status?: string | null }
  ): Promise<void> {
    let capitalAccountUnproven = false;
    if (acct && acct.equity > 0 && Number.isFinite(acct.equity)) {
      if (broker instanceof CapitalBroker && !broker.paper) {
        this.account.equity = acct.equity;
        this.account.balance = acct.balance;
        if (acct.currency) this.account.currency = acct.currency;
        this.account.available_to_deal =
          acct.available != null && Number.isFinite(acct.available)
            ? acct.available
            : this.account.available_to_deal ?? null;
        if (typeof acct.trade_allowed === 'boolean') {
          this.account.trade_allowed = acct.trade_allowed;
        }
        this.capitalAccountProven = true;
        const prevPeak = this.account.peak_equity;
        const prevDayStart = this.account.day_start_equity;
        if (!this.capitalDayGatesSeeded) {
          // First proven Capital equity — seed day/peak (never keep paper £10k)
          this.account.day_start_equity = acct.equity;
          this.account.peak_equity = acct.equity;
          this.capitalDayGatesSeeded = true;
        } else {
          this.account.peak_equity = Math.max(
            this.account.peak_equity,
            acct.equity
          );
        }
        if (
          this.account.peak_equity !== prevPeak ||
          this.account.day_start_equity !== prevDayStart
        ) {
          this.persistRuntimeGates();
        }
      } else {
        // Paper / non-Capital: raise peak; seed day_start when missing
        this.applyVenueAccountAfterClose(acct);
      }
    } else if (broker instanceof CapitalBroker && !broker.paper) {
      // Fail-closed: never size LIVE from leftover equity when Capital unread
      capitalAccountUnproven = true;
      this.capitalAccountProven = false;
      this.account.equity = 0;
      this.account.balance = 0;
      this.account.available_to_deal = null;
      this.account.trade_allowed = false;
      this.broker_detail = `${this.broker_detail || ''};capital_account_unproven`.slice(
        -400
      );
    }

    // Capital: fail-closed marketStatus (full tick + manageOnly Stop-with-opens)
    if (broker instanceof CapitalBroker) {
      const { capitalMarketAllowsTrading } = await import('./capitalMarket.js');
      const status =
        quote?.market_status ?? broker.cachedMarketStatus(this.epic);
      this.account.trade_allowed =
        capitalMarketAllowsTrading(status) && !capitalAccountUnproven;
    }
  }

  /** Status with a fresh Capital venue list when Capital LIVE is attached. */
  async statusAsync(): Promise<MasterStatus> {
    if (!this.recovered && !this.bookHydrated) {
      await this.hydrateBookFromDisk();
    }
    await this.refreshCapitalVenueOpens();
    return this.status();
  }

  /** Stop Capital stream then switch to paper (caller must pass refuseDetachCapitalWithOpens). */
  detachToPaperBroker(): PaperBroker {
    if (this.broker instanceof CapitalBroker) {
      this.broker.stopMarketStream();
    }
    return this.ensurePaperBroker();
  }

  /**
   * Refuse attaching a *different* Capital identity (env/account/api) while venue
   * opens remain — Start LIVE / capital attach must not abandon the prior book.
   * Same-identity re-attach is allowed so LIVE restart can keep managing opens.
   */
  async refuseCapitalIdentitySwap(
    next: MasterBroker
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    const cur = this.broker;
    if (!(cur instanceof CapitalBroker) || cur.paper) return { ok: true };
    if (!(next instanceof CapitalBroker) || next.paper) {
      return this.refuseDetachCapitalWithOpens();
    }
    if (cur.identityKey() === next.identityKey()) return { ok: true };
    const gate = await this.refuseDetachCapitalWithOpens();
    if (!gate.ok) {
      return {
        ok: false,
        detail: `refuse_capital_identity_swap:${gate.detail}`,
      };
    }
    return { ok: true };
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
    this.persistRuntimeGates();
  }

  /**
   * Capital LIVE: pause new entries when structure is not venue OHLC.
   * Clears only our own structure_seed_* pause when seed recovers.
   */
  applyStructureSeedGate(seed_source: string) {
    this.structure_seed_source = seed_source as MasterRuntime['structure_seed_source'];
    const capitalLive =
      this.cfg.mode === 'LIVE' &&
      this.broker?.name === 'CAPITAL' &&
      !(this.broker as { paper?: boolean }).paper;
    if (!capitalLive) return;
    const allowSynthetic =
      !!process.env.VITEST || process.env.MASTER_BROKER_FEED_SYNTHETIC === 'true';
    const ok = capitalLiveEntriesAllowed(seed_source, { allowSynthetic });
    if (!ok) {
      this.setEntriesArmed(false, `structure_seed_not_capital:${seed_source}`);
      return;
    }
    if (this.entries_pause_reason?.startsWith('structure_seed_not_capital')) {
      this.setEntriesArmed(true);
    }
  }

  /**
   * Pure evaluation for dashboard — does not send orders and does not mutate
   * live decision/risk/AI close gates or durable journal (preview must not veto soft exits).
   */
  async evaluate(bars: Bar[], quote: Quote) {
    const instrument = this.resolveInstrument(this.broker, quote);
    const scratch = new MasterPipeline(this.cfg.mode);
    // Share live EV store for gate preview — runCycle only looks up, never records
    (scratch as { expectancy: MasterPipeline['expectancy'] }).expectancy =
      this.pipeline.expectancy;
    const cycle = await scratch.runCycle({
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
      // Preview uses live sticky SETUP so gate matches next real tick
      market_setup: this.pipeline.getMarketSetup(),
    });
    return {
      decision: cycle.decision,
      risk: cycle.risk,
      analysis: cycle.decision.analysis,
      opportunity: cycle.opportunity,
      ai: cycle.ai,
      market_setup: cycle.market_setup,
    };
  }

  /**
   * Reader update_instance_instrument_state — overlay MT4 Point/Digits when EA exports them.
   * Keeps catalog value_per_point_per_lot; only tick size (point) comes from broker.
   */
  private resolveInstrument(
    broker: MasterBroker | null,
    quote?: Quote | null
  ): import('./types.js').InstrumentSpec {
    const base = specForEpic(this.epic);
    const fromQuote =
      quote?.point != null && Number.isFinite(quote.point) && quote.point > 0
        ? Number(quote.point)
        : null;
    const fromMt4 =
      broker instanceof Mt4FileBroker ? broker.instrumentTick()?.point ?? null : null;
    const point = fromQuote ?? fromMt4;
    if (point != null && point > 0 && Math.abs(point - base.point) > 1e-12) {
      return { ...base, point };
    }
    return base;
  }

  /**
   * One authoritative cycle:
   * MARKET → … → DECISION → RISK → EXECUTION → POSITION MANAGE → JOURNAL
   * Serialized — concurrent callers share one chain (live feed + /tick + desk).
   */
  async tick(
    bars: Bar[],
    quote: Quote,
    opts?: {
      reference_mids?: number[] | null;
      hour_bars?: import('../services/capitalCom.js').CapitalPriceCandle[] | Bar[] | null;
      closed_10s?: import('../services/tenSecondOhlc.js').TenSecBar | null;
    }
  ): Promise<TickResult> {
    const run = async () => {
      try {
        return await this.tickUnlocked(bars, quote, opts);
      } catch (e) {
        logMasterError({
          module: 'runtime.tick',
          error_type: 'cycle_failed',
          message: e instanceof Error ? e.message : String(e),
          context: { epic: this.epic, mode: this.cfg.mode },
        });
        throw e;
      }
    };
    const result = this.tickChain.then(run, run);
    this.tickChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async tickUnlocked(
    bars: Bar[],
    quoteIn: Quote,
    opts?: {
      reference_mids?: number[] | null;
      hour_bars?: import('../services/capitalCom.js').CapitalPriceCandle[] | Bar[] | null;
      closed_10s?: import('../services/tenSecondOhlc.js').TenSecBar | null;
    }
  ): Promise<TickResult> {
    const t0 = Date.now();
    // Always stamp runtime epic — public/desk quotes often omit it (news targeting).
    const quote: Quote = { ...quoteIn, epic: quoteIn.epic || this.epic };
    // Interval/desk may replay market_cache marks via tick(last_bars, last_quote).
    // Do not launder disk_cache provenance (or seal day_start) on that replay.
    const replayingDiskMark =
      this.quoteFromDiskCache &&
      this.last_quote != null &&
      Number(quoteIn.ts_ms) === Number(this.last_quote.ts_ms) &&
      Number(quoteIn.mid) === Number(this.last_quote.mid);
    this.last_bars = bars;
    this.last_quote = quote;
    // Live cycle quote/bars — never paint as disk_cache (unless replaying disk mark)
    if (!replayingDiskMark) {
      this.quoteFromDiskCache = false;
      this.barsFromDiskCache = false;
    }
    // Live HOUR refresh via tick opts — clear disk_cache before persist
    if (opts?.hour_bars && opts.hour_bars.length >= 6) {
      this.last_hour_bars = opts.hour_bars.map((b) => ({
        open: Number((b as { open: number }).open),
        high: Number((b as { high: number }).high),
        low: Number((b as { low: number }).low),
        close: Number((b as { close: number }).close),
        ts_ms:
          typeof (b as { ts_ms?: number }).ts_ms === 'number'
            ? Number((b as { ts_ms?: number }).ts_ms)
            : 0,
      }));
      this.hourBarsFromDiskCache = false;
      this.last_hour_bars_detail = 'tick';
    }
    if (opts?.closed_10s) {
      const next = {
        open_time_ms: Number(opts.closed_10s.open_time_ms),
        open: Number(opts.closed_10s.open),
        high: Number(opts.closed_10s.high),
        low: Number(opts.closed_10s.low),
        close: Number(opts.closed_10s.close),
        ticks: Number(opts.closed_10s.ticks) || 1,
      };
      const isNewBucket =
        !this.last_closed_10s ||
        next.open_time_ms !== this.last_closed_10s.open_time_ms;
      this.last_closed_10s = next;
      this.last_closed_10s_present = true;
      // Sticky reuse of disk bar must keep disk_cache until a new 10s bucket closes
      if (isNewBucket) {
        this.closed10sFromDiskCache = false;
        this.closed10sFromJournalOnly = false;
      }
    }
    // Keep hourBarsFromDiskCache until live HOUR refresh replaces hours
    this.persistMarketCache();
    const broker = this.broker || this.ensurePaperBroker();
    if (broker instanceof Mt4FileBroker) {
      this.syncEpicFromMt4Chart(broker);
    }

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
    // BEFORE UTC day-roll so day_start_equity seeds from live MTM/venue equity.
    const acct = await broker.getAccount();
    await this.applyVenueAccountSnapshot(broker, acct, quote);
    // Paper opens: defer UTC day-roll until quote is live (not disk/stale) —
    // interval/desk replay of market_cache marks must not seal day_start_equity
    // and leave max_daily_loss fail-open (parity with manageOnly/hydrate/recover).
    // Capital LIVE: defer until capitalAccountProven (never wipe restored day_start).
    const deferOpenDayRoll = this.shouldDeferUtcDayRoll(quote);
    if (!deferOpenDayRoll) {
      // Roll UTC day before any manage/sync close mutates daily_pnl
      this.rollDailyPnl();
    }

    // Reader relative spread — update history every tick
    if (this.cfg.spread_lookback_bars !== this.spreadLookback) {
      this.spreadLookback = this.cfg.spread_lookback_bars;
      const prev = this.spreadHistory;
      this.spreadHistory = new SpreadHistory(this.spreadLookback);
      // Keep in-memory samples when lookback changes mid-run
      if (prev.size() > 0) {
        const snap = prev.snapshot(quote.spread);
        for (const v of snap.history.slice(0, -1)) this.spreadHistory.push(v);
      } else {
        this.spreadHistory.load();
      }
    }
    const spreadSnap = this.spreadHistory.push(quote.spread);
    this.monitor.noteRelativeSpread(
      spreadSnap.history.length >= 3 ? spreadSnap.relative_spread : null
    );

    // Refresh Forex Factory news calendar cache (VS-System) before entry filters
    await refreshNewsCalendar().catch(() => undefined);
    // Durable high-impact window — survive wipe before next calendar refresh
    {
      const { resolveNewsWindow, rememberHighImpactNewsWindow } = await import(
        './newsGate.js'
      );
      const nw = resolveNewsWindow(Date.now(), this.epic);
      if (
        nw.window_active &&
        nw.impact === 'high' &&
        nw.source !== 'env_filter' &&
        nw.source !== 'env_impact'
      ) {
        rememberHighImpactNewsWindow(nw);
      }
    }

    // 0) Reconcile broker truth / manage exits
    // Paper: manage BEFORE sync so setQuote auto SL/TP is tick-observed
    //   (idempotent close → exits≥1), not only applySyncJournal ghost path.
    // Capital: sync first (venue UPL / empty debounce), then manage.
    const runTickSync = async () => {
      const sync = await syncPositionsWithBroker(
        this.positions,
        broker,
        broker instanceof CapitalBroker ? undefined : this.epic,
        this.emptyBrokerDebounce,
        this.liveAdoptContext()
      );
      // Journal confirmed ghosts/orphans even when other tickets are still in miss-debounce.
      if (!sync.skipped) {
        await this.applySyncJournal(sync, quote);
      }
      // Capital LIVE: successful tick list proves venue open-count; list fail demotes health
      if (broker instanceof CapitalBroker && !broker.paper) {
        if (sync.skipped) {
          this.capitalVenueOpensProven = false;
          // Stale broker_upl must not arm soft-trail / close-all while list unread
          this.clearStaleBrokerUpl();
        } else {
          this.capitalVenueOpensProven = true;
          this.capitalVenueOpens = sync.broker_count;
        }
      }
      return sync;
    };

    this.account.open_positions = this.positions.count();
    const instrument = this.resolveInstrument(broker, quote);

    const runTickManage = async () => {
      // Manage exits — every open epic with its own quote (never SILVER on GOLD mid)
      const managed = await this.runManageAcrossOpenEpics({
        broker,
        quote,
        bars,
      });
      this.last_manage_tick_ms = Date.now();
      const exit_reasons = managed.closed.map((c) => c.reason);
      if (exit_reasons.length) this.last_exit_reason = exit_reasons.at(-1)!;
      if (managed.close_failed.length) {
        const fail = managed.close_failed[0]!;
        this.broker_detail = `close_fail:${fail.position_id}:${fail.detail}`.slice(0, 400);
        if (!exit_reasons.length) {
          this.last_exit_reason = `CLOSE_FAIL · ${fail.exit_reason} · ${fail.detail}`;
        }
        this.last_close_failed = {
          position_id: fail.position_id,
          exit_reason: fail.exit_reason,
          detail: fail.detail,
          ts: new Date().toISOString(),
        };
        for (const failRow of managed.close_failed) {
          logTradeEvent({
            event: 'CLOSE',
            broker: broker.name,
            epic: this.epic,
            side: null,
            volume: null,
            price: null,
            position_id: failRow.position_id,
            ok: false,
            detail: `${failRow.exit_reason} · ${failRow.detail}`,
          });
        }
      }
      for (const c of managed.closed) {
        if (c.outcome.pnl_proven !== false) {
          this.creditClosedDailyPnl(c.outcome.pnl);
          if (c.outcome.pnl < 0) {
            this.account.consecutive_losses += 1;
            this.last_loss_ms = Date.now();
            this.persistRuntimeGates();
          } else {
            this.account.consecutive_losses = 0;
          }
        }
        this.last_close_failed = null;
        const sk = c.position.decision.side
          ? setupKey(
              c.position.decision.analysis,
              c.position.decision.side,
              c.position.epic,
              c.position.decision.desk_entry_source
            )
          : null;
        this.trackPersist(
          'outcome',
          persistOutcome(c.position.opportunity_id, c.outcome, sk)
        );
        logTradeEvent({
          event: 'CLOSE',
          broker: broker.name,
          epic: c.position.epic,
          side: c.position.side,
          volume: c.outcome.volume,
          price: c.outcome.exit,
          position_id: c.position.position_id,
          intent_id: c.position.intent_id,
          opportunity_id: c.position.opportunity_id,
          desk_entry_source: c.position.decision?.desk_entry_source,
          ok: true,
          detail: c.reason,
          ...(c.outcome.pnl_proven !== false
            ? { pnl: c.outcome.pnl, fees: c.outcome.fees }
            : {}),
        });
      }
      // VS-System: after any CLOSE, settle before allowing same-cycle / immediate re-entry
      if (managed.closed.length > 0) {
        const cool = Math.max(0, this.cfg.post_exit_cooldown_ms || 0);
        this.post_exit_until_ms = Math.max(
          this.post_exit_until_ms,
          Date.now() + cool
        );
        this.persistRuntimeGates();
        // Paper venue equity already updated on auto-fill / close — full snapshot
        // (available/trade_allowed + Capital prove), not thinner AfterClose only.
        try {
          const acct = await broker.getAccount();
          await this.applyVenueAccountSnapshot(broker, acct, quote);
        } catch {
          /* keep */
        }
      }
      this.account.open_positions = this.positions.count();
      return managed;
    };

    let managed: Awaited<ReturnType<typeof this.runManageAcrossOpenEpics>>;
    if (broker instanceof PaperBroker) {
      managed = await runTickManage();
      await runTickSync();
    } else {
      await runTickSync();
      this.account.open_positions = this.positions.count();
      managed = await runTickManage();
    }
    const exit_reasons = managed.closed.map((c) => c.reason);
    // Flat + post-exit elapsed → clear sticky fingerprint (VS lastFingerprint)
    this.clearSpentEntryFingerprint();

    // 2) Decision + risk — sticky desk arms from disk/live last when opts omit
    const hourBarsForCycle =
      opts?.hour_bars && opts.hour_bars.length >= 6
        ? opts.hour_bars
        : this.last_hour_bars.length >= 6
          ? this.last_hour_bars
          : null;
    const closed10sForCycle = opts?.closed_10s ?? this.last_closed_10s;
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
      reference_mids: opts?.reference_mids ?? this.lastPublicReferenceMids,
      hour_bars: hourBarsForCycle,
      closed_10s: closed10sForCycle,
    });
    this.last_decision = cycle.decision;
    this.last_risk = cycle.risk;
    this.last_market = {
      ok: cycle.market.ok,
      quality: cycle.market.quality,
      reasons: [...cycle.market.reasons],
      bars_in: bars.length,
      bars_out: cycle.market.bars.length,
    };
    this.last_market_setup = cycle.market_setup
      ? {
          kind: cycle.market_setup.kind,
          side: cycle.market_setup.side,
          status: cycle.market_setup.status,
          reason: cycle.market_setup.reason,
          confirm: cycle.market_setup.confirm,
        }
      : null;
    this.last_desk_entry = cycle.desk_entry
      ? {
          side: cycle.desk_entry.side,
          source: cycle.desk_entry.source,
          reason: cycle.desk_entry.reason,
          setup_kind: cycle.desk_entry.setup_kind,
          playbook: cycle.desk_entry.playbook,
        }
      : null;
    this.last_hour_bias = this.pipeline.getStructureBook()?.hour_bias ?? null;
    this.last_closed_10s_present =
      !!this.last_closed_10s || !!closed10sForCycle;
    this.rememberCycleForEpic();
    this.last_ai_allow_close = cycle.ai.allow_close !== false;
    this.persistRuntimeGates();
    this.trackPersist('opportunity', persistOpportunity(cycle.opportunity));

    // Reader cycle alerts — block new entries on stale / not-tradeable / ACK timeout
    const quoteAgeMs = Math.max(0, Date.now() - (quote.ts_ms || 0));
    const dataQuality = cycle.decision.analysis?.data_quality ?? 1;
    const cycleAlerts = dispatchCycleAlerts({
      data_stale: quoteAgeMs > this.cfg.stale_quote_ms,
      freshness_ms: quoteAgeMs,
      stale_threshold_ms: this.cfg.stale_quote_ms,
      account_not_tradeable: this.account.trade_allowed === false,
      validation_failed: dataQuality < 0.35,
      validation_message:
        dataQuality < 0.35 ? `data_quality=${dataQuality}` : null,
    });
    const alertBlock = alertsBlockEntries(cycleAlerts);
    this.monitor.noteAlerts(cycleAlerts, alertBlock);

    // 3) Execution gate — LIVE requires Capital attached (refuse paper-as-LIVE)
    const allow_live =
      this.cfg.mode === 'LIVE' &&
      process.env.MASTER_LIVE_ENABLED === 'true' &&
      this.capitalBrokerAttached();
    let executed = false;
    let execution_detail: string | null = null;
    let acceptedIntentId: string | null = null;

    const inflight =
      Date.now() < this.inflight_until_ms || this.positions.count() > 0;
    const rejectCool = Date.now() < this.reject_until_ms;
    const postExitCool = Date.now() < this.post_exit_until_ms;
    const signalFp =
      cycle.decision.kind === 'BUY' || cycle.decision.kind === 'SELL'
        ? `${this.epic}:${cycle.decision.kind}`
        : null;
    const sameSignal =
      !!signalFp &&
      !!this.last_entry_fingerprint &&
      this.last_entry_fingerprint === signalFp &&
      (this.positions.count() > 0 || postExitCool);
    const cycleBudgetMs = Number(this.cfg.cycle_max_duration_ms);
    const cycleTimedOut =
      Number.isFinite(cycleBudgetMs) &&
      cycleBudgetMs > 0 &&
      Date.now() - t0 > cycleBudgetMs;
    if (cycleTimedOut) {
      logMasterError({
        module: 'runtime.tick',
        error_type: 'CYCLE_TIMEOUT',
        message: `cycle exceeded ${cycleBudgetMs}ms before OPEN`,
        context: { epic: this.epic, elapsed_ms: Date.now() - t0 },
      });
    }
    if (
      this.running &&
      this.entries_armed &&
      !alertBlock &&
      (this.cfg.mode === 'PAPER' || allow_live) &&
      (cycle.decision.kind === 'BUY' || cycle.decision.kind === 'SELL') &&
      cycle.risk.allowed &&
      !inflight &&
      !rejectCool &&
      !postExitCool &&
      !sameSignal &&
      !cycleTimedOut
    ) {
      // VS-System fail-closed: force-list broker opens before entry — local book
      // alone is unsafe when sync was skipped or ghosts lag.
      // Capital: venue-wide list (no epic filter) so other-epic orphans block OPEN.
      let brokerVerifyOk = true;
      try {
        const listed = await broker.listOpenPositions(
          broker instanceof CapitalBroker ? undefined : this.epic
        );
        if (!listed.ok) {
          brokerVerifyOk = false;
          execution_detail = `broker_verify_failed:${listed.detail || 'list_failed'}`;
          this.last_execution_detail = execution_detail;
          logMasterError({
            module: 'runtime.entry',
            error_type: 'broker_verify_failed',
            message: execution_detail,
            context: { epic: this.epic },
          });
        } else if (
          listed.positions.length > 0 ||
          (listed.presence_ids?.length ?? 0) > 0
        ) {
          brokerVerifyOk = false;
          const n =
            listed.positions.length > 0
              ? listed.positions.length
              : listed.presence_ids!.length;
          execution_detail = `one_trade_broker_open:${n}`;
          this.last_execution_detail = execution_detail;
        }
      } catch (err) {
        brokerVerifyOk = false;
        execution_detail = `broker_verify_failed:${err instanceof Error ? err.message : 'list_threw'}`;
        this.last_execution_detail = execution_detail;
        logMasterError({
          module: 'runtime.entry',
          error_type: 'broker_verify_threw',
          message: execution_detail,
          context: { epic: this.epic },
        });
      }

      if (brokerVerifyOk) {
      this.inflight_until_ms = Date.now() + 90_000;
      this.persistRuntimeGates();
      const openStarted = Date.now();
      const { execution, place } = await executeDecision({
        broker,
        pipeline: this.pipeline,
        opportunity: cycle.opportunity,
        decision: cycle.decision,
        risk: cycle.risk,
        epic: this.epic,
        allow_live: allow_live || broker.paper,
      });
      acceptedIntentId = execution.intent_id || cycle.opportunity.id;
      this.monitor.noteAckLatency(Date.now() - openStarted);
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
      logTradeEvent({
        event: 'OPEN',
        broker: broker.name,
        epic: this.epic,
        side: cycle.decision.side,
        volume: place?.fill_size ?? cycle.risk.volume,
        price: place?.fill_price ?? null,
        position_id: place?.position_id ?? null,
        intent_id: execution.intent_id || null,
        opportunity_id: cycle.opportunity.id,
        desk_entry_source: cycle.decision.desk_entry_source,
        ok: execution.accepted,
        detail: execution.detail,
      });

      if (execution.accepted && place?.position_id) {
        executed = true;
        this.inflight_until_ms = 0;
        this.persistRuntimeGates();
        this.seenIntentSnapshot.push(execution.intent_id);
        const provenFill =
          place.fill_price != null &&
          Number.isFinite(place.fill_price) &&
          place.fill_price > 0
            ? place.fill_price
            : null;
        // Capital LIVE: never forge entry from live ask/bid — broker must prove fill
        const fill =
          provenFill ??
          (broker instanceof CapitalBroker && !broker.paper
            ? null
            : cycle.decision.side === 'BUY'
              ? quote.ask
              : quote.bid);
        if (fill == null || !Number.isFinite(fill) || fill <= 0) {
          executed = false;
          const closed = await this.closePositionManualUnlocked(
            place.position_id,
            'CAPITAL_FILL_UNPROVEN'
          );
          execution_detail = `capital_fill_price_unproven;close=${
            closed.ok ? 'ok' : closed.detail
          }`;
          this.last_execution_detail = execution_detail;
          this.last_exit_reason = 'CAPITAL_FILL_UNPROVEN';
        } else {
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
          epic:
            broker instanceof Mt4FileBroker && broker.chartSymbol()
              ? broker.chartSymbol()!
              : this.epic,
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
          logTradeEvent({
            event: 'MODIFY',
            broker: broker.name,
            epic: this.epic,
            side: cycle.decision.side,
            volume: place.fill_size ?? cycle.risk.volume,
            price: rebased.stop_loss,
            position_id: place.position_id,
            intent_id: execution.intent_id || null,
            opportunity_id: cycle.opportunity.id,
            desk_entry_source: cycle.decision.desk_entry_source,
            ok: !!mod.ok,
            detail: `post_fill_sl_sync${mod.detail ? `:${mod.detail}` : ''}`,
          });
          if (!mod.ok) {
            this.broker_detail =
              `post_fill_sl_sync_fail:${mod.detail}`.slice(0, 400);
            logMasterError({
              module: 'runtime.entry',
              error_type: 'post_fill_sl_sync_fail',
              message: String(mod.detail || 'modify_failed'),
              context: {
                position_id: place.position_id,
                want_sl: rebased.stop_loss,
              },
            });
            // LIVE + protective SL required → fail-close unprotected book (VS-System)
            const needProtective =
              !broker.paper &&
              rebased.stop_loss != null &&
              Number.isFinite(rebased.stop_loss);
            if (needProtective) {
              // Must use unlocked close — we are already on tickChain (public
              // closePositionManual would deadlock behind this tick).
              const closed = await this.closePositionManualUnlocked(
                place.position_id,
                'POST_FILL_SL_SYNC_FAIL'
              );
              executed = false;
              execution_detail = `post_fill_sl_sync_fail_closed:${mod.detail};close=${closed.ok ? 'ok' : closed.detail}`;
              this.last_execution_detail = execution_detail;
              this.last_exit_reason = 'POST_FILL_SL_SYNC_FAIL';
            }
          } else if (signalFp) {
            // VS-System: fingerprint only after SL confirmed — prevents SAVE/re-arm spam
            this.last_entry_fingerprint = signalFp;
            this.persistRuntimeGates();
          }
        } else if (signalFp) {
          // No modify path (paper / no levels) — treat fill as confirmed
          this.last_entry_fingerprint = signalFp;
          this.persistRuntimeGates();
        }
        } // end proven-fill register
      } else if (!execution.accepted) {
        // Fail-close left a live Capital deal — register + keep inflight + re-close
        const unprovenLive =
          !!place?.position_id &&
          /capital_fail_close_unproven|mt4_fail_close_unproven/i.test(
            execution.detail || ''
          );
        if (unprovenLive && place?.position_id) {
          const cand =
            cycle.decision.side === 'BUY' ? cycle.decision.buy : cycle.decision.sell;
          const provenFill =
            place.fill_price != null &&
            Number.isFinite(place.fill_price) &&
            place.fill_price > 0
              ? place.fill_price
              : null;
          // Capital: prefer proven fill or planned entry — never live mark forge
          const fill =
            provenFill ??
            (broker instanceof CapitalBroker && !broker.paper
              ? cand?.entry != null &&
                Number.isFinite(cand.entry) &&
                cand.entry > 0
                ? cand.entry
                : null
              : cycle.decision.side === 'BUY'
                ? quote.ask
                : quote.bid);
          if (fill == null || !Number.isFinite(fill) || fill <= 0) {
            execution_detail = `capital_fail_close_unproven_no_fill:${place.position_id}`;
            this.last_execution_detail = execution_detail;
            this.inflight_until_ms = Math.max(
              this.inflight_until_ms,
              Date.now() + 90_000
            );
            this.persistRuntimeGates();
            const closed = await this.closePositionManualUnlocked(
              place.position_id,
              'CAPITAL_FAIL_CLOSE_UNPROVEN_RETRY'
            );
            execution_detail = closed.ok
              ? `capital_fail_close_unproven_retried_closed:${place.position_id}`
              : `capital_fail_close_unproven_no_fill:${place.position_id};retry=${closed.detail}`;
            this.last_execution_detail = execution_detail;
            this.reject_until_ms = Date.now() + 30_000;
            this.persistRuntimeGates();
          } else {
          const { rebaseStopsFromFill } = await import('./positionManager.js');
          const rebased = rebaseStopsFromFill(
            cand?.entry ?? fill,
            fill,
            cand?.stop_loss ?? null,
            cand?.take_profit ?? null
          );
          if (!this.positions.get(place.position_id)) {
            this.positions.register({
              position_id: place.position_id,
              opportunity_id: cycle.opportunity.id,
              intent_id: execution.intent_id,
              epic:
                broker instanceof Mt4FileBroker && broker.chartSymbol()
                  ? broker.chartSymbol()!
                  : this.epic,
              side: cycle.decision.side!,
              size: place.fill_size ?? cycle.risk.volume,
              entry: fill,
              stop_loss: rebased.stop_loss,
              take_profit: rebased.take_profit,
              decision: cycle.decision,
            });
          }
          this.inflight_until_ms = Math.max(
            this.inflight_until_ms,
            Date.now() + 90_000
          );
          this.persistRuntimeGates();
          logMasterError({
            module: 'runtime.entry',
            error_type: 'CAPITAL_FAIL_CLOSE_UNPROVEN',
            message: execution.detail || 'capital_fail_close_unproven',
            context: {
              epic: this.epic,
              broker: broker.name,
              position_id: place.position_id,
            },
          });
          const closed = await this.closePositionManualUnlocked(
            place.position_id,
            'CAPITAL_FAIL_CLOSE_UNPROVEN_RETRY'
          );
          execution_detail = closed.ok
            ? `capital_fail_close_unproven_retried_closed:${place.position_id}`
            : `capital_fail_close_unproven_registered:${place.position_id};retry=${closed.detail}`;
          this.last_execution_detail = execution_detail;
          this.reject_until_ms = Date.now() + 30_000;
          this.persistRuntimeGates();
          }
        } else {
        // Ambiguous OPEN — keep inflight so we do not double-open while EA may
        // still fill (Check- holds pending_open / WAIT_CMD until ACK/timeout).
        const ambiguousTimeout =
          /ack_timeout|ACK_TIMEOUT|not_confirmed|unconfirmed|confirm_timeout|mt4_pending_open|mt4_intent_already_pending|mt4_pending_control_command/i.test(
            execution.detail || ''
          );
        if (!ambiguousTimeout) {
          this.inflight_until_ms = 0;
          this.persistRuntimeGates();
        } else {
          // Capital/MT4 ambiguous OPEN — durable ACK_TIMEOUT / pending for cycle alert
          const pendingOpen =
            /mt4_pending_open|mt4_intent_already_pending|mt4_pending_control_command/i.test(
              execution.detail || ''
            );
          if (pendingOpen) {
            this.inflight_until_ms = Math.max(
              this.inflight_until_ms,
              Date.now() + 90_000
            );
          }
          logMasterError({
            module: 'runtime.entry',
            error_type: pendingOpen ? 'MT4_PENDING_OPEN' : 'ACK_TIMEOUT',
            message: execution.detail || 'ACK_TIMEOUT',
            context: { epic: this.epic, broker: broker.name },
          });
          this.persistRuntimeGates();
        }
        if (
          /reject|RISK_CHECK|not_confirmed|CAPITAL_SL|unconfirmed|ack_timeout|ACK_TIMEOUT|confirm_timeout|mt4_pending_open|mt4_intent_already_pending|mt4_pending_control_command/i.test(
            execution.detail
          )
        ) {
          const { capitalModifyRejectBackoffMs } = await import('./capitalConfirm.js');
          const backoff = ambiguousTimeout
            ? Math.max(30_000, capitalModifyRejectBackoffMs(execution.detail))
            : capitalModifyRejectBackoffMs(execution.detail);
          this.reject_until_ms = Date.now() + backoff;
          this.persistRuntimeGates();
        }
        }
      }
      } // brokerVerifyOk
      if (executed && this.ownsPipelineEffective() && cycle.decision.side) {
        const setup = this.pipeline.getMarketSetup();
        await this.fanoutAcceptedOpenToClients({
          side: cycle.decision.side,
          intent_id: acceptedIntentId || cycle.opportunity.id,
          reference_price: quote.mid,
          regime: cycle.decision.analysis?.regime ?? null,
          setup_type:
            setup && setup.kind !== 'NONE'
              ? setup.kind
              : cycle.decision.analysis?.market_state ?? null,
        });
      }
    } else if (cycle.decision.kind === 'BUY' || cycle.decision.kind === 'SELL') {
      execution_detail = !this.running
        ? 'runtime_stopped'
        : !this.entries_armed
          ? this.entries_pause_reason || 'entries_paused'
          : alertBlock
            ? alertBlock
            : cycleTimedOut
              ? 'cycle_timeout'
              : postExitCool
                ? 'post_exit_cooldown'
                : sameSignal
                  ? 'same_signal_fingerprint'
                  : rejectCool
                    ? 'reject_cooldown'
                    : inflight
                      ? this.positions.count() > 0
                        ? 'one_trade_open'
                        : 'inflight_order'
                      : !cycle.risk.allowed
                        ? `risk:${cycle.risk.reasons.join(',')}`
                        : this.cfg.mode === 'LIVE' && !allow_live
                          ? !this.capitalBrokerAttached()
                            ? 'live_no_capital'
                            : 'live_gate_off'
                          : 'not_armed';
      this.last_execution_detail = execution_detail;
    }

    this.account.open_positions = this.positions.count();
    this.trackPersist('open_positions', saveOpenPositions(this.positions.list()));
    if (this.seenIntentSnapshot.length) {
      this.trackPersist('seen_intents', saveSeenIntents(this.seenIntentSnapshot));
    }

    this.monitor.noteCycle(Date.now() - t0);
    this.lastFullTickAt = Date.now();
    this.ensureManageLoop();
    logDecisionEvent({
      kind: cycle.decision.kind,
      epic: this.epic,
      mode: this.cfg.mode,
      opportunity_id: cycle.opportunity.id,
      buy_score: cycle.decision.buy?.score,
      sell_score: cycle.decision.sell?.score,
      block_reason: cycle.decision.block_reason,
      executed,
      execution_detail,
      cycle_ms: Date.now() - t0,
      desk_entry_source: cycle.desk_entry?.source ?? null,
      desk_entry_side: cycle.desk_entry?.side ?? null,
      hour_bias: this.last_hour_bias,
      closed_10s_present: this.last_closed_10s_present,
    });
    return {
      decision: cycle.decision,
      risk: cycle.risk,
      executed,
      execution_detail,
      exits: managed.closed.length,
      exit_reasons,
    };
  }

  /** Restart recovery — reload positions, intents, journal, expectancy; reconcile broker.
   * Serialized on tickChain so mid-flight recover cannot race manage/sync/close. */
  async recover(): Promise<{
    positions: number;
    intents: number;
    opportunities: number;
    outcomes: number;
  }> {
    return this.runOnTickChain(() => this.recoverUnlocked());
  }

  private async recoverUnlocked(): Promise<{
    positions: number;
    intents: number;
    opportunities: number;
    outcomes: number;
  }> {
    // Restore operator sidecars from master_state.json if wiped mid-process
    // BEFORE hydrate — otherwise missing manage/owns files keep defaults.
    const { ensureOperatorMetaFromStateDir } = await import('./filePersist.js');
    ensureOperatorMetaFromStateDir();
    const { hydrateManageConfigFromPersist } = await import('./manageConfig.js');
    await hydrateManageConfigFromPersist();
    this.hydrateManageConfig();
    const { hydrateOwnsPipelineFromPersist } = await import(
      './ownsPipelinePref.js'
    );
    await hydrateOwnsPipelineFromPersist();
    this.hydrateOwnsPipelinePref();
    const { hydrateMarketCacheFromPersist } = await import('./marketCache.js');
    await hydrateMarketCacheFromPersist();
    this.hydrateMarketCacheFromDisk();
    const { hydrateRuntimeGatesFromPersist } = await import('./runtimeGates.js');
    await hydrateRuntimeGatesFromPersist();
    const loaded = await loadOpenPositions();
    const valid = loaded.filter((p) => p.decision && p.position_id);
    this.positions.fromJSON(valid);
    // Lock orphan BestOutcome identity from recovered analysis when still unset
    for (const p of this.positions.list()) {
      if (!p.playbook_at_entry && p.decision?.analysis) {
        p.playbook_at_entry = mapRegimeToPlaybook(
          p.decision.analysis.regime,
          p.decision.analysis
        );
        p.entry_setup =
          p.entry_setup ??
          entrySetupFromRegime(p.decision.analysis.regime, p.decision.analysis);
        if (!p.regime_at_entry || p.regime_at_entry === 'UNKNOWN') {
          p.regime_at_entry = toDeskRegime(
            p.decision.analysis.regime,
            p.decision.analysis
          );
        }
      }
    }

    const intents = await loadSeenIntents();
    for (const id of intents) this.pipeline.claimIntent(id);
    this.seenIntentSnapshot = [...intents];

    const hist = await loadJournalHistory();
    this.pipeline.journal.hydrate(
      hist.opportunities,
      hist.outcomes.map((o) => o.outcome)
    );
    this.pipeline.journal.applyOutcomeSetupKeys(hist.outcomes);
    this.pipeline.expectancy.hydrate(
      hist.outcomes
        .filter((o) => !!o.setup_key && !!o.outcome)
        .map((o) => ({
          setup_key: String(o.setup_key),
          outcome: o.outcome,
        }))
    );
    // Heal desk confirm provenance on opens before any manage/close can record EV
    {
      const healed = backfillDeskEntrySources(this.positions.list(), {
        opportunities: hist.opportunities,
        decisions: loadDecisionEvents(500),
      });
      if (healed > 0) {
        this.trackPersist(
          'open_positions',
          saveOpenPositions(this.positions.list())
        );
      }
    }
    // Recompute account daily/peak from recovered outcomes (today only for daily_pnl)
    // Load gates BEFORE equity rebuild/roll so same-day day_start / peak survive restart.
    const gates = loadRuntimeGates();
    if (gates) {
      this.applyRuntimeGates(gates);
    } else if (this.cfg.ai_mode !== 'off') {
      // No gates file — soft exits fail-closed until a cycle proves allow
      this.last_ai_allow_close = false;
    }
    // Calendar today for outcome bucketing — roll AFTER journal equity rebuild so
    // day_start_equity seeds from live equity (parity with manageOnly/full tick).
    const today = new Date().toISOString().slice(0, 10);
    let pnlToday = 0;
    let pnlAll = 0;
    const capitalAttached =
      this.broker instanceof CapitalBroker && !this.broker.paper;
    const oppMode = new Map(
      hist.opportunities.map((o) => [String(o.id), String(o.mode || '')])
    );
    // Sort ASC by created_at — file persist may be DESC after reverse; streak needs newest-last
    const outcomesAsc = [...hist.outcomes].sort((a, b) => {
      const ta = Date.parse(String(a.created_at || '')) || 0;
      const tb = Date.parse(String(b.created_at || '')) || 0;
      return ta - tb;
    });
    for (const o of outcomesAsc) {
      // Unproven Capital closes must not move day gates / invent equity
      if (o.outcome.pnl_proven === false) continue;
      // Capital LIVE: never import PAPER journal money into venue day gates
      if (capitalAttached && oppMode.get(String(o.opportunity_id)) !== 'LIVE') {
        continue;
      }
      pnlAll += o.outcome.pnl;
      const day = String(o.created_at || '').slice(0, 10);
      // Only today's outcomes — never treat missing/epoch created_at as today
      if (day === today) pnlToday += o.outcome.pnl;
    }
    // Trailing loss streak from newest (Check- consecutive_losses)
    let losses = 0;
    for (let i = outcomesAsc.length - 1; i >= 0; i--) {
      const row = outcomesAsc[i]!;
      if (row.outcome.pnl_proven === false) continue;
      if (capitalAttached && oppMode.get(String(row.opportunity_id)) !== 'LIVE') {
        continue;
      }
      if (row.outcome.pnl < 0) losses += 1;
      else break;
    }
    // Prefer max(journal streak, gate) so a mid-restart gate write is not wiped by empty hist
    const gatedStreak =
      gates?.consecutive_losses != null && Number.isFinite(gates.consecutive_losses)
        ? Math.max(0, Math.floor(gates.consecutive_losses))
        : 0;
    this.account.consecutive_losses = Math.max(losses, gatedStreak);
    // Capital LIVE (proven or not): venue balance already includes realized PnL —
    // never invent equity/peak from balance + journal (double-counts when proven).
    // Leave equity/peak for tick getAccount; paper path still rebuilds from journal.
    if (!(this.broker instanceof CapitalBroker && !this.broker.paper)) {
      // Full journal closed PnL from paper start (£10k). Sync balance to realized
      // cash so seedPaperBroker + markToMarket use cash+UPL (not stale £10k+UPL).
      const paperStart = 10_000;
      const cash = paperStart + pnlAll;
      this.account.balance = cash;
      this.account.equity = cash;
      if (this.account.equity > this.account.peak_equity) {
        this.account.peak_equity = this.account.equity;
      }
    }
    // PAPER: reseed broker cash/opens before optional MTM + UTC day-roll.
    this.seedPaperBrokerFromPositions();
    if (
      this.broker instanceof PaperBroker &&
      this.quoteProvenForOpenDayRoll(this.last_quote) &&
      this.positions.count() > 0
    ) {
      const q = this.last_quote;
      this.broker.setQuote({
        bid: q.bid,
        ask: q.ask,
        mid: q.mid,
        spread: q.spread,
        epic: q.epic || this.epic,
        ts_ms: q.ts_ms,
      });
      this.broker.markToMarket();
      try {
        const acctPre = await this.broker.getAccount();
        await this.applyVenueAccountSnapshot(this.broker, acctPre, q);
      } catch {
        /* keep journal equity */
      }
    }
    // Opens without a live mark / Capital unproven: defer UTC day-roll —
    // disk/stale/missing quote or unread Capital would wipe/seal day_start
    // and leave max_daily_loss fail-open.
    const deferOpenDayRoll = this.shouldDeferUtcDayRoll(this.last_quote);
    if (!deferOpenDayRoll) {
      this.rollDailyPnl();
      // Capital pending seed: keep day_start 0 — do not fall back to paper balance
      if (
        !(
          this.broker instanceof CapitalBroker &&
          !this.broker.paper &&
          !this.capitalDayGatesSeeded
        )
      ) {
        this.account.day_start_equity =
          this.account.day_start_equity ||
          this.account.equity ||
          this.account.balance;
      }
      // After roll, surface today's closed daily_pnl
      this.pendingCalendarDayClosedPnl = 0;
      this.account.daily_pnl = pnlToday;
    } else {
      // Defer: keep closed PnL for the still-sealed day — wiping to pnlToday
      // (often 0) would drop prior-day losses from max_daily_loss while
      // day_start_equity stays on yesterday.
      if (!capitalAttached || this.capitalDayGatesSeeded) {
        const sealedDay = this.account.daily_pnl_day;
        if (sealedDay) {
          let pnlSealed = 0;
          for (const o of outcomesAsc) {
            if (o.outcome.pnl_proven === false) continue;
            if (
              capitalAttached &&
              oppMode.get(String(o.opportunity_id)) !== 'LIVE'
            ) {
              continue;
            }
            const day = String(o.created_at || '').slice(0, 10);
            if (day === sealedDay) pnlSealed += o.outcome.pnl;
          }
          this.account.daily_pnl = pnlSealed;
        }
      }
      // Park calendar-today journal closes for post-roll restore — memory
      // pending is lost across restart; rebuild from disk (parity with live
      // creditClosedDailyPnl during the defer window).
      this.pendingCalendarDayClosedPnl = pnlToday;
    }
    this.persistRuntimeGates();

    // Dashboard honesty after restart — seed monitoring from durable snapshot
    const { hydrateMonitoringSnapshotFromPersist } = await import(
      './monitoring.js'
    );
    await hydrateMonitoringSnapshotFromPersist();
    this.hydrateMonitorFromDisk();

    // Reader recover_spread_model — relative-spread gate must not cold-open after restart
    this.spreadLookback = this.cfg.spread_lookback_bars;
    this.spreadHistory = new SpreadHistory(this.spreadLookback);
    const { hydrateSpreadHistoryFromPersist } = await import('./spreadModel.js');
    await hydrateSpreadHistoryFromPersist();
    const spreadRestored = this.spreadHistory.load();
    if (spreadRestored > 0) {
      this.broker_detail = [
        this.broker_detail,
        `spread_restore:${spreadRestored}`,
      ]
        .filter(Boolean)
        .join(';')
        .slice(0, 400);
    }

    // PAPER restart: empty in-memory book must be reseeded before sync or every
    // restored open looks like a ghost and is wiped as broker_flat.
    this.seedPaperBrokerFromPositions();

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
      // Check- WAIT_CMD / pending_open — re-arm inflight so restart does not spam OPEN
      if (pending.still_pending > 0) {
        this.inflight_until_ms = Math.max(
          this.inflight_until_ms,
          Date.now() + 90_000
        );
        this.persistRuntimeGates();
      }
    }

    // Capital + MT4: Reader apply_ack_to_instance_state — OPEN SUCCESS before status sync
    if (
      this.broker instanceof Mt4FileBroker ||
      this.broker instanceof CapitalBroker
    ) {
      const { hydrateTradeAckJournalFromPersist } = await import(
        './tradeAckJournal.js'
      );
      await hydrateTradeAckJournalFromPersist();
      const booked = new Set(this.positions.list().map((p) => p.position_id));
      const fromAck = this.broker.adoptOpenFromAckJournal(booked);
      let statusByTicket = new Map<
        string,
        {
          opened_at?: string | null;
          open_level?: number | null;
          open_level_proven?: boolean;
          stop_level?: number | null;
          profit_level?: number | null;
          side?: string | null;
        }
      >();
      let presenceIds = new Set<string>();
      /** Capital list failed/threw — SUCCESS ack must still run attach-or-fail, not skip as absent. */
      let capitalListUnproven = false;
      if (fromAck.adopted.length) {
        try {
          // Capital: venue-wide list — epic filter cannot prove ticket gone / present
          const listed = await this.broker.listOpenPositions(
            this.broker instanceof CapitalBroker ? undefined : this.epic
          );
          if (listed.ok) {
            statusByTicket = new Map(
              listed.positions.map((p) => [
                p.position_id,
                {
                  opened_at: p.opened_at,
                  open_level: p.open_level,
                  open_level_proven: p.open_level_proven,
                  stop_level: p.stop_level,
                  profit_level: p.profit_level,
                  side: p.side,
                },
              ])
            );
            presenceIds = new Set(
              (listed.presence_ids ?? listed.positions.map((p) => p.position_id)).filter(
                Boolean
              )
            );
          } else if (this.broker instanceof CapitalBroker) {
            capitalListUnproven = true;
            this.broker_detail = [
              this.broker_detail,
              `ack_list_unproven:${listed.detail || 'list_failed'}`,
            ]
              .filter(Boolean)
              .join(';')
              .slice(0, 400);
          }
        } catch (err) {
          if (this.broker instanceof CapitalBroker) {
            capitalListUnproven = true;
            this.broker_detail = [
              this.broker_detail,
              `ack_list_unproven:${err instanceof Error ? err.message : 'throw'}`,
            ]
              .filter(Boolean)
              .join(';')
              .slice(0, 400);
          }
        }
      }
      let attachFailed = 0;
      let attachOk = 0;
      for (const row of fromAck.adopted) {
        if (this.positions.get(row.ticket)) continue;
        const status = statusByTicket.get(row.ticket);
        const presentOnBroker =
          status != null ||
          presenceIds.has(row.ticket) ||
          (capitalListUnproven && this.broker instanceof CapitalBroker);
        const statusOpen =
          status != null && status.open_level_proven !== false
            ? status.open_level != null &&
              Number.isFinite(status.open_level) &&
              status.open_level > 0
              ? Number(status.open_level)
              : null
            : null;
        const ackFill =
          row.fill_price != null &&
          Number.isFinite(row.fill_price) &&
          row.fill_price > 0
            ? Number(row.fill_price)
            : null;
        // Prefer proven ack fill, then venue-proven list open — never forge quote mid as entry
        const entry = ackFill ?? statusOpen;
        if (entry == null) {
          // Live Capital ticket with no usable entry → fail-close rather than skip unmanaged
          if (presentOnBroker && this.broker instanceof CapitalBroker) {
            try {
              await this.broker.closePosition(row.ticket);
            } catch {
              /* ignore */
            }
            this.broker_detail = [
              this.broker_detail,
              `ack_presence_no_entry:${row.ticket}`,
            ]
              .filter(Boolean)
              .join(';')
              .slice(0, 400);
          }
          continue;
        }
        // Capital list proved ticket gone — never seed a phantom local open from ack fill
        if (
          this.broker instanceof CapitalBroker &&
          !capitalListUnproven &&
          !presentOnBroker
        ) {
          continue;
        }
        const recoverId = stableRecoverUuid(row.ticket);
        const openedAt = status?.opened_at ?? null;
        const wantSl =
          row.sl != null && Number.isFinite(row.sl) && Number(row.sl) > 0
            ? Number(row.sl)
            : null;
        const wantTp =
          row.tp != null && Number.isFinite(row.tp) && Number(row.tp) > 0
            ? Number(row.tp)
            : null;
        // Ticket live on broker (incl. presence-only) + journal wants SL → attach-or-fail
        const onBroker = presentOnBroker;
        let rowAttached = false;
        if (onBroker && wantSl != null) {
          const guardInput: {
            position_id: string;
            want_sl: number;
            want_tp?: number | null;
            order_id: string;
            epic: string;
            side?: 'BUY' | 'SELL';
            fill_price?: number | null;
          } = {
            position_id: row.ticket,
            want_sl: wantSl,
            want_tp: wantTp,
            order_id: row.command_id,
            epic: row.epic || this.epic,
          };
          if (this.broker instanceof CapitalBroker) {
            guardInput.side = row.side;
            guardInput.fill_price = entry;
          }
          const guard = await this.broker.ensureProtectiveLevelsOrFail(guardInput);
          if (!guard.ok) {
            attachFailed += 1;
            this.broker_detail = [
              this.broker_detail,
              `ack_attach_fail:${row.ticket}:${guard.detail}`,
            ]
              .filter(Boolean)
              .join(';')
              .slice(0, 400);
            // MT4 ensureProtectiveLevelsOrFail already fail-closes; Capital only attaches —
            // mirror fail-close here so naked LIVE deals do not survive recover.
            if (this.broker instanceof CapitalBroker) {
              try {
                await this.broker.closePosition(row.ticket);
              } catch {
                /* stillLive check below */
              }
            }
            const listed = await this.broker.listOpenPositions(
              this.broker instanceof CapitalBroker
                ? undefined
                : row.epic || this.epic
            );
            // Fail-closed: unread/failed list must keep the ticket locally (same as
            // failCloseOpenResult keeping position_id when close/list is unproven).
            // Only drop when Capital list proves the deal is gone.
            const stillLive =
              !listed.ok ||
              listed.positions.some((p) => p.position_id === row.ticket) ||
              (listed.presence_ids ?? []).includes(row.ticket);
            if (!stillLive) continue;
          } else {
            attachOk += 1;
            rowAttached = true;
          }
        }
        // Only seed local SL/TP when broker already shows them (or attach just proved).
        // Never paint journal intent as chart truth on a naked/missing ticket.
        const provedSl = rowAttached
          ? wantSl
          : status?.stop_level != null && Number.isFinite(status.stop_level)
            ? Number(status.stop_level)
            : null;
        const provedTp = rowAttached
          ? wantTp
          : status?.profit_level != null && Number.isFinite(status.profit_level)
            ? Number(status.profit_level)
            : null;
        this.positions.register({
          position_id: row.ticket,
          opportunity_id: recoverId,
          intent_id: row.intent_id || row.command_id,
          epic: row.epic || this.epic,
          side: row.side,
          size: row.volume,
          entry,
          stop_loss: provedSl,
          take_profit: provedTp,
          entry_at: openedAt,
          decision: {
            decision_id: recoverId,
            kind: row.side,
            side: row.side,
            score: 0,
            block_reason: null,
            buy: null as never,
            sell: null as never,
            analysis: {
              regime: this.last_decision?.analysis?.regime || 'UNKNOWN',
              market_state: 'ack_recover',
              momentum_score: this.last_decision?.analysis?.momentum_score ?? 0,
              momentum_dir: this.last_decision?.analysis?.momentum_dir || 'NEUTRAL',
              trend_dir: this.last_decision?.analysis?.trend_dir || 'SIDEWAYS',
              trend_strength: this.last_decision?.analysis?.trend_strength ?? 0,
              structure_bias:
                this.last_decision?.analysis?.structure_bias || 'NEUTRAL',
              swing_high: entry,
              swing_low: entry,
              buy_pressure: 0,
              sell_pressure: 0,
              behavior_bull: 0,
              behavior_bear: 0,
              impact_score: 0,
              context_quality: 0,
              volatility: 0,
              atr: 0,
              data_quality: 0.5,
              session: this.last_decision?.analysis?.session || 'UNKNOWN',
            },
            expectancy: null,
          },
        });
        // Keep journal structure levels as intended even when chart still naked
        const bookedPos = this.positions.get(row.ticket);
        if (bookedPos) {
          if (wantSl != null) bookedPos.intended_stop_loss = wantSl;
          if (wantTp != null) bookedPos.intended_take_profit = wantTp;
        }
      }
      if (fromAck.adopted.length) {
        this.broker_detail = [
          this.broker_detail,
          `ack_adopt:${fromAck.adopted.length}`,
          attachOk ? `ack_attach_ok:${attachOk}` : '',
          attachFailed ? `ack_attach_fail_n:${attachFailed}` : '',
        ]
          .filter(Boolean)
          .join(';');
      }
    }

    if (this.broker) {
      const sync = await syncPositionsWithBroker(
        this.positions,
        this.broker,
        this.broker instanceof CapitalBroker ? undefined : this.epic,
        this.emptyBrokerDebounce,
        this.liveAdoptContext()
      );
      // Journal confirmed ghosts/orphans even when other tickets are still in miss-debounce.
      if (!sync.skipped) {
        await this.applySyncJournal(sync);
      }
      if (this.broker instanceof CapitalBroker && !this.broker.paper) {
        if (sync.skipped) {
          this.capitalVenueOpensProven = false;
        } else {
          this.capitalVenueOpensProven = true;
          this.capitalVenueOpens = sync.broker_count;
        }
      }
    }

    // Hydrate last exit + cycle cards for dashboard after restart
    this.seedDashboardFromHistory(hist);

    this.account.open_positions = this.positions.count();
    this.bookHydrated = true;
    this.recovered = true;
    return {
      positions: this.positions.count(),
      intents: intents.length,
      opportunities: hist.opportunities.length,
      outcomes: hist.outcomes.length,
    };
  }

  async start(opts?: {
    interval_ms?: number;
    broker?: MasterBroker;
    live_feed?: boolean;
    /** Desk-driven ticks supply quote/bars — do not start broker/Yahoo poll */
    skip_market_feed?: boolean;
  }) {
    if (opts?.broker) this.attachBroker(opts.broker);
    else if (!this.broker) this.ensurePaperBroker();
    if (this.broker) await this.broker.connect();
    await this.recover();
    this.running = true;
    this.desired_running = true;
    this.persistRuntimeGates();
    // Opens must not sit unmanaged until the first poll — seed quote/bars now
    await this.bootstrapManageAfterRecover();
    const ms = opts?.interval_ms ?? 0;
    if (ms > 0 && !this.timer) {
      this.timer = setInterval(() => {
        if (!this.running || !this.last_bars.length || !this.last_quote) return;
        void this.tick(this.last_bars, this.last_quote);
      }, ms);
    }
    if (opts?.skip_market_feed) {
      this.stopLiveFeed();
      return;
    }
    const wantPublicFeed =
      opts?.live_feed === true || process.env.MASTER_AUTO_LIVE_FEED === 'true';
    const wantBrokerFeed = !wantPublicFeed && !!this.broker && !this.broker.paper;
    // PAPER→LIVE (or reverse) must replace the mark source — do not keep Yahoo stuck
    if (wantPublicFeed || wantBrokerFeed) {
      this.stopLiveFeed();
    }
    if (wantPublicFeed) {
      await this.startPublicLiveFeed();
    } else if (wantBrokerFeed) {
      // LIVE Capital/MT4: poll broker quotes — do not leave runtime silent
      await this.startBrokerLiveFeed();
    }
  }

  /** Clear public/broker quote loop without stopping the runtime. */
  private stopLiveFeed() {
    if (this.liveFeedTimer) {
      clearInterval(this.liveFeedTimer);
      this.liveFeedTimer = null;
    }
  }

  /**
   * Desk Capital path owns quote/bars — stop broker/Yahoo poll so it cannot
   * Yahoo-seed and pause entries while desk already has venue OHLC.
   */
  preferDeskMarketFeed() {
    this.stopLiveFeed();
  }

  /**
   * LIVE broker market loop — CAPITAL/MT4 getQuote → bars → tick.
   * Public Yahoo feed stays PAPER-only; marks/exits use broker bid/ask.
   */
  async startBrokerLiveFeed(pollMs = 2500) {
    if (this.liveFeedTimer) return;
    if (!this.broker || this.broker.paper) return;
    const {
      LiveBarBuilder,
      stickyClosed10s,
      emptyHourBarsCache,
      refreshHourBarsCache,
    } = await import('./liveFeed.js');
    const builder = new LiveBarBuilder(10_000, 80);
    let hourCache = emptyHourBarsCache();
    if (this.last_hour_bars.length >= 6) {
      hourCache = {
        bars: this.last_hour_bars,
        last_ms: Date.now(),
        detail: this.last_hour_bars_detail || 'disk_cache',
      };
    }
    /** Desk last_closed parity — confirm gate stays armed between 10s closes */
    let lastClosed10s: import('../services/tenSecondOhlc.js').TenSecBar | null =
      this.last_closed_10s;
    let seeded = false;
    let busy = false;
    let lastMid: number | null = null;
    let frozenPolls = 0;
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
          // Feed miss must not freeze exits — manage-only on last quote (no OPEN).
          // Quote alone is enough (parity with bootstrap manage-on-quote); OHLC ≥5 optional.
          // Keep aged ts_ms so DATA_STALE / entry gates stay honest (do not forge freshness).
          if (this.last_quote) {
            await this.manageOnlyTick(this.last_bars, this.last_quote);
          }
          return;
        }
        if (this.broker instanceof Mt4FileBroker) {
          this.syncEpicFromMt4Chart(this.broker);
        }
        if (this.broker instanceof CapitalBroker) {
          this.syncEpicFromCapitalQuote(q);
        }
        // Frozen mid (~24 polls): age ts_ms so DATA_STALE / entry gates stay honest
        if (lastMid != null && Math.abs(q.mid - lastMid) < 1e-9) {
          frozenPolls += 1;
        } else {
          frozenPolls = 0;
        }
        lastMid = q.mid;
        const quote =
          frozenPolls >= 24 ? { ...q, ts_ms: Date.now() - 60_000 } : q;
        if (frozenPolls >= 24 && frozenPolls % 24 === 0) {
          this.broker_detail = `${this.broker_detail || ''};frozen_mid:${frozenPolls}`.slice(
            -400
          );
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
          this.applyStructureSeedGate(builder.seed_source);
          const streamNote =
            this.broker instanceof CapitalBroker &&
            this.broker.isMarketStreamHealthy(undefined, this.epic)
              ? 'stream:ok'
              : 'stream:rest';
          this.broker_detail = `${this.broker_detail || brokerName};broker_feed:${brokerName};seed:${seedDetail};${streamNote}`.slice(
            -400
          );
        } else if (!process.env.VITEST) {
          // Only pull Capital OHLC when structure refresh is due — every-cycle
          // getHistoryBars held the CST login lock and could starve closes.
          const structureEveryMs = 120_000;
          const structureDue =
            Date.now() - builder.last_structure_refresh_ms >= structureEveryMs;
          let brokerHist: Awaited<
            ReturnType<NonNullable<MasterBroker['getHistoryBars']>>
          > | null = null;
          if (structureDue && typeof this.broker.getHistoryBars === 'function') {
            try {
              brokerHist = await Promise.race([
                this.broker.getHistoryBars(this.epic, 60),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
              ]);
            } catch {
              brokerHist = null;
            }
          }
          if (structureDue) {
            const refreshed = await builder.refreshStructureIfStale(
              this.epic,
              q.mid,
              structureEveryMs,
              brokerHist
            );
            this.applyStructureSeedGate(builder.seed_source);
            if (refreshed) {
              this.broker_detail = `${this.broker_detail || ''};${refreshed}`.slice(-400);
            }
          }
        } else {
          this.applyStructureSeedGate(builder.seed_source);
        }
        const { justClosed, bars } = builder.pushTick(quote.mid);
        if (bars.length < 5) return;
        // Desk parity: Capital market must be TRADEABLE/OPEN — unknown/CLOSED parks entries.
        // Never set trade_allowed from market alone while Capital account unproven.
        if (this.broker instanceof CapitalBroker) {
          const { capitalMarketAllowsTrading } = await import('./capitalMarket.js');
          this.account.trade_allowed =
            capitalMarketAllowsTrading(quote.market_status) &&
            this.capitalAccountProven;
          if (!this.account.trade_allowed) {
            this.broker_detail = `${this.broker_detail || ''};market:${
              quote.market_status || 'UNKNOWN'
            }`.slice(-400);
          }
        } else if (quote.market_status != null) {
          const { capitalMarketAllowsTrading } = await import('./capitalMarket.js');
          this.account.trade_allowed = capitalMarketAllowsTrading(quote.market_status);
          if (!this.account.trade_allowed) {
            this.broker_detail = `${this.broker_detail || ''};market:${quote.market_status}`.slice(-400);
          }
        }
        const closed_10s = (lastClosed10s = stickyClosed10s(
          lastClosed10s,
          justClosed
        ));
        const hourDue =
          !hourCache.bars || Date.now() - hourCache.last_ms >= 120_000;
        if (hourDue) {
          hourCache = await refreshHourBarsCache({
            epic: this.epic,
            cache: hourCache,
            everyMs: 120_000,
            force: !hourCache.bars,
            brokerGetHourBars:
              typeof this.broker.getHourBars === 'function'
                ? () => this.broker!.getHourBars!(this.epic, 48)
                : undefined,
          });
          if (hourCache.detail && hourCache.bars?.length) {
            this.broker_detail = `${this.broker_detail || ''};hour:${hourCache.detail}`.slice(
              -400
            );
            if (hourCache.detail !== 'disk_cache') {
              this.hourBarsFromDiskCache = false;
              this.last_hour_bars_detail = hourCache.detail;
            }
          }
        }
        const referenceMids = await this.refreshPublicReferenceMids(this.epic);
        await this.tick(
          bars,
          {
            bid: quote.bid,
            ask: quote.ask,
            mid: quote.mid,
            spread: quote.spread,
            epic: quote.epic || this.epic,
            ts_ms: quote.ts_ms,
            min_stop_distance: quote.min_stop_distance,
            market_status: quote.market_status,
            digits: quote.digits,
            point: quote.point,
          },
          {
            reference_mids: referenceMids.length ? referenceMids : null,
            closed_10s,
            hour_bars: hourCache.bars,
          }
        );
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
    const {
      fetchLiveMarket,
      LiveBarBuilder,
      stickyClosed10s,
      emptyHourBarsCache,
      refreshHourBarsCache,
    } = await import('./liveFeed.js');
    const builder = new LiveBarBuilder(10_000, 80);
    let hourCache = emptyHourBarsCache();
    if (this.last_hour_bars.length >= 6) {
      hourCache = {
        bars: this.last_hour_bars,
        last_ms: Date.now(),
        detail: this.last_hour_bars_detail || 'disk_cache',
      };
    }
    /** Desk last_closed parity — confirm gate stays armed between 10s closes */
    let lastClosed10s: import('../services/tenSecondOhlc.js').TenSecBar | null =
      this.last_closed_10s;
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
        // Feed failure must not freeze exits (TIME_STOP / SL) — manage-only on last quote (no OPEN).
        // Quote alone is enough (parity with bootstrap manage-on-quote); OHLC ≥5 optional.
        // Keep aged ts_ms so DATA_STALE / entry gates stay honest (do not forge freshness).
        if (!snap?.ok || !snap.quote) {
          if (this.last_quote) {
            await this.manageOnlyTick(this.last_bars, this.last_quote);
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
        const { justClosed, bars } = builder.pushTick(snap.quote.mid);
        if (bars.length < 5) return;
        const closed_10s = (lastClosed10s = stickyClosed10s(
          lastClosed10s,
          justClosed
        ));
        const hourDue =
          !hourCache.bars || Date.now() - hourCache.last_ms >= 120_000;
        if (hourDue) {
          hourCache = await refreshHourBarsCache({
            epic: this.epic,
            cache: hourCache,
            everyMs: 120_000,
            force: !hourCache.bars,
          });
          if (hourCache.detail && hourCache.bars?.length) {
            this.broker_detail = `${this.broker_detail || ''};hour:${hourCache.detail}`.slice(
              -400
            );
            if (hourCache.detail !== 'disk_cache') {
              this.hourBarsFromDiskCache = false;
              this.last_hour_bars_detail = hourCache.detail;
            }
          }
        }
        // Public consensus quote is already fused — do not self-diverge against the same mids
        await this.tick(bars, quote, {
          closed_10s,
          hour_bars: hourCache.bars,
        });
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
    this.desired_running = false;
    this.persistRuntimeGates();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopLiveFeed();
    // Keep manage loop while opens remain — Stop must not orphan exits
    if (this.positions.count() > 0) {
      this.ensureManageLoop();
    } else {
      this.clearManageLoop();
    }
    if (this.broker instanceof CapitalBroker) {
      this.broker.stopMarketStream();
    }
    // Refuse empty overwrite before recover — otherwise Stop on a fresh
    // process wipes durable opens that recover() has not loaded yet.
    if (this.positions.count() === 0 && !this.recovered) {
      return;
    }
    this.trackPersist('open_positions', saveOpenPositions(this.positions.list()));
  }

  /**
   * VS-System trail-only loop (~1s) while a position is open.
   * Skips when a full entry tick ran recently; never places OPEN.
   * Runs even when !running so Recover/Stop-with-opens still exit.
   */
  private ensureManageLoop() {
    if (this.positions.count() === 0) {
      this.clearManageLoop();
      return;
    }
    if (this.manageTimer) return;
    this.manageTimer = setInterval(() => {
      if (this.positions.count() === 0) {
        this.clearManageLoop();
        return;
      }
      if (Date.now() - this.lastFullTickAt < 800) return;
      // Quote is enough for hard STOP/TP + venue account snapshot; OHLC structure
      // is optional (runManageAcrossOpenEpics already tolerates bars.length < 5).
      if (!this.last_quote) return;
      void this.manageOnlyTick(this.last_bars, this.last_quote);
    }, 1000);
  }

  private clearManageLoop() {
    if (this.manageTimer) {
      clearInterval(this.manageTimer);
      this.manageTimer = null;
    }
  }

  /** Manage/exit only — serialized on the same chain as full tick (no OPEN). */
  private async manageOnlyTick(bars: Bar[], quote: Quote): Promise<void> {
    const run = async () => {
      try {
        await this.manageOnlyUnlocked(bars, quote);
      } catch (e) {
        logMasterError({
          module: 'runtime.manage',
          error_type: 'manage_only_failed',
          message: e instanceof Error ? e.message : String(e),
          context: { epic: this.epic },
        });
      }
    };
    const result = this.tickChain.then(run, run);
    this.tickChain = result.then(
      () => undefined,
      () => undefined
    );
    await result;
  }

  /**
   * After recover / hydrate manage: if opens exist but last_bars/quote empty, pull
   * broker quote+history (or disk market_cache) and run one manage-only tick so
   * stops/exits are not blind. PAPER must reseed broker book before sync.
   * Quote alone is enough for hard STOP/TP + venue account snapshot — do not
   * wait for bars.length >= 5 (OHLC structure is optional on manageOnly).
   */
  private async bootstrapManageAfterRecover(): Promise<void> {
    if (this.positions.count() === 0) {
      // Flat book: still reseed PaperBroker equity from journal-rebuilt account
      // so the next tick does not overwrite recovered equity with default £10k.
      if (!this.broker && this.cfg.mode !== 'LIVE') {
        this.ensurePaperBroker();
      }
      this.seedPaperBrokerFromPositions();
      this.clearManageLoop();
      return;
    }
    if (!this.broker) {
      if (this.cfg.mode === 'LIVE') {
        // LIVE opens without venue broker — fail closed (do not paper-manage)
        return;
      }
      this.ensurePaperBroker();
    }
    // Hydrate-only path (no recover): empty PaperBroker would ghost-wipe locals
    this.seedPaperBrokerFromPositions();
    try {
      // Disk cache first — covers history fetch miss / slow Capital OHLC
      this.hydrateMarketCacheFromDisk();
      // Manage-on-quote: cached quote is enough (structure needs ≥5 bars later)
      if (this.last_quote) {
        await this.manageOnlyTick(this.last_bars, this.last_quote);
        return;
      }
      let q: Awaited<ReturnType<MasterBroker['getQuote']>> = null;
      try {
        q = await Promise.race([
          this.broker!.getQuote(this.epic),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
        ]);
      } catch {
        q = null;
      }
      if (!q) {
        // Live quote miss — still manage on cached quote when present
        if (this.last_quote) {
          await this.manageOnlyTick(this.last_bars, this.last_quote);
        }
        return;
      }
      // Missing ts_ms → fail closed (aged), never forge Date.now() freshness
      const quoteTs =
        q.ts_ms != null && Number.isFinite(q.ts_ms) && q.ts_ms > 0
          ? q.ts_ms
          : Date.now() - 60_000;
      const quote: Quote = {
        bid: q.bid,
        ask: q.ask,
        mid: q.mid,
        spread: q.spread,
        epic: q.epic || this.epic,
        ts_ms: quoteTs,
        min_stop_distance: q.min_stop_distance ?? null,
        market_status: q.market_status ?? null,
        digits: q.digits,
        point: q.point,
      };
      this.last_quote = quote;
      this.quoteFromDiskCache = false;
      let bars: Bar[] = this.last_bars;
      if (
        bars.length < 5 &&
        typeof this.broker!.getHistoryBars === 'function'
      ) {
        try {
          const hist = await Promise.race([
            this.broker!.getHistoryBars!(this.epic, 60),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
          ]);
          if (hist && hist.ok && Array.isArray(hist.bars) && hist.bars.length >= 5) {
            const now = Date.now();
            bars = hist.bars.map((b, i) => ({
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
              ts_ms: b.ts_ms ?? now - (hist.bars.length - i) * 60_000,
            }));
            this.last_bars = bars;
            this.barsFromDiskCache = false;
            this.structure_seed_source =
              this.broker instanceof CapitalBroker && !this.broker.paper
                ? 'capital_ohlc'
                : hist.detail || 'broker_history';
          }
        } catch {
          /* keep short/empty — manage-on-quote still runs hard exits */
        }
      }
      if (bars.length >= 5) this.persistMarketCache();
      // Always manage when we have a live quote — hard STOP/TP + account snapshot
      // must not wait for OHLC history after Recover / Stop-with-opens.
      await this.manageOnlyTick(bars, quote);
    } catch (e) {
      logMasterError({
        module: 'runtime.bootstrap_manage',
        error_type: 'bootstrap_failed',
        message: e instanceof Error ? e.message : String(e),
        context: { epic: this.epic, opens: this.positions.count() },
      });
    } finally {
      // Always arm manage loop when opens exist — Recover must not leave them unmanaged
      this.ensureManageLoop();
    }
  }

  /**
   * PAPER restart / hydrate: reseed in-memory broker equity from journal-rebuilt
   * account, and reseed opens from PositionManager so sync does not treat
   * restored locals as ghosts (broker_flat wipe).
   * Flat books must still hydrateAccount — otherwise the next tick's getAccount
   * overwrites recovered equity back to PaperBroker's default £10k.
   */
  private seedPaperBrokerFromPositions(): void {
    if (!(this.broker instanceof PaperBroker)) return;
    // Always restore equity/balance from recovered account (VS-System paper hydrate)
    if (
      (this.account.equity > 0 && Number.isFinite(this.account.equity)) ||
      (this.account.balance > 0 && Number.isFinite(this.account.balance))
    ) {
      this.broker.hydrateAccount({
        equity: this.account.equity,
        balance: this.account.balance,
      });
    }
    if (this.positions.count() === 0) return;
    // Prior manage ticks may have left empty-book debounce near wipe threshold
    this.emptyBrokerDebounce = { consecutive_empty: 0, miss_by_id: {} };
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

  private persistMarketCache(): void {
    if (
      !this.last_bars.length &&
      !this.last_quote &&
      !this.last_hour_bars.length &&
      !this.last_closed_10s
    )
      return;
    saveMarketCache({
      epic: this.epic,
      bars: this.last_bars,
      quote: this.last_quote,
      hour_bars: this.last_hour_bars.length ? this.last_hour_bars : null,
      hour_bars_detail: this.last_hour_bars_detail,
      closed_10s: this.last_closed_10s,
      structure_seed_source: this.structure_seed_source,
    });
  }

  /** Restore bars always; quote always as disk_cache provenance (even if aged). */
  private hydrateMarketCacheFromDisk(): void {
    const cached = loadMarketCache();
    if (!cached) return;
    if (cached.epic && cached.epic !== this.epic) return;
    if (this.last_bars.length < 5 && cached.bars.length >= 5) {
      this.last_bars = cached.bars;
      this.barsFromDiskCache = true;
      if (
        cached.structure_seed_source &&
        (!this.structure_seed_source || this.structure_seed_source === 'none')
      ) {
        this.structure_seed_source = String(cached.structure_seed_source);
      }
    }
    if (!this.last_quote && cached.quote) {
      // Always restore — aged disk quotes must paint cached · / hydrated · disk_cache,
      // never silent blank or live stale_quote before a cycle.
      this.last_quote = cached.quote;
      this.quoteFromDiskCache = true;
    }
    if (
      this.last_hour_bars.length < 6 &&
      Array.isArray(cached.hour_bars) &&
      cached.hour_bars.length >= 6
    ) {
      this.last_hour_bars = cached.hour_bars;
      this.hourBarsFromDiskCache = true;
      if (cached.hour_bars_detail) {
        this.last_hour_bars_detail = String(cached.hour_bars_detail);
      }
    }
    if (!this.last_closed_10s && cached.closed_10s) {
      this.last_closed_10s = cached.closed_10s;
      this.last_closed_10s_present = true;
      this.closed10sFromDiskCache = true;
      this.closed10sFromJournalOnly = false;
    }
  }

  /** Cached OHLC for dashboard replay — never invents bars. */
  barsSnapshot(limit = 200): Bar[] {
    const n = Math.max(1, Math.min(500, Math.floor(limit) || 200));
    return this.last_bars.slice(-n);
  }

  /**
   * Manage every open epic with a matching quote.
   * Primary quote (active cycle) gets structure/EMA from bars; other open epics
   * fetch their own broker quotes and manage without foreign GOLD structure.
   */
  private async runManageAcrossOpenEpics(input: {
    broker: MasterBroker;
    quote: Quote;
    bars: Bar[];
  }): Promise<ManageTickResult> {
    const { broker, bars } = input;
    const primaryQuote: Quote = {
      ...input.quote,
      epic: input.quote.epic || this.epic,
    };
    const merge = (
      a: ManageTickResult,
      b: ManageTickResult
    ): ManageTickResult => ({
      held: this.positions.list(),
      closed: [...a.closed, ...b.closed],
      close_failed: [...a.close_failed, ...b.close_failed],
      skipped_wrong_epic: a.skipped_wrong_epic + b.skipped_wrong_epic,
      skipped_epics: [
        ...new Set([...a.skipped_epics, ...b.skipped_epics]),
      ].sort((x, y) => x.localeCompare(y)),
    });

    const runOne = async (
      quote: Quote,
      withStructure: boolean
    ): Promise<ManageTickResult> => {
      const epicKey =
        capitalApiEpic(quote.epic || this.epic) ||
        String(quote.epic || this.epic).trim().toUpperCase();
      const instrumentBase = specForEpic(epicKey || this.epic);
      const fromQuote =
        quote.point != null && Number.isFinite(quote.point) && quote.point > 0
          ? Number(quote.point)
          : null;
      const instrument =
        fromQuote != null && fromQuote > 0
          ? { ...instrumentBase, point: fromQuote }
          : instrumentBase;
      const structure =
        withStructure && bars.length >= 5
          ? analyzeBars(bars, quote.spread)
          : null;
      const trailBuf =
        structure && structure.atr > 0
          ? structure.atr * this.cfg.trailing_buffer_atr_mult
          : 0;
      const liveEma =
        withStructure && bars.length
          ? emaTickLiveFromBars(bars, quote.mid, Date.now(), 10_000)
          : null;
      const ema3 = withStructure
        ? liveEma?.ema3 ?? (bars.length >= 3 ? emaFromBars(bars, 3) : null)
        : null;
      const ema1Pair = withStructure ? emaPairFromBars(bars, 1) : null;
      const ema3Pair = withStructure ? emaPairFromBars(bars, 3) : null;
      const liveMinStop =
        broker instanceof CapitalBroker
          ? broker.liveMinStopDistance(epicKey || this.epic)
          : quote.min_stop_distance ?? null;
      return this.positions.manageTick({
        broker,
        pipeline: this.pipeline,
        quote,
        instrument_point_value: instrument.value_per_point_per_lot,
        max_hold_ms: this.cfg.max_hold_ms,
        time_stop_max_bars: this.cfg.time_stop_max_bars,
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
        ema3,
        ema1: withStructure
          ? liveEma?.ema1 ?? ema1Pair?.cur ?? null
          : null,
        ema1_prev: withStructure
          ? liveEma?.ema1Prev ?? ema1Pair?.prev ?? null
          : null,
        ema3_prev: withStructure
          ? liveEma?.ema3Prev ?? ema3Pair?.prev ?? null
          : null,
        ema1_prev2: withStructure
          ? liveEma?.ema1Prev2 ?? ema1Pair?.prev2 ?? null
          : null,
        ema3_prev2: withStructure
          ? liveEma?.ema3Prev2 ?? ema3Pair?.prev2 ?? null
          : null,
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
        live_regime: structure?.regime ?? null,
      });
    };

    let merged = await runOne(primaryQuote, true);
    const managedKeys = new Set<string>();
    const primaryKey =
      capitalApiEpic(primaryQuote.epic) ||
      String(primaryQuote.epic || '').trim().toUpperCase();
    if (primaryKey) managedKeys.add(primaryKey);

    const fetchFailed: string[] = [];
    for (const epic of this.positions.openEpicKeys()) {
      if (primaryKey && epicsMatch(epic, primaryKey)) continue;
      let live: Quote | null = null;
      try {
        const got = await Promise.race([
          broker.getQuote(epic),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
        ]);
        if (
          got &&
          Number.isFinite(got.mid) &&
          got.mid > 0 &&
          epicsMatch(got.epic || epic, epic)
        ) {
          const liveTs =
            got.ts_ms != null && Number.isFinite(got.ts_ms) && got.ts_ms > 0
              ? got.ts_ms
              : Date.now() - 60_000;
          live = {
            bid: got.bid,
            ask: got.ask,
            mid: got.mid,
            spread: got.spread,
            epic: got.epic || epic,
            ts_ms: liveTs,
            min_stop_distance: got.min_stop_distance ?? null,
            digits: got.digits,
            point: got.point,
          };
        }
      } catch {
        live = null;
      }
      if (!live) {
        fetchFailed.push(epic);
        continue;
      }
      if (broker instanceof PaperBroker) {
        broker.setQuote({
          bid: live.bid,
          ask: live.ask,
          mid: live.mid,
          spread: live.spread,
          epic: live.epic || epic,
          ts_ms: live.ts_ms,
        });
      }
      const secondary = await runOne(live, false);
      merged = merge(merged, secondary);
      managedKeys.add(epic);
    }

    const unmanagedOpen = this.positions
      .openEpicKeys()
      .filter((e) => ![...managedKeys].some((m) => epicsMatch(m, e)));
    this.last_manage_epics = {
      managed: [...managedKeys].sort((a, b) => a.localeCompare(b)),
      quote_fetch_failed: [
        ...new Set([...fetchFailed, ...unmanagedOpen]),
      ].sort((a, b) => a.localeCompare(b)),
      at: new Date().toISOString(),
    };
    return {
      ...merged,
      held: this.positions.list(),
    };
  }

  private async manageOnlyUnlocked(bars: Bar[], quoteIn: Quote): Promise<void> {
    // Opens must manage/exit even when runtime_stopped — Recover bootstrap + Stop-with-opens
    if (this.positions.count() === 0) {
      // Flat manageOnly: still clear spent fingerprint when cool elapsed (no full tick)
      this.clearSpentEntryFingerprint();
      return;
    }
    const broker = this.broker || this.ensurePaperBroker();
    // VS-System 1s trail: pull a fresh broker tick — do not reuse frozen last_quote.
    let quote: Quote = { ...quoteIn, epic: quoteIn.epic || this.epic };
    // Paper: seed venue with caller mark first so getQuote cannot revive a stale
    // setQuote (tests / feed path that updated last_quote without touching broker).
    if (broker instanceof PaperBroker) {
      broker.setQuote({
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        spread: quote.spread,
        epic: this.epic,
        ts_ms: quote.ts_ms,
      });
    }
    try {
      const live = await Promise.race([
        broker.getQuote(this.epic),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
      ]);
      if (live && Number.isFinite(live.mid) && live.mid > 0) {
        // Missing ts_ms → fail closed (aged), never forge Date.now() freshness
        const liveTs =
          live.ts_ms != null && Number.isFinite(live.ts_ms) && live.ts_ms > 0
            ? live.ts_ms
            : Date.now() - 60_000;
        quote = {
          bid: live.bid,
          ask: live.ask,
          mid: live.mid,
          spread: live.spread,
          epic: live.epic || this.epic,
          ts_ms: liveTs,
          min_stop_distance: live.min_stop_distance ?? quote.min_stop_distance,
          digits: live.digits ?? quote.digits,
          point: live.point ?? quote.point,
        };
        // Fresh broker mark — no longer disk_cache provenance
        this.quoteFromDiskCache = false;
      }
    } catch {
      /* keep quoteIn */
    }
    this.last_bars = bars;
    this.last_quote = quote;
    this.persistMarketCache();
    if (broker instanceof Mt4FileBroker) {
      this.syncEpicFromMt4Chart(broker);
    }
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
    // Fresh MTM/account BEFORE UTC day-roll so day_start_equity seeds from live
    // equity (not hours-stale Stop-with-opens leftovers). Still before manage/sync
    // closes mutate daily_pnl (avoid fail-open day-loss wipe).
    try {
      const acctPre = await broker.getAccount();
      await this.applyVenueAccountSnapshot(broker, acctPre, quote);
    } catch {
      /* keep */
    }
    // Paper opens: defer UTC day-roll until quote is live (not disk/stale) so
    // day_start_equity is not sealed from an aged market_cache mark.
    // Capital LIVE: defer until capitalAccountProven (never wipe restored day_start).
    const deferOpenDayRoll = this.shouldDeferUtcDayRoll(quote);
    if (!deferOpenDayRoll) {
      this.rollDailyPnl();
    }

    const runPaperOrCapitalSync = async () => {
      // Reconcile broker truth on the 1s manage loop too — otherwise SL/TP fills
      // leave a ghost open until the next full tick (~2.5s) with mark-based PnL.
      // Capital: venue-wide (same as full tick) so other-epic orphans reconcile.
      const sync = await syncPositionsWithBroker(
        this.positions,
        broker,
        broker instanceof CapitalBroker ? undefined : this.epic,
        this.emptyBrokerDebounce,
        this.liveAdoptContext()
      );
      // Journal confirmed ghosts/orphans even when other tickets are still in miss-debounce.
      if (!sync.skipped) {
        await this.applySyncJournal(sync, quote);
      }
      if (broker instanceof CapitalBroker && !broker.paper) {
        if (sync.skipped) {
          this.capitalVenueOpensProven = false;
          this.clearStaleBrokerUpl();
        } else {
          this.capitalVenueOpensProven = true;
          this.capitalVenueOpens = sync.broker_count;
        }
      }
    };

    const runManageOnlyExits = async (): Promise<{ closed: number }> => {
      if (this.positions.count() === 0) {
        this.account.open_positions = 0;
        return { closed: 0 };
      }
      this.account.open_positions = this.positions.count();
      const managed = await this.runManageAcrossOpenEpics({
        broker,
        quote,
        bars,
      });
      this.last_manage_tick_ms = Date.now();
      for (const c of managed.closed) {
        if (c.outcome.pnl_proven !== false) {
          this.creditClosedDailyPnl(c.outcome.pnl);
          if (c.outcome.pnl < 0) {
            this.account.consecutive_losses += 1;
            this.last_loss_ms = Date.now();
          } else {
            this.account.consecutive_losses = 0;
          }
        }
        this.last_exit_reason = c.reason;
        const sk = c.position.decision.side
          ? setupKey(
              c.position.decision.analysis,
              c.position.decision.side,
              c.position.epic,
              c.position.decision.desk_entry_source
            )
          : null;
        this.trackPersist(
          'outcome',
          persistOutcome(c.position.opportunity_id, c.outcome, sk)
        );
        logTradeEvent({
          event: 'CLOSE',
          broker: broker.name,
          epic: c.position.epic,
          side: c.position.side,
          volume: c.outcome.volume,
          price: c.outcome.exit,
          position_id: c.position.position_id,
          intent_id: c.position.intent_id,
          opportunity_id: c.position.opportunity_id,
          desk_entry_source: c.position.decision?.desk_entry_source,
          ok: true,
          detail: c.reason,
          ...(c.outcome.pnl_proven !== false
            ? { pnl: c.outcome.pnl, fees: c.outcome.fees }
            : {}),
        });
      }
      if (managed.close_failed.length) {
        const fail = managed.close_failed[0]!;
        this.broker_detail = `close_fail:${fail.position_id}:${fail.detail}`.slice(
          0,
          400
        );
        if (!managed.closed.length) {
          this.last_exit_reason = `CLOSE_FAIL · ${fail.exit_reason} · ${fail.detail}`;
        }
        this.last_close_failed = {
          position_id: fail.position_id,
          exit_reason: fail.exit_reason,
          detail: fail.detail,
          ts: new Date().toISOString(),
        };
        for (const failRow of managed.close_failed) {
          logTradeEvent({
            event: 'CLOSE',
            broker: broker.name,
            epic: this.epic,
            side: null,
            volume: null,
            price: null,
            position_id: failRow.position_id,
            ok: false,
            detail: `${failRow.exit_reason} · ${failRow.detail}`,
          });
        }
      }
      this.account.open_positions = this.positions.count();
      return { closed: managed.closed.length };
    };

    // Paper: manage before sync so auto-fill STOP_HIT is tick-observed (exit_cycles).
    // Capital: sync first (venue UPL / empty debounce), then manage.
    let managedClosed = 0;
    if (broker instanceof PaperBroker) {
      managedClosed = (await runManageOnlyExits()).closed;
      await runPaperOrCapitalSync();
    } else {
      await runPaperOrCapitalSync();
      managedClosed = (await runManageOnlyExits()).closed;
    }
    if (managedClosed > 0) {
      this.last_close_failed = null;
      const cool = Math.max(0, this.cfg.post_exit_cooldown_ms || 0);
      this.post_exit_until_ms = Math.max(
        this.post_exit_until_ms,
        Date.now() + cool
      );
      this.persistRuntimeGates();
    }
    // Always refresh full venue account snapshot after manageOnly MTM —
    // open book (Stop-with-opens) must not leave Equity/Peak/Available/Tradeable
    // or Capital prove stale until the next full tick.
    try {
      const acct = await broker.getAccount();
      await this.applyVenueAccountSnapshot(broker, acct, quote);
    } catch {
      /* keep */
    }
    this.account.open_positions = this.positions.count();
    this.trackPersist('open_positions', saveOpenPositions(this.positions.list()));
    // Flat after manage/sync close + cool elapsed → clear spent fingerprint (full-tick parity)
    this.clearSpentEntryFingerprint();
    if (this.positions.count() === 0) this.clearManageLoop();
  }

  status(): MasterStatus {
    // Dashboard honesty before Start/Recover — seed monitor from disk once
    this.ensureMonitorHydrated();
    const closeSlices = this.pipeline.journal.allCloseOutcomes();
    // Unproven Capital closes (pnl often 0) must not skew expectancy / MC / KPIs
    const provenSlices = closeSlices.filter((o) => o.pnl_proven !== false);
    const tradedProven = this.pipeline.journal
      .traded()
      .filter((t) => t.outcome && t.outcome.pnl_proven !== false);
    const perf = provenSlices.length
      ? fromOutcomes(provenSlices)
      : computePerformance(tradedProven);
    const deskEntryPerf = performanceByDeskEntry(
      tradedProven.length ? tradedProven : this.pipeline.journal.traded(),
      loadDecisionEvents(500)
    );
    const deskExpectancy = expectancyByDeskSource(this.pipeline.expectancy.all());
    const pnls = provenSlices.length
      ? provenSlices.map((o) => o.pnl)
      : tradedProven.map((t) => t.outcome!.pnl);
    const quote = this.last_quote;
    const pv = specForEpic(this.epic).value_per_point_per_lot;
    const capitalLiveAttached =
      this.broker instanceof CapitalBroker && !this.broker.paper;
    const quoteAgeMs = quote
      ? Math.max(0, Date.now() - (quote.ts_ms || 0))
      : null;
    // Armed or running — stale quote must not advertise LIVE_ARMED as healthy
    const liveQuoteStale =
      this.cfg.mode === 'LIVE' &&
      capitalLiveAttached &&
      (quote == null ||
        quoteAgeMs == null ||
        quoteAgeMs > this.cfg.stale_quote_ms);
    const opens = this.positions.list();
    const quoteEpic = quote?.epic || this.epic;
    const opensMatchingQuote = opens.filter((p) =>
      quoteMatchesPosition({ epic: quoteEpic }, p.epic)
    );
    const otherEpicOpens = opens.filter(
      (p) => !quoteMatchesPosition({ epic: quoteEpic }, p.epic)
    );
    const floatingRaw = quote
      ? floatingUnrealizedPnl(
          opensMatchingQuote,
          quote,
          pv,
          capitalLiveAttached
        )
      : null;
    // Capital LIVE: unknown / unread venue UPL (null or 0) → null float
    // Only require UPL on quote-matching opens — other-epic opens are excluded from Float UPL
    const floating =
      capitalLiveAttached &&
      opensMatchingQuote.length > 0 &&
      opensMatchingQuote.some((p) => usableBrokerUpl(p.broker_upl) == null)
        ? null
        : floatingRaw;
    const streamHealthy =
      this.broker instanceof CapitalBroker
        ? this.broker.isMarketStreamHealthy(undefined, this.epic)
        : null;
    const monitoringRaw = this.monitor.snapshot(
      quote ? Math.max(0, Date.now() - (quote.ts_ms || 0)) : null
    );
    const cyclePending = !this.last_market;
    // Disk-hydrated monitor must not look like a live alert/spread gate
    const monHydrated = monitoringRaw.hydrated === true;
    const monBlockRaw = monitoringRaw.entry_block_reason;
    const monitoring = {
      ...monitoringRaw,
      hydrated: monHydrated,
      entry_block_reason:
        monHydrated && monBlockRaw && !String(monBlockRaw).startsWith('hydrated ·')
          ? `hydrated · ${monBlockRaw}`
          : monBlockRaw,
    };
    const rawBlockReason =
      this.last_decision?.block_reason ||
      monitoring.entry_block_reason ||
      this.last_risk?.reasons.join(',') ||
      null;
    // Journal / disk Why must not paint as the current cycle block
    let lastBlockReason =
      rawBlockReason && cyclePending
        ? String(rawBlockReason).startsWith('hydrated ·')
          ? String(rawBlockReason)
          : `hydrated · ${rawBlockReason}`
        : rawBlockReason;
    // Operator honesty: evaluateRisk fail-closes while daily_pnl_day lags UTC
    // today — surface utc_day_roll_deferred on Why even before a risk tick, and
    // ahead of a stale decision block_reason that would otherwise mask it.
    const utcDayNow = new Date().toISOString().slice(0, 10);
    const dailyPnlDayLagged =
      this.account.daily_pnl_day != null &&
      String(this.account.daily_pnl_day).trim() !== '' &&
      String(this.account.daily_pnl_day).slice(0, 10) !== utcDayNow;
    if (dailyPnlDayLagged) {
      const bare = lastBlockReason
        ? String(lastBlockReason).replace(/^hydrated · /, '')
        : '';
      if (!bare.includes('utc_day_roll_deferred')) {
        const merged = bare
          ? `utc_day_roll_deferred,${bare}`
          : 'utc_day_roll_deferred';
        lastBlockReason = cyclePending ? `hydrated · ${merged}` : merged;
      }
    }
    return {
      mode: this.cfg.mode,
      running: this.running,
      kill_switch: this.cfg.kill_switch,
      epic: this.epic,
      ai_mode: this.cfg.ai_mode,
      owns_pipeline: this.ownsPipelineEffective(),
      // Same rule as marketCoreEntryIntentsAllowed — avoid import cycle via deskBridge
      market_core_intents_allowed:
        (process.env.MASTER_ALLOW_MARKET_CORE_INTENTS || '').trim() === 'true' ||
        !this.ownsPipelineEffective(),
      manage_owner: this.resolveManageOwnerStatus(),
      broker: this.broker?.name ?? null,
      broker_detail: this.broker_detail,
      primary_live_venue: 'capital.com_api_direct',
      capital_env_present: capitalEnvPresent(),
      capital_desk_creds_seen: this.capitalDeskCredsSeen,
      capital_credential_source: this.capitalCredentialSource(),
      capital_creds_available: capitalEnvPresent() || this.capitalDeskCredsSeen,
      capital_live_attached: this.capitalLiveAttached(),
      capital_account_proven:
        this.broker instanceof CapitalBroker && !this.broker.paper
          ? this.capitalAccountProven
          : null,
      capital_venue_opens: this.capitalVenueOpens,
      capital_venue_opens_proven: this.capitalVenueOpensProven,
      // Roll-exec defer OR sealed-day lag (flat paper can lag without open-mark defer)
      utc_day_roll_deferred:
        this.shouldDeferUtcDayRoll(quote) || dailyPnlDayLagged,
      last_decision: this.last_decision,
      last_risk: this.last_risk,
      last_block_reason: lastBlockReason,
      last_execution_detail: this.last_execution_detail,
      last_exit_reason: this.last_exit_reason,
      last_client_fanout: this.last_client_fanout,
      last_close_failed: this.last_close_failed,
      last_ai_allow_close:
        this.cfg.ai_mode === 'off' ? true : this.last_ai_allow_close,
      buy_score: this.last_decision?.buy?.score ?? 0,
      sell_score: this.last_decision?.sell?.score ?? 0,
      buy_filter: this.last_decision?.buy
        ? {
            // Never forge live-pass from journal hydrate — need last_market cycle
            ok: !!(this.last_market && this.last_decision.buy.filter_ok),
            reason: !this.last_market
              ? 'hydrated'
              : this.last_decision.buy.filter_reason ?? null,
            score: this.last_decision.buy.score ?? 0,
            valid: !!this.last_decision.buy.valid,
          }
        : null,
      sell_filter: this.last_decision?.sell
        ? {
            ok: !!(this.last_market && this.last_decision.sell.filter_ok),
            reason: !this.last_market
              ? 'hydrated'
              : this.last_decision.sell.filter_reason ?? null,
            score: this.last_decision.sell.score ?? 0,
            valid: !!this.last_decision.sell.valid,
          }
        : null,
      pipeline_stages: (() => {
        const m = this.last_market;
        const d = this.last_decision;
        const r = this.last_risk;
        // Sticky last_market must not forge green while a LIVE quote is DATA_STALE.
        // Disk-cache / pre-cycle quotes must not take the live stale_quote stage path.
        const liveQuoteStaleForStages =
          !!m &&
          !this.quoteFromDiskCache &&
          quote != null &&
          quoteAgeMs != null &&
          quoteAgeMs > this.cfg.stale_quote_ms;
        // Fail-closed: missing filter_ok (journal hydrate scores-only) must not forge green
        const buyOk = d?.buy?.filter_ok === true;
        const sellOk = d?.sell?.filter_ok === true;
        const filterPass = !!(d && (buyOk || sellOk));
        const filterEvidence =
          d?.buy != null &&
          d?.sell != null &&
          (typeof d.buy.filter_ok === 'boolean' ||
            typeof d.sell.filter_ok === 'boolean');
        const brokerName = this.broker?.name ?? null;
        const opens = this.positions.count();
        const managedOnce = this.last_manage_tick_ms > 0;
        const manageArmed = !!this.manageTimer;
        const manageAgeSec = managedOnce
          ? Math.max(0, Math.round((Date.now() - this.last_manage_tick_ms) / 1000))
          : null;
        const decisionRows = loadDecisionEvents(1);
        const tradeRows = loadTradeEvents(1);
        const oppCount = this.pipeline.journal.opportunities.length;
        const hasJournalEvidence =
          perf.trades > 0 ||
          decisionRows.length > 0 ||
          tradeRows.length > 0 ||
          oppCount > 0;
        // Disk market_cache evidence for validate/normalize — never forge green
        const diskCacheEvidence =
          !m &&
          (this.barsFromDiskCache || this.quoteFromDiskCache) &&
          this.last_bars.length >= 5;
        const diskMv =
          diskCacheEvidence && quote != null
            ? validateMarket(this.last_bars, quote, {
                stale_ms: this.cfg.stale_quote_ms,
              })
            : null;
        const diskValidateDetail = diskMv
          ? `hydrated · disk_cache · Q=${diskMv.quality.toFixed(2)}${
              diskMv.reasons.length
                ? ` · ${diskMv.reasons.slice(0, 2).join('|')}`
                : ''
            }`
          : diskCacheEvidence
            ? `hydrated · disk_cache · ${this.last_bars.length} bars`
            : null;
        const diskNormalizeDetail = diskMv
          ? `hydrated · disk_cache · ${diskMv.bars.length}/${this.last_bars.length} bars`
          : diskCacheEvidence
            ? `hydrated · disk_cache · ${this.last_bars.length} bars`
            : null;
        return {
          market_validation: {
            ok: !!(m && m.ok && !liveQuoteStaleForStages),
            detail: liveQuoteStaleForStages
              ? `stale_quote · age=${Math.round((quoteAgeMs || 0) / 1000)}s`
              : m
                ? `Q=${m.quality.toFixed(2)}${m.reasons.length ? ` · ${m.reasons.slice(0, 2).join('|')}` : ''}`
                : diskValidateDetail || 'no cycle',
          },
          normalization: {
            // Never forge green after failed validation (flat_tape / stale quote)
            ok: !!(m && m.ok && m.bars_out >= 5 && !liveQuoteStaleForStages),
            detail: liveQuoteStaleForStages
              ? `${m ? `${m.bars_out}/${m.bars_in} bars · ` : ''}stale_quote`
              : m
                ? `${m.bars_out}/${m.bars_in} bars${
                    !m.ok && m.reasons.length
                      ? ` · ${m.reasons.slice(0, 2).join('|')}`
                      : !m.ok
                        ? ' · invalid'
                        : ''
                  }`
                : diskNormalizeDetail || 'no cycle',
          },
          analysis_regime: {
            // Never forge green from journal-hydrate alone — need proven last_market
            ok: !!(
              m &&
              m.ok &&
              !liveQuoteStaleForStages &&
              d?.analysis?.regime &&
              d.analysis.regime !== 'UNKNOWN'
            ),
            detail: liveQuoteStaleForStages
              ? `stale_quote · ${d?.analysis?.regime || '—'}`
              : !m
                ? d?.analysis
                  ? // Align with Stage·dual/filters/decision — journal evidence, not live
                    `hydrated · ${d.analysis.regime}:${d.analysis.market_state}`
                  : '—'
                : !m.ok
                  ? `invalid market · ${d?.analysis?.regime || '—'}`
                  : d?.analysis
                    ? `${d.analysis.regime}:${d.analysis.market_state}`
                    : '—',
          },
          dual_candidates: {
            // Fail-closed: score-only hydrate lacks components; full hydrate still needs a cycle
            ok: !!(m && d?.buy?.components && d?.sell?.components),
            detail: !d
              ? '—'
              : !m
                ? d.buy?.components && d.sell?.components
                  ? `hydrated · B${Number(d.buy.score).toFixed(3)}/S${Number(d.sell.score).toFixed(3)}`
                  : 'hydrated · no candidate evidence'
                : d.buy?.components && d.sell?.components
                  ? `B${Number(d.buy.score).toFixed(3)}/S${Number(d.sell.score).toFixed(3)}`
                  : 'no candidate evidence',
          },
          filters: {
            // Never forge green from journal-hydrate alone — need a live cycle
            ok: !!(m && filterPass),
            detail: !d
              ? '—'
              : !m
                ? !filterEvidence
                  ? 'hydrated · no filter evidence'
                  : `hydrated · BUY ${d.buy.filter_ok ? 'ok' : d.buy.filter_reason || 'fail'} · SELL ${d.sell.filter_ok ? 'ok' : d.sell.filter_reason || 'fail'}`
                : !filterEvidence
                  ? 'no filter evidence'
                  : `BUY ${d.buy.filter_ok ? 'ok' : d.buy.filter_reason || 'fail'} · SELL ${d.sell.filter_ok ? 'ok' : d.sell.filter_reason || 'fail'}`,
          },
          decision: {
            // Never forge green from journal-hydrate alone — need a live cycle
            ok: !!(
              m &&
              d &&
              (d.kind === 'BUY' ||
                d.kind === 'SELL' ||
                d.kind === 'WAIT' ||
                d.kind === 'BLOCK')
            ),
            detail: !d
              ? '—'
              : !m
                ? `hydrated · ${d.kind}${d.block_reason ? ` · ${d.block_reason}` : ''}`
                : `${d.kind}${d.block_reason ? ` · ${d.block_reason}` : ''}`,
          },
          risk: {
            // Sticky last_risk without a live cycle must not forge Stage·risk
            ok: !!(m && r && (r.allowed || r.reasons.length > 0)),
            detail: !r
              ? '—'
              : !m
                ? `hydrated · ${
                    r.allowed
                      ? `vol=${r.volume}`
                      : r.reasons.slice(0, 2).join('|') || 'blocked'
                  }`
                : r.allowed
                  ? `vol=${r.volume}`
                  : r.reasons.slice(0, 2).join('|') || 'blocked',
          },
          execution: {
            // Never forge green from journal-hydrate alone — need a live cycle
            ok: !!(this.last_execution_detail && m),
            detail: !this.last_execution_detail
              ? '—'
              : !m
                ? `hydrated · ${this.last_execution_detail}`
                : this.last_execution_detail,
          },
          broker: (() => {
            if (!this.broker || !brokerName) {
              // Disk-hydrated book before attach must not paint hard-bad `none`
              return {
                ok: false,
                detail: this.bookHydrated
                  ? 'hydrated · none · awaiting attach'
                  : 'none',
              };
            }
            // Capital LIVE: attach alone must not forge green while account unread
            if (this.broker instanceof CapitalBroker && !this.broker.paper) {
              if (!this.capitalAccountProven) {
                return {
                  ok: false,
                  detail: `${brokerName}:live · account unproven`,
                };
              }
              return { ok: true, detail: `${brokerName}:live` };
            }
            return {
              ok: true,
              detail: `${brokerName}${this.broker.paper ? ':paper' : ':live'}`,
            };
          })(),
          position_manager: {
            // Holding requires manage evidence; flat is ok only after a real manageTick
            ok: opens > 0 ? managedOnce || manageArmed : managedOnce,
            detail: (() => {
              // Book hydrate before manageTick must not paint hard-bad
              const hyd =
                this.bookHydrated && !managedOnce ? 'hydrated · ' : '';
              if (managedOnce) {
                return `open=${opens} · managed ${manageAgeSec}s ago`;
              }
              if (opens > 0) {
                return manageArmed
                  ? `${hyd}open=${opens} · manage armed`
                  : `${hyd}open=${opens} · awaiting manage`;
              }
              return hyd
                ? `${hyd}flat · awaiting manage`
                : 'flat · manage never ran';
            })(),
          },
          exit: {
            // Journal exit_reason alone must not forge green — need a live cycle
            ok: !!(this.last_exit_reason && m),
            detail: !this.last_exit_reason
              ? opens > 0
                ? 'holding'
                : 'flat · no exit yet'
              : !m
                ? `hydrated · ${this.last_exit_reason}`
                : this.last_exit_reason,
          },
          journal: {
            // Persist fail or empty audit → not green (never forge empty as ok)
            // Disk-hydrated audit stays green but marks hydrated until a live cycle
            ok: this.persist_ok && hasJournalEvidence,
            detail: (() => {
              const hyd = this.bookHydrated && !m ? 'hydrated · ' : '';
              if (!this.persist_ok) {
                return `persist fail${this.last_persist_error ? ` · ${this.last_persist_error}` : ''}`;
              }
              if (decisionRows.length > 0 || tradeRows.length > 0) {
                return `${hyd}dec=${decisionRows.length} trades_ev=${tradeRows.length} opps=${oppCount}`;
              }
              if (oppCount > 0) {
                return `${hyd}opps=${oppCount} · awaiting outcome`;
              }
              return 'no journal';
            })(),
          },
          performance: {
            // KPI stage — green only with proven closed trades (not decisions alone)
            // Disk-hydrated KPIs stay green but mark hydrated until a live cycle
            ok: this.persist_ok && perf.trades > 0,
            detail: (() => {
              const hyd = this.bookHydrated && !m ? 'hydrated · ' : '';
              if (!this.persist_ok) {
                return `persist fail${this.last_persist_error ? ` · ${this.last_persist_error}` : ''}`;
              }
              if (perf.trades > 0) {
                return `${hyd}trades=${perf.trades} pnl=${Number(perf.total_pnl).toFixed(2)} exp=${Number(perf.expectancy).toFixed(3)}`;
              }
              if (hasJournalEvidence) {
                return `${hyd}no KPI · awaiting closed trades`;
              }
              return 'no performance';
            })(),
          },
        };
      })(),
      // Regime/market_state cards — never look live from journal hydrate alone
      regime: (() => {
        const raw = this.last_decision?.analysis.regime ?? 'UNKNOWN';
        if (!this.last_market && this.last_decision) return `hydrated · ${raw}`;
        return raw;
      })(),
      market_state: (() => {
        const raw = this.last_decision?.analysis.market_state ?? '—';
        if (!this.last_market && this.last_decision) return `hydrated · ${raw}`;
        return raw;
      })(),
      last_market: this.last_market,
      expectancy_would_block: this.pipeline.expectancy
        .all()
        .filter(
          (e) =>
            e.samples >= this.cfg.min_expectancy_samples && !e.positive
        )
        .map((e) => ({
          setup_key: e.setup_key,
          ev: e.ev,
          samples: e.samples,
        })),
      expectancy_gate_armed: !!this.cfg.require_positive_expectancy,
      market_setup: (() => {
        const s =
          this.last_market_setup ||
          (() => {
            const cur = this.pipeline.getMarketSetup();
            return cur
              ? {
                  kind: cur.kind,
                  side: cur.side,
                  status: cur.status,
                  reason: cur.reason,
                  confirm: cur.confirm,
                }
              : null;
          })();
        if (!s) return null;
        if (!this.last_market) {
          return {
            ...s,
            reason: s.reason.startsWith('hydrated ·')
              ? s.reason
              : `hydrated · ${s.reason}`,
          };
        }
        return s;
      })(),
      cycles_by_epic: Object.fromEntries(this.cycleByEpic.entries()),
      cycles_by_epic_hydrated: this.epicCycleStashHydrated,
      setup_gate_armed: !!this.cfg.require_armed_setup,
      desk_entry: this.last_desk_entry,
      hour_bias: this.last_hour_bias ?? this.pipeline.getStructureBook()?.hour_bias ?? null,
      closed_10s_present: this.last_closed_10s_present || !!this.last_closed_10s,
      closed_10s_cached: this.closed10sFromDiskCache && !!this.last_closed_10s,
      closed_10s_source: this.last_closed_10s
        ? this.closed10sFromDiskCache
          ? 'disk_cache'
          : 'live'
        : this.closed10sFromJournalOnly && this.last_closed_10s_present
          ? 'journal'
          : null,
      entry_gates: (() => {
        const now = Date.now();
        const weekend = isWeekendUtc(now);
        const news = newsBlocksEntries(
          this.cfg.block_high_impact_news,
          now,
          this.epic
        );
        const hoursOk = withinTradingHours(this.cfg.trading_hours, now);
        const cyclePending = !this.last_market;
        const rawSession =
          this.last_decision?.analysis?.session || 'UNKNOWN';
        // Journal session must not look live or drive session_blocks until a cycle
        const sessionHydrated = cyclePending && !!this.last_decision;
        const sessionLabel = sessionHydrated
          ? `hydrated · ${rawSession}`
          : rawSession;
        return {
          news_cfg_on: !!this.cfg.block_high_impact_news,
          news_blocks: !!news.blocked,
          news_detail: news.reason || null,
          block_off_hours: !!this.cfg.block_off_hours,
          weekend,
          session: sessionLabel,
          session_hydrated: sessionHydrated,
          session_blocks:
            !!this.cfg.block_off_hours &&
            (weekend || (!sessionHydrated && rawSession === 'OFF_HOURS')),
          hours_ok: hoursOk,
        };
      })(),
      account:
        this.broker instanceof CapitalBroker &&
        !this.broker.paper &&
        !this.capitalAccountProven
          ? {
              ...this.account,
              // Null — never advertise forged £0 as a flat Capital account
              equity: null,
              balance: null,
              available_to_deal: null,
              trade_allowed: false,
              day_start_equity: null,
              peak_equity: null,
              daily_pnl: null,
              consecutive_losses: null,
            }
          : this.account,
      open_positions: this.positions.count(),
      performance: perf,
      performance_by_desk_entry: deskEntryPerf,
      expectancy_by_desk_entry: deskExpectancy,
      monte_carlo: pnls.length ? monteCarlo(pnls, 200) : null,
      opportunities: this.pipeline.journal.opportunities.length,
      traded: Math.max(tradedProven.length, provenSlices.length),
      blocked: this.pipeline.journal.blocked().length,
      health: this.cfg.kill_switch
        ? 'KILL_SWITCH'
        : // Capital LIVE unproven must not be masked by persist flakiness —
          // operator needs the account-proof signal; persist_ok stays separate.
          this.cfg.mode === 'LIVE' &&
            this.capitalLiveAttached() &&
            !this.capitalAccountProven
          ? 'LIVE_ACCOUNT_UNPROVEN'
          : liveQuoteStale
            ? 'LIVE_QUOTE_STALE'
            : this.cfg.mode === 'LIVE' &&
                this.capitalLiveAttached() &&
                !this.capitalVenueOpensProven
              ? 'LIVE_VENUE_UNPROVEN'
              : !this.persist_ok
                ? 'PERSIST_DEGRADED'
                : this.cfg.mode === 'LIVE'
                  ? this.capitalLiveAttached()
                    ? this.running
                      ? 'LIVE_RUNNING'
                      : 'LIVE_ARMED'
                    : this.running
                      ? 'LIVE_NO_CAPITAL'
                      : 'LIVE_UNATTACHED'
                  : this.positions.count() > 0 && !this.running
                    ? this.manageTimer
                      ? 'OPENS_MANAGE_ONLY'
                      : 'OPENS_UNMANAGED'
                    : this.desired_running && !this.running
                      ? 'RESUME_PENDING'
                      : this.running
                        ? 'PAPER_RUNNING'
                        : 'OK',
      recovered: this.recovered,
      desired_running: this.desired_running,
      persist_ok: this.persist_ok,
      last_persist_error: this.last_persist_error,
      entries_armed: this.entries_armed,
      entries_pause_reason: this.entries_pause_reason,
      structure_seed_source: this.structure_seed_source,
      bars_available: this.last_bars.length,
      bars_cached: this.barsFromDiskCache,
      hour_bars_available: this.last_hour_bars.length,
      hour_bars_cached: this.hourBarsFromDiskCache,
      hour_bars_source: this.last_hour_bars.length
        ? this.hourBarsFromDiskCache
          ? 'disk_cache'
          : 'live'
        : null,
      news_window: resolveNewsWindow(Date.now(), this.epic),
      quote: quote
        ? {
            mid: quote.mid,
            bid: quote.bid,
            ask: quote.ask,
            spread: quote.spread,
            age_ms: Math.max(0, Date.now() - (quote.ts_ms || 0)),
            stale_quote_ms: this.cfg.stale_quote_ms,
            // Disk-cache age is provenance, not live DATA_STALE
            stale:
              !this.quoteFromDiskCache &&
              Math.max(0, Date.now() - (quote.ts_ms || 0)) >
                this.cfg.stale_quote_ms,
            cached: this.quoteFromDiskCache,
            source: this.quoteFromDiskCache ? 'disk_cache' : 'live',
            stream_healthy: streamHealthy,
          }
        : null,
      floating_pnl: floating,
      floating_pnl_cached:
        floating != null &&
        this.quoteFromDiskCache === true &&
        opensMatchingQuote.length > 0,
      floating_pnl_epic_scoped: otherEpicOpens.length > 0,
      manage_epics: (() => {
        const managed = this.last_manage_epics?.managed ?? [];
        const failed = this.last_manage_epics?.quote_fetch_failed ?? [];
        const openKeys = this.positions.openEpicKeys();
        const unmanaged_open = openKeys.filter(
          (e) => !managed.some((m) => epicsMatch(m, e))
        );
        return {
          managed,
          quote_fetch_failed: failed,
          unmanaged_open,
          at: this.last_manage_epics?.at ?? null,
        };
      })(),
      reject_cooldown_ms: Math.max(0, this.reject_until_ms - Date.now()),
      post_exit_cooldown_ms: Math.max(0, this.post_exit_until_ms - Date.now()),
      recent_errors: loadMasterErrors(8).map((e) => ({
        ts: e.ts,
        module: e.module,
        error_type: e.error_type,
        message: e.message,
      })),
      manage: pickManageConfig(this.cfg),
      monitoring,
      persist_backend: resolvePersistBackend(),
      journal_audit: (() => {
        const stateDir =
          process.env.MASTER_STATE_DIR ||
          process.env.MASTER_GATES_DIR ||
          join(process.cwd(), '.master-state');
        const decisions = loadDecisionEvents(96).length;
        const trades = loadTradeEvents(50).length;
        const decision_sidecar = existsSync(
          join(stateDir, 'decision_journal.jsonl')
        );
        const trade_sidecar = existsSync(
          join(stateDir, 'trade_event_journal.jsonl')
        );
        return {
          decisions,
          trades,
          decision_sidecar,
          trade_sidecar,
          healed_from_persist:
            this.lastAuditJournalHydrate?.wrote_jsonl === true,
          last_hydrate: this.lastAuditJournalHydrate,
        };
      })(),
      recent_decisions: (() => {
        // Prefer BLOCK/TRADE over WAIT floods so dashboard shows actionable audit
        const scanned = loadDecisionEvents(96);
        const important = scanned.filter(
          (e) =>
            e.executed ||
            e.kind === 'BLOCK' ||
            e.kind === 'TRADE' ||
            (e.block_reason != null && String(e.block_reason).trim() !== '')
        );
        const waits = scanned.filter((e) => !important.includes(e));
        return [...important, ...waits].slice(0, 12).map((e) => ({
          ts: e.ts,
          kind: e.kind,
          executed: e.executed,
          block_reason: e.block_reason,
          execution_detail: e.execution_detail,
          opportunity_id: e.opportunity_id,
          buy_score: e.buy_score,
          sell_score: e.sell_score,
          desk_entry_source: e.desk_entry_source ?? null,
          desk_entry_side: e.desk_entry_side ?? null,
          hour_bias: e.hour_bias ?? null,
          closed_10s_present: e.closed_10s_present ?? null,
        }));
      })(),
      recent_trades: loadTradeEvents(12).map((e) => {
        const stamped = normalizeTradeDeskSource(e.desk_entry_source);
        const opp = e.opportunity_id
          ? this.pipeline.journal.opportunities.find(
              (o) => o.id === e.opportunity_id
            )
          : null;
        const raw = opp?.decision?.desk_entry_source;
        const fromDec: 'setup' | 'move' | 'none' | null =
          raw === 'setup' || raw === 'move' || raw === 'none' ? raw : null;
        const fromKey = deskSourceFromSetupKey(opp?.setup_key ?? null);
        // Prefer durable TradeEvent stamp; fall back to opportunity join.
        const desk_entry_source =
          stamped && stamped !== 'none'
            ? stamped
            : fromDec && fromDec !== 'none'
              ? fromDec
              : fromKey && fromKey !== 'none'
                ? fromKey
                : stamped || fromDec || fromKey || null;
        return {
          ts: e.ts,
          event: e.event,
          broker: e.broker,
          ok: e.ok,
          detail: e.detail,
          pnl: e.pnl,
          fees: e.fees,
          opportunity_id: e.opportunity_id,
          desk_entry_source,
        };
      }),
    };
  }
}

export const masterRuntime = new MasterRuntime();
