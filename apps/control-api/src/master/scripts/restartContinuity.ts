/**
 * Paper restart continuity — durable opens/journal survive boot hydrate
 * without broker recover; PaperBroker is reseeded so manage sync cannot
 * ghost-wipe locals; then recover still reconciles.
 *
 *   npm run master:restart-check
 */
import { mkdirSync, writeFileSync, rmSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { PaperBroker } from '../broker.js';
import {
  installFilePersist,
  ensureOperatorMetaFromStateDir,
  ensureJournalSidecarsFromStateDir,
  FilePersist,
} from '../filePersist.js';
import {
  persistOpportunity,
  persistOutcome,
  persistDecisionEvent,
  persistTradeEvent,
  saveOpenPositions,
  setPersistClient,
  MemoryPersist,
  loadOpenPositions,
  loadJournalHistory,
} from '../persist.js';
import { DualPersist } from '../dualPersist.js';
import { DEFAULT_MASTER_CONFIG, GOLD_SPEC, MasterPipeline } from '../pipeline.js';
import { PositionManager } from '../positionManager.js';
import { masterRuntime } from '../runtime.js';
import { saveMarketCache } from '../marketCache.js';
import { saveEpicCycleStash } from '../epicCycleStash.js';
import { emptySetup } from '../../services/marketSetup.js';
import { saveRuntimeGates } from '../runtimeGates.js';
import { setJournalMirror } from '../journalMirror.js';
import { loadDecisionEvents } from '../decisionJournal.js';
import { loadTradeEvents } from '../tradeEventJournal.js';

async function main() {
  const artifactDir = process.env.ARTIFACT_DIR || '/opt/cursor/artifacts';
  mkdirSync(artifactDir, { recursive: true });
  const stateDir = '/tmp/vs-master-restart-continuity';
  try {
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.env.MASTER_STATE_DIR = stateDir;
  process.env.MASTER_GATES_DIR = stateDir;
  installFilePersist(stateDir);

  const pipe = new MasterPipeline('PAPER');
  const bars = Array.from({ length: 40 }, (_, i) => {
    const o = 4400 + i * 0.5;
    return { open: o, high: o + 1, low: o - 0.2, close: o + 0.4, ts_ms: i * 60_000 };
  });
  const cycle = await pipe.runCycle({
    bars,
    quote: {
      bid: 4419.8,
      ask: 4420.2,
      mid: 4420,
      spread: 0.4,
      ts_ms: Date.now(),
    },
    account: {
      equity: 10_000,
      balance: 10_000,
      currency: 'GBP',
      open_positions: 0,
      daily_pnl: 0,
      peak_equity: 10_000,
      consecutive_losses: 0,
    },
    instrument: GOLD_SPEC,
    cfg: { ...DEFAULT_MASTER_CONFIG, mode: 'PAPER', block_off_hours: false },
  });

  const pm = new PositionManager();
  pm.register({
    position_id: 'restart-pos-1',
    opportunity_id: cycle.opportunity.id,
    intent_id: 'restart-intent-1',
    epic: 'GOLD',
    side: 'BUY',
    size: 0.1,
    entry: 4410,
    stop_loss: 4390,
    take_profit: 4450,
    decision: cycle.decision,
  });
  await saveOpenPositions(pm.list());
  await persistOpportunity(cycle.opportunity);
  await persistOutcome(
    cycle.opportunity.id,
    {
      position_id: 'restart-closed-1',
      side: 'BUY',
      entry: 4410,
      exit: 4418,
      volume: 0.1,
      pnl: 8,
      fees: 0.1,
      slippage: 0,
      mae: 1,
      mfe: 9,
      r_multiple: 1.2,
      hold_ms: 30_000,
      exit_reason: 'TakeProfit',
    },
    'TREND:BUY'
  );
  // Decision + trade audit journals must survive restart (journal→performance stage)
  const { logDecisionEvent } = await import('../decisionJournal.js');
  const { logTradeEvent } = await import('../tradeEventJournal.js');
  logDecisionEvent({
    kind: cycle.decision.kind,
    epic: 'GOLD',
    mode: 'PAPER',
    opportunity_id: cycle.opportunity.id,
    buy_score: cycle.decision.buy?.score ?? 0,
    sell_score: cycle.decision.sell?.score ?? 0,
    block_reason: cycle.decision.block_reason,
    executed: true,
    execution_detail: 'restart_check_seed',
  });
  logTradeEvent({
    event: 'OPEN',
    broker: 'PAPER',
    epic: 'GOLD',
    side: 'BUY',
    volume: 0.1,
    price: 4410,
    position_id: 'restart-pos-1',
    intent_id: 'restart-intent-1',
    opportunity_id: cycle.opportunity.id,
    ok: true,
    detail: 'restart_check_seed_open',
  });
  logTradeEvent({
    event: 'CLOSE',
    broker: 'PAPER',
    epic: 'GOLD',
    side: 'BUY',
    volume: 0.1,
    price: 4418,
    position_id: 'restart-closed-1',
    opportunity_id: cycle.opportunity.id,
    ok: true,
    detail: 'TakeProfit',
    pnl: 8,
    fees: 0.1,
  });
  // Cached bars/quote so hydrate manage can tick without live feed
  saveMarketCache({
    epic: 'GOLD',
    bars,
    quote: {
      bid: 4415,
      ask: 4415.4,
      mid: 4415.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    },
    structure_seed_source: 'restart_check',
  });
  saveEpicCycleStash({
    setups_by_epic: {
      GOLD: {
        setup: {
          ...emptySetup('restart_gold'),
          kind: 'CONTINUATION',
          side: 'BUY',
          status: 'ARMED',
          reason: 'restart_gold',
          confirm: 2,
        },
        structure: null,
      },
      SILVER: {
        setup: {
          ...emptySetup('restart_silver'),
          kind: 'CONTINUATION',
          side: 'SELL',
          status: 'FORMING',
          reason: 'restart_silver',
          confirm: 0,
        },
        structure: null,
      },
    },
    cycles_by_epic: {
      GOLD: {
        at: new Date().toISOString(),
        market_setup: {
          kind: 'CONTINUATION',
          side: 'BUY',
          status: 'ARMED',
          reason: 'restart_gold',
          confirm: 2,
        },
        last_market: {
          ok: true,
          quality: 0.9,
          reasons: [],
          bars_in: bars.length,
          bars_out: bars.length,
        },
        decision_kind: 'BUY',
        buy_score: 0.7,
        sell_score: 0.3,
      },
      SILVER: {
        at: new Date().toISOString(),
        market_setup: {
          kind: 'CONTINUATION',
          side: 'SELL',
          status: 'FORMING',
          reason: 'restart_silver',
          confirm: 0,
        },
        last_market: null,
        decision_kind: 'WAIT',
        buy_score: 0.2,
        sell_score: 0.5,
      },
    },
  });

  // Phase J: wipe decision/trade jsonl — DualPersist mirror must heal on boot
  const decPath = join(stateDir, 'decision_journal.jsonl');
  const tradePath = join(stateDir, 'trade_event_journal.jsonl');
  const hadDecBeforeWipe = existsSync(decPath);
  const hadTradeBeforeWipe = existsSync(tradePath);
  try {
    unlinkSync(decPath);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(tradePath);
  } catch {
    /* ignore */
  }
  // Simulate cold process: drop in-memory mirror, reinstall from master_state.json
  setJournalMirror(null);
  setPersistClient(null);
  installFilePersist(stateDir);
  const healViaInstall =
    existsSync(decPath) && existsSync(tradePath);
  // Also prove standalone heal helper (operator_meta path calls this too)
  try {
    unlinkSync(decPath);
    unlinkSync(tradePath);
  } catch {
    /* ignore */
  }
  setJournalMirror(null);
  setPersistClient(null);
  const healHelper = ensureJournalSidecarsFromStateDir(stateDir);
  const healOpMeta = ensureOperatorMetaFromStateDir(stateDir);
  installFilePersist(stateDir);
  const journalHealOk =
    hadDecBeforeWipe &&
    hadTradeBeforeWipe &&
    healViaInstall &&
    healHelper === true &&
    existsSync(decPath) &&
    existsSync(tradePath);

  // Phase K: DualPersist MemoryPersist primary survives FULL file wipe
  // (jsonl + master_state) — boot hydrate must heal journals from primary.
  const primary = new MemoryPersist();
  setJournalMirror(null);
  setPersistClient(null);
  const mirrorBeforeWipe = new FilePersist(stateDir);
  setPersistClient(new DualPersist(primary, mirrorBeforeWipe));
  // Copy durable rows into primary via DualPersist dual-write
  const opensForPrimary = await loadOpenPositions();
  await saveOpenPositions(opensForPrimary);
  const histForPrimary = await loadJournalHistory(50);
  for (const o of histForPrimary.opportunities) {
    if (o?.decision && o?.risk) await persistOpportunity(o);
  }
  for (const row of histForPrimary.outcomes) {
    if (row?.outcome) {
      await persistOutcome(row.opportunity_id, row.outcome, row.setup_key);
    }
  }
  for (const e of [...loadDecisionEvents(100)].reverse()) {
    await persistDecisionEvent(e);
  }
  for (const e of [...loadTradeEvents(100)].reverse()) {
    await persistTradeEvent(e);
  }
  const primaryHadDecisions = primary.decisionEvents.length >= 1;
  const primaryHadTrades = primary.tradeEvents.length >= 1;
  const primaryHadOpens = primary.positions.length >= 1;
  // Wipe ALL file state — only MemoryPersist primary remains
  setJournalMirror(null);
  setPersistClient(null);
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  const mirrorAfterWipe = new FilePersist(stateDir);
  setPersistClient(new DualPersist(primary, mirrorAfterWipe));
  const journalsGoneBeforeHydrate =
    !existsSync(decPath) && !existsSync(tradePath);
  // Re-seed market cache sidecar (not SQL-mirrored) so later manage has bars.
  // Aged quote must still hydrate as disk_cache — not live stale_quote.
  saveMarketCache({
    epic: 'GOLD',
    bars,
    quote: {
      bid: 4415,
      ask: 4415.4,
      mid: 4415.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now() - 60_000,
    },
    structure_seed_source: 'restart_check',
  });
  // Re-seed epic cycle stash (same non-SQL sidecar class as market_cache)
  saveEpicCycleStash({
    setups_by_epic: {
      GOLD: {
        setup: {
          ...emptySetup('restart_gold'),
          kind: 'CONTINUATION',
          side: 'BUY',
          status: 'ARMED',
          reason: 'restart_gold',
          confirm: 2,
        },
        structure: null,
      },
      SILVER: {
        setup: {
          ...emptySetup('restart_silver'),
          kind: 'CONTINUATION',
          side: 'SELL',
          status: 'FORMING',
          reason: 'restart_silver',
          confirm: 0,
        },
        structure: null,
      },
    },
    cycles_by_epic: {
      GOLD: {
        at: new Date().toISOString(),
        market_setup: {
          kind: 'CONTINUATION',
          side: 'BUY',
          status: 'ARMED',
          reason: 'restart_gold',
          confirm: 2,
        },
        last_market: {
          ok: true,
          quality: 0.9,
          reasons: [],
          bars_in: bars.length,
          bars_out: bars.length,
        },
        decision_kind: 'BUY',
        buy_score: 0.7,
        sell_score: 0.3,
      },
      SILVER: {
        at: new Date().toISOString(),
        market_setup: {
          kind: 'CONTINUATION',
          side: 'SELL',
          status: 'FORMING',
          reason: 'restart_silver',
          confirm: 0,
        },
        last_market: null,
        decision_kind: 'WAIT',
        buy_score: 0.2,
        sell_score: 0.5,
      },
    },
  });
  // Disk monitoring snapshot — Why / Alert block / Rel spread must mark hydrated
  writeFileSync(
    join(stateDir, 'monitoring_snapshot.json'),
    JSON.stringify({
      timestamp_utc: new Date().toISOString(),
      cycle_latency_ms: 55,
      data_freshness_ms: 1200,
      error_count: 0,
      error_rate_per_min: 0,
      instance_health: 'DEGRADED',
      relative_spread: 1.8,
      ack_latency_ms: null,
      entry_block_reason: 'alert:DATA_STALE',
      active_alerts: [
        {
          code: 'DATA_STALE',
          level: 'WARN',
          message: 'stale before restart',
        },
      ],
    }),
    'utf8'
  );

  // Simulate process restart — empty in-memory book, durable state on primary
  masterRuntime.pipeline = new MasterPipeline('PAPER');
  masterRuntime.positions = new PositionManager();
  masterRuntime.broker = null;
  masterRuntime.broker_detail = null;
  masterRuntime.running = false;
  masterRuntime.desired_running = false;
  masterRuntime.recovered = false;
  (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated = false;
  (
    masterRuntime as unknown as {
      lastAuditJournalHydrate: null;
    }
  ).lastAuditJournalHydrate = null;
  masterRuntime.last_exit_reason = null;
  masterRuntime.last_decision = null;
  masterRuntime.last_risk = null;
  masterRuntime.last_execution_detail = null;
  masterRuntime.last_quote = null;
  masterRuntime.last_bars = [];
  masterRuntime.last_market = null;
  (masterRuntime as unknown as { monitorHydrated: boolean }).monitorHydrated =
    false;
  (
    masterRuntime as unknown as {
      quoteFromDiskCache: boolean;
      barsFromDiskCache: boolean;
    }
  ).quoteFromDiskCache = false;
  (
    masterRuntime as unknown as {
      quoteFromDiskCache: boolean;
      barsFromDiskCache: boolean;
    }
  ).barsFromDiskCache = false;
  // Clear in-memory multi-epic stash — must reload from epic_cycle_stash.json
  (
    masterRuntime as unknown as {
      setupByEpic: Map<string, unknown>;
      cycleByEpic: Map<string, unknown>;
      epicCycleStashHydrated: boolean;
    }
  ).setupByEpic = new Map();
  (
    masterRuntime as unknown as {
      setupByEpic: Map<string, unknown>;
      cycleByEpic: Map<string, unknown>;
      epicCycleStashHydrated: boolean;
    }
  ).cycleByEpic = new Map();
  (
    masterRuntime as unknown as {
      epicCycleStashHydrated: boolean;
    }
  ).epicCycleStashHydrated = false;
  masterRuntime.account.daily_pnl = 0;
  // Soft exits off for sync-survival proof — EMA/BestOutcome must not steal the case
  masterRuntime.cfg = {
    ...DEFAULT_MASTER_CONFIG,
    mode: 'PAPER',
    ai_mode: 'required',
    scalp_pct_chase: false,
    soft_trail_money_arm: 0,
    be_start: 0,
    trail_start: 0,
    max_hold_ms: 0,
    block_off_hours: false,
  };
  masterRuntime.last_ai_allow_close = false;

  const hydrated = await masterRuntime.hydrateBookFromDisk();
  const stHydrate = masterRuntime.status();
  const pgPrimaryHealOk =
    primaryHadDecisions &&
    primaryHadTrades &&
    primaryHadOpens &&
    journalsGoneBeforeHydrate &&
    stHydrate.persist_backend === 'dual' &&
    stHydrate.journal_audit?.healed_from_persist === true &&
    stHydrate.journal_audit?.decision_sidecar === true &&
    stHydrate.journal_audit?.trade_sidecar === true &&
    existsSync(decPath) &&
    existsSync(tradePath);
  const hydrateSnap = {
    recovered_flag: masterRuntime.recovered,
    positions: masterRuntime.positions.count(),
    opportunities: masterRuntime.pipeline.journal.opportunities.length,
    last_exit_reason: masterRuntime.last_exit_reason,
    daily_pnl: masterRuntime.account.daily_pnl,
    last_decision_kind: masterRuntime.last_decision?.kind ?? null,
    open_positions_status: stHydrate.open_positions,
    recent_decisions: stHydrate.recent_decisions?.length ?? 0,
    recent_trades: stHydrate.recent_trades?.length ?? 0,
    cycles_by_epic_keys: Object.keys(stHydrate.cycles_by_epic || {}),
    cycles_by_epic_hydrated: stHydrate.cycles_by_epic_hydrated === true,
    cycles_gold: !!stHydrate.cycles_by_epic?.GOLD,
    cycles_silver: !!stHydrate.cycles_by_epic?.SILVER,
    journal_stage_ok: stHydrate.pipeline_stages?.journal?.ok === true,
    journal_stage_detail: stHydrate.pipeline_stages?.journal?.detail ?? null,
    journal_stage_hydrated: String(
      stHydrate.pipeline_stages?.journal?.detail || ''
    ).startsWith('hydrated ·'),
    performance_stage_ok: stHydrate.pipeline_stages?.performance?.ok === true,
    performance_stage_detail:
      stHydrate.pipeline_stages?.performance?.detail ?? null,
    performance_stage_hydrated: String(
      stHydrate.pipeline_stages?.performance?.detail || ''
    ).startsWith('hydrated ·'),
    performance_total_pnl: stHydrate.performance?.total_pnl ?? null,
    performance_trades: stHydrate.performance?.trades ?? 0,
    exit_stage_ok: stHydrate.pipeline_stages?.exit?.ok === true,
    exit_stage_detail: stHydrate.pipeline_stages?.exit?.detail ?? null,
    exit_stage_hydrated: String(
      stHydrate.pipeline_stages?.exit?.detail || ''
    ).startsWith('hydrated ·'),
    filters_stage_ok: stHydrate.pipeline_stages?.filters?.ok === true,
    filters_stage_detail: stHydrate.pipeline_stages?.filters?.detail ?? null,
    dual_candidates_stage_ok:
      stHydrate.pipeline_stages?.dual_candidates?.ok === true,
    dual_candidates_stage_detail:
      stHydrate.pipeline_stages?.dual_candidates?.detail ?? null,
    // Cycle-bound stages must stay red until a live tick sets last_market
    analysis_stage_ok: stHydrate.pipeline_stages?.analysis_regime?.ok === true,
    analysis_stage_detail:
      stHydrate.pipeline_stages?.analysis_regime?.detail ?? null,
    analysis_stage_hydrated: String(
      stHydrate.pipeline_stages?.analysis_regime?.detail || ''
    ).startsWith('hydrated ·'),
    decision_stage_ok: stHydrate.pipeline_stages?.decision?.ok === true,
    decision_stage_detail: stHydrate.pipeline_stages?.decision?.detail ?? null,
    risk_stage_ok: stHydrate.pipeline_stages?.risk?.ok === true,
    risk_stage_detail: stHydrate.pipeline_stages?.risk?.detail ?? null,
    risk_stage_hydrated: String(
      stHydrate.pipeline_stages?.risk?.detail || ''
    ).startsWith('hydrated ·'),
    floating_pnl: stHydrate.floating_pnl ?? null,
    floating_pnl_cached: stHydrate.floating_pnl_cached === true,
    execution_stage_ok: stHydrate.pipeline_stages?.execution?.ok === true,
    execution_stage_detail:
      stHydrate.pipeline_stages?.execution?.detail ?? null,
    execution_stage_hydrated: String(
      stHydrate.pipeline_stages?.execution?.detail || ''
    ).startsWith('hydrated ·'),
    market_validation_stage_ok:
      stHydrate.pipeline_stages?.market_validation?.ok === true,
    market_validation_stage_detail:
      stHydrate.pipeline_stages?.market_validation?.detail ?? null,
    market_validation_stage_hydrated: String(
      stHydrate.pipeline_stages?.market_validation?.detail || ''
    ).startsWith('hydrated ·'),
    normalization_stage_ok:
      stHydrate.pipeline_stages?.normalization?.ok === true,
    normalization_stage_detail:
      stHydrate.pipeline_stages?.normalization?.detail ?? null,
    normalization_stage_hydrated: String(
      stHydrate.pipeline_stages?.normalization?.detail || ''
    ).startsWith('hydrated ·'),
    broker_stage_ok: stHydrate.pipeline_stages?.broker?.ok === true,
    broker_stage_detail: stHydrate.pipeline_stages?.broker?.detail ?? null,
    buy_filter_ok: stHydrate.buy_filter?.ok === true,
    buy_filter_reason: stHydrate.buy_filter?.reason ?? null,
    sell_filter_ok: stHydrate.sell_filter?.ok === true,
    sell_filter_reason: stHydrate.sell_filter?.reason ?? null,
    // Journal-hydrated regime/market_state must not look live
    regime: stHydrate.regime ?? null,
    market_state: stHydrate.market_state ?? null,
    regime_hydrated: String(stHydrate.regime || '').startsWith('hydrated ·'),
    market_state_hydrated: String(stHydrate.market_state || '').startsWith(
      'hydrated ·'
    ),
    // Disk market_cache must not look like a live feed
    quote_cached: stHydrate.quote?.cached === true,
    quote_source: stHydrate.quote?.source ?? null,
    bars_available: stHydrate.bars_available ?? 0,
    bars_cached: stHydrate.bars_cached === true,
    entry_gates_session: stHydrate.entry_gates?.session ?? null,
    entry_gates_session_hydrated:
      stHydrate.entry_gates?.session_hydrated === true,
    monitoring_hydrated: stHydrate.monitoring?.hydrated === true,
    monitoring_entry_block: stHydrate.monitoring?.entry_block_reason ?? null,
    last_block_reason: stHydrate.last_block_reason ?? null,
    last_block_reason_hydrated: String(
      stHydrate.last_block_reason || ''
    ).startsWith('hydrated ·'),
    // Holding with no manage yet must not forge green position_manager
    position_stage_pre_manage_ok:
      stHydrate.pipeline_stages?.position_manager?.ok === true,
    position_stage_pre_manage_detail:
      stHydrate.pipeline_stages?.position_manager?.detail ?? null,
    position_stage_hydrated: String(
      stHydrate.pipeline_stages?.position_manager?.detail || ''
    ).startsWith('hydrated ·'),
    broker_stage_hydrated: String(
      stHydrate.pipeline_stages?.broker?.detail || ''
    ).startsWith('hydrated ·'),
    journal_heal_ok: journalHealOk,
    pg_primary_heal_ok: pgPrimaryHealOk,
    persist_backend: stHydrate.persist_backend ?? null,
    healed_from_persist: stHydrate.journal_audit?.healed_from_persist === true,
  };
  const hydrateOk =
    hydrated === true &&
    hydrateSnap.recovered_flag === false &&
    hydrateSnap.positions === 1 &&
    hydrateSnap.opportunities >= 1 &&
    hydrateSnap.last_exit_reason === 'TakeProfit' &&
    !!masterRuntime.last_decision &&
    hydrateSnap.daily_pnl === 8 &&
    hydrateSnap.open_positions_status === 1 &&
    hydrateSnap.recent_decisions >= 1 &&
    hydrateSnap.recent_trades >= 2 &&
    hydrateSnap.journal_stage_ok === true &&
    hydrateSnap.journal_stage_hydrated === true &&
    String(hydrateSnap.journal_stage_detail || '').startsWith('hydrated ·') &&
    hydrateSnap.performance_stage_ok === true &&
    hydrateSnap.performance_stage_hydrated === true &&
    hydrateSnap.performance_total_pnl === 8 &&
    hydrateSnap.performance_trades >= 1 &&
    String(hydrateSnap.performance_stage_detail || '').startsWith('hydrated ·') &&
    String(hydrateSnap.performance_stage_detail || '').includes('pnl=') &&
    hydrateSnap.exit_stage_ok === false &&
    hydrateSnap.exit_stage_hydrated === true &&
    String(hydrateSnap.exit_stage_detail || '').startsWith('hydrated ·') &&
    hydrateSnap.filters_stage_ok === false &&
    hydrateSnap.dual_candidates_stage_ok === false &&
    hydrateSnap.position_stage_pre_manage_ok === false &&
    hydrateSnap.position_stage_hydrated === true &&
    String(hydrateSnap.position_stage_pre_manage_detail || '').startsWith(
      'hydrated ·'
    ) &&
    hydrateSnap.broker_stage_ok === false &&
    hydrateSnap.broker_stage_hydrated === true &&
    String(hydrateSnap.broker_stage_detail || '').startsWith('hydrated ·') &&
    hydrateSnap.analysis_stage_ok === false &&
    hydrateSnap.analysis_stage_hydrated === true &&
    String(hydrateSnap.analysis_stage_detail || '').startsWith('hydrated ·') &&
    hydrateSnap.decision_stage_ok === false &&
    hydrateSnap.risk_stage_ok === false &&
    hydrateSnap.risk_stage_hydrated === true &&
    hydrateSnap.floating_pnl_cached === true &&
    hydrateSnap.floating_pnl != null &&
    Number.isFinite(Number(hydrateSnap.floating_pnl)) &&
    hydrateSnap.execution_stage_ok === false &&
    hydrateSnap.execution_stage_hydrated === true &&
    String(hydrateSnap.execution_stage_detail || '').startsWith('hydrated ·') &&
    hydrateSnap.market_validation_stage_ok === false &&
    hydrateSnap.market_validation_stage_hydrated === true &&
    String(hydrateSnap.market_validation_stage_detail || '').includes(
      'disk_cache'
    ) &&
    !String(hydrateSnap.market_validation_stage_detail || '').includes(
      'stale_quote · age='
    ) &&
    hydrateSnap.normalization_stage_ok === false &&
    hydrateSnap.normalization_stage_hydrated === true &&
    String(hydrateSnap.normalization_stage_detail || '').includes(
      'disk_cache'
    ) &&
    !String(hydrateSnap.normalization_stage_detail || '').includes(
      'stale_quote'
    ) &&
    hydrateSnap.buy_filter_ok === false &&
    hydrateSnap.sell_filter_ok === false &&
    hydrateSnap.regime_hydrated === true &&
    hydrateSnap.market_state_hydrated === true &&
    hydrateSnap.quote_cached === true &&
    hydrateSnap.bars_cached === true &&
    hydrateSnap.bars_available >= 40 &&
    hydrateSnap.entry_gates_session_hydrated === true &&
    String(hydrateSnap.entry_gates_session || '').startsWith('hydrated ·') &&
    hydrateSnap.monitoring_hydrated === true &&
    String(hydrateSnap.monitoring_entry_block || '').startsWith('hydrated ·') &&
    hydrateSnap.last_block_reason_hydrated === true &&
    hydrateSnap.cycles_by_epic_hydrated === true &&
    hydrateSnap.cycles_gold === true &&
    hydrateSnap.cycles_silver === true &&
    journalHealOk &&
    pgPrimaryHealOk;

  // Phase A: desired_running=false → manage leftover opens only
  masterRuntime.desired_running = false;
  const resumeManage = await masterRuntime.resumeDesiredSession();
  let paperSeeded = 0;
  if (masterRuntime.broker instanceof PaperBroker) {
    const listed = await masterRuntime.broker.listOpenPositions();
    paperSeeded = listed.positions?.length || 0;
  }
  // ≥5 manage syncs — empty-book debounce would wipe without seedOpens
  for (let i = 0; i < 6; i++) {
    masterRuntime.last_quote = {
      bid: 4415 - i * 0.1,
      ask: 4415.4 - i * 0.1,
      mid: 4415.2 - i * 0.1,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    };
    await masterRuntime.bootstrapManageAfterRecoverPublic();
  }
  const afterManageOpens = masterRuntime.positions.count();
  const ghostWiped = afterManageOpens === 0;
  const stAfterManage = masterRuntime.status();
  const positionStageOk =
    stAfterManage.pipeline_stages?.position_manager?.ok === true;
  const manageOnlyOk =
    resumeManage.detail === 'manage_opens_only' &&
    paperSeeded === 1 &&
    !ghostWiped &&
    afterManageOpens === 1 &&
    positionStageOk;

  // Phase B: recover while opens still on disk/memory (before feed resume)
  const recovered = await masterRuntime.recover();
  await masterRuntime.bootstrapManageAfterRecoverPublic();
  const stRecover = masterRuntime.status();
  const manageArmed = !!(
    masterRuntime as unknown as { manageTimer: NodeJS.Timeout | null }
  ).manageTimer;
  const recoverOk =
    masterRuntime.recovered === true &&
    recovered.positions === 1 &&
    recovered.opportunities >= 1 &&
    recovered.outcomes >= 1 &&
    stRecover.recovered === true &&
    manageArmed &&
    (stRecover.health === 'OPENS_MANAGE_ONLY' || stRecover.running);

  // Phase C: desired_running embed survives sidecar wipe → paper_live_feed
  // Do NOT call stop() before save — stop() persists desired_running=false and
  // would overwrite the embed we are about to prove. Keep seeded PaperBroker so
  // start()/recover inside resumeDesiredSession cannot ghost-wipe locals.
  saveRuntimeGates({
    last_loss_ms: 0,
    reject_until_ms: 0,
    desired_running: true,
    mode: 'PAPER',
    epic: 'GOLD',
    kill_switch: false,
  });
  try {
    unlinkSync(join(stateDir, 'runtime_gates.json'));
  } catch {
    /* ignore */
  }
  masterRuntime.running = false;
  masterRuntime.desired_running = false;
  ensureOperatorMetaFromStateDir(stateDir);
  const gatesHydrated = masterRuntime.hydrateRuntimeGatesFromDisk();
  const resumeFeed = await masterRuntime.resumeDesiredSession();
  const feedOk =
    gatesHydrated === true &&
    masterRuntime.desired_running === true &&
    resumeFeed.resumed === true &&
    resumeFeed.detail === 'paper_live_feed' &&
    masterRuntime.running === true &&
    masterRuntime.broker instanceof PaperBroker;
  const desiredFeedSnap = {
    ok: feedOk,
    gates_hydrated: gatesHydrated,
    desired_running: masterRuntime.desired_running,
    resume_detail: resumeFeed.detail,
    resumed: resumeFeed.resumed,
    running: masterRuntime.running,
    opens: masterRuntime.positions.count(),
  };

  const allOk = hydrateOk && manageOnlyOk && recoverOk && feedOk;
  const report = {
    status: allOk ? 'PASS_RESTART_CONTINUITY' : 'FAIL',
    hydrate: { ok: hydrateOk, ...hydrateSnap },
    manage_only: {
      ok: manageOnlyOk,
      resume_detail: resumeManage.detail,
      paper_seeded: paperSeeded,
      opens_after_6_manage: afterManageOpens,
      ghost_wiped: ghostWiped,
      position_stage_ok: positionStageOk,
      position_stage_detail:
        stAfterManage.pipeline_stages?.position_manager?.detail ?? null,
    },
    journals: {
      decisions: hydrateSnap.recent_decisions,
      trades: hydrateSnap.recent_trades,
      journal_stage_ok: hydrateSnap.journal_stage_ok,
      journal_stage_detail: hydrateSnap.journal_stage_detail,
      journal_stage_hydrated: hydrateSnap.journal_stage_hydrated,
      performance_stage_ok: hydrateSnap.performance_stage_ok,
      performance_stage_detail: hydrateSnap.performance_stage_detail,
      performance_stage_hydrated: hydrateSnap.performance_stage_hydrated,
      performance_total_pnl: hydrateSnap.performance_total_pnl,
      performance_trades: hydrateSnap.performance_trades,
      exit_stage_ok: hydrateSnap.exit_stage_ok,
      exit_stage_detail: hydrateSnap.exit_stage_detail,
      exit_stage_hydrated: hydrateSnap.exit_stage_hydrated,
      filters_stage_ok: hydrateSnap.filters_stage_ok,
      filters_stage_detail: hydrateSnap.filters_stage_detail,
      dual_candidates_stage_ok: hydrateSnap.dual_candidates_stage_ok,
      dual_candidates_stage_detail: hydrateSnap.dual_candidates_stage_detail,
      analysis_stage_ok: hydrateSnap.analysis_stage_ok,
      analysis_stage_detail: hydrateSnap.analysis_stage_detail,
      analysis_stage_hydrated: hydrateSnap.analysis_stage_hydrated,
      decision_stage_ok: hydrateSnap.decision_stage_ok,
      decision_stage_detail: hydrateSnap.decision_stage_detail,
      risk_stage_ok: hydrateSnap.risk_stage_ok,
      risk_stage_detail: hydrateSnap.risk_stage_detail,
      risk_stage_hydrated: hydrateSnap.risk_stage_hydrated,
      floating_pnl: hydrateSnap.floating_pnl,
      floating_pnl_cached: hydrateSnap.floating_pnl_cached,
      execution_stage_ok: hydrateSnap.execution_stage_ok,
      execution_stage_detail: hydrateSnap.execution_stage_detail,
      execution_stage_hydrated: hydrateSnap.execution_stage_hydrated,
      market_validation_stage_ok: hydrateSnap.market_validation_stage_ok,
      market_validation_stage_detail: hydrateSnap.market_validation_stage_detail,
      market_validation_stage_hydrated:
        hydrateSnap.market_validation_stage_hydrated,
      normalization_stage_ok: hydrateSnap.normalization_stage_ok,
      normalization_stage_detail: hydrateSnap.normalization_stage_detail,
      normalization_stage_hydrated: hydrateSnap.normalization_stage_hydrated,
      broker_stage_ok: hydrateSnap.broker_stage_ok,
      broker_stage_detail: hydrateSnap.broker_stage_detail,
      broker_stage_hydrated: hydrateSnap.broker_stage_hydrated,
      position_stage_pre_manage_ok: hydrateSnap.position_stage_pre_manage_ok,
      position_stage_pre_manage_detail:
        hydrateSnap.position_stage_pre_manage_detail,
      position_stage_hydrated: hydrateSnap.position_stage_hydrated,
      buy_filter_ok: hydrateSnap.buy_filter_ok,
      buy_filter_reason: hydrateSnap.buy_filter_reason,
      sell_filter_ok: hydrateSnap.sell_filter_ok,
      sell_filter_reason: hydrateSnap.sell_filter_reason,
      regime: hydrateSnap.regime,
      market_state: hydrateSnap.market_state,
      regime_hydrated: hydrateSnap.regime_hydrated,
      market_state_hydrated: hydrateSnap.market_state_hydrated,
      quote_cached: hydrateSnap.quote_cached,
      quote_source: hydrateSnap.quote_source,
      bars_available: hydrateSnap.bars_available,
      bars_cached: hydrateSnap.bars_cached,
      entry_gates_session: hydrateSnap.entry_gates_session,
      entry_gates_session_hydrated: hydrateSnap.entry_gates_session_hydrated,
      monitoring_hydrated: hydrateSnap.monitoring_hydrated,
      monitoring_entry_block: hydrateSnap.monitoring_entry_block,
      last_block_reason: hydrateSnap.last_block_reason,
      last_block_reason_hydrated: hydrateSnap.last_block_reason_hydrated,
      heal_ok: journalHealOk,
      heal_via_install: healViaInstall,
      heal_helper: healHelper,
      heal_op_meta_called: healOpMeta,
      pg_primary_heal_ok: pgPrimaryHealOk,
      persist_backend: hydrateSnap.persist_backend,
      healed_from_persist: hydrateSnap.healed_from_persist,
    },
    recover: {
      ok: recoverOk,
      positions: recovered.positions,
      opportunities: recovered.opportunities,
      outcomes: recovered.outcomes,
      manage_armed: manageArmed,
      health: stRecover.health,
    },
    desired_feed: desiredFeedSnap,
    detail: allOk
      ? 'boot hydrate + paper seed + recover + desired_running feed resume'
      : `hydrate_ok=${hydrateOk} manage_only_ok=${manageOnlyOk} recover_ok=${recoverOk} feed_ok=${feedOk}`,
  };

  writeFileSync(
    join(artifactDir, 'vs_master_restart_continuity.json'),
    JSON.stringify(report, null, 2)
  );
  console.log(JSON.stringify(report, null, 2));
  // Manage timers keep the event loop alive — clear opens and stop before exit
  masterRuntime.positions = new PositionManager();
  masterRuntime.stop();
  setPersistClient(null);
  process.exit(report.status === 'PASS_RESTART_CONTINUITY' ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  try {
    masterRuntime.positions = new PositionManager();
    masterRuntime.stop();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
