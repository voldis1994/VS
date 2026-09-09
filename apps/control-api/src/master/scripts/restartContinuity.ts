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
  // Re-seed market cache sidecar (not SQL-mirrored) so later manage has bars
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
    journal_stage_ok: stHydrate.pipeline_stages?.journal_performance?.ok === true,
    journal_stage_detail: stHydrate.pipeline_stages?.journal_performance?.detail ?? null,
    // Holding with no manage yet must not forge green position_manager
    position_stage_pre_manage_ok:
      stHydrate.pipeline_stages?.position_manager?.ok === true,
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
    hydrateSnap.position_stage_pre_manage_ok === false &&
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
