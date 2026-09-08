/**
 * Paper restart continuity — durable opens/journal survive boot hydrate
 * without broker recover; PaperBroker is reseeded so manage sync cannot
 * ghost-wipe locals; then recover still reconciles.
 *
 *   npm run master:restart-check
 */
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { PaperBroker } from '../broker.js';
import { installFilePersist } from '../filePersist.js';
import {
  persistOpportunity,
  persistOutcome,
  saveOpenPositions,
  setPersistClient,
} from '../persist.js';
import { DEFAULT_MASTER_CONFIG, GOLD_SPEC, MasterPipeline } from '../pipeline.js';
import { PositionManager } from '../positionManager.js';
import { masterRuntime } from '../runtime.js';
import { saveMarketCache } from '../marketCache.js';

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

  // Simulate process restart — empty in-memory book, durable state on disk
  masterRuntime.pipeline = new MasterPipeline('PAPER');
  masterRuntime.positions = new PositionManager();
  masterRuntime.broker = null;
  masterRuntime.broker_detail = null;
  masterRuntime.running = false;
  masterRuntime.desired_running = false;
  masterRuntime.recovered = false;
  (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated = false;
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
  };
  masterRuntime.last_ai_allow_close = false;

  const hydrated = await masterRuntime.hydrateBookFromDisk();
  const stHydrate = masterRuntime.status();
  const hydrateSnap = {
    recovered_flag: masterRuntime.recovered,
    positions: masterRuntime.positions.count(),
    opportunities: masterRuntime.pipeline.journal.opportunities.length,
    last_exit_reason: masterRuntime.last_exit_reason,
    daily_pnl: masterRuntime.account.daily_pnl,
    last_decision_kind: masterRuntime.last_decision?.kind ?? null,
    open_positions_status: stHydrate.open_positions,
  };
  const hydrateOk =
    hydrated === true &&
    hydrateSnap.recovered_flag === false &&
    hydrateSnap.positions === 1 &&
    hydrateSnap.opportunities >= 1 &&
    hydrateSnap.last_exit_reason === 'TakeProfit' &&
    !!masterRuntime.last_decision &&
    hydrateSnap.daily_pnl === 8 &&
    hydrateSnap.open_positions_status === 1;

  // Hydrate-only manage (no recover): must reseed PaperBroker or sync ghost-wipes
  const resume = await masterRuntime.resumeDesiredSession();
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
  const manageOnlyOk =
    resume.detail === 'manage_opens_only' &&
    paperSeeded === 1 &&
    !ghostWiped &&
    afterManageOpens === 1;

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

  const allOk = hydrateOk && manageOnlyOk && recoverOk;
  const report = {
    status: allOk ? 'PASS_RESTART_CONTINUITY' : 'FAIL',
    hydrate: { ok: hydrateOk, ...hydrateSnap },
    manage_only: {
      ok: manageOnlyOk,
      resume_detail: resume.detail,
      paper_seeded: paperSeeded,
      opens_after_6_manage: afterManageOpens,
      ghost_wiped: ghostWiped,
    },
    recover: {
      ok: recoverOk,
      positions: recovered.positions,
      opportunities: recovered.opportunities,
      outcomes: recovered.outcomes,
      manage_armed: manageArmed,
      health: stRecover.health,
    },
    detail: allOk
      ? 'boot hydrate + paper seed survive manage sync; recover manage armed'
      : `hydrate_ok=${hydrateOk} manage_only_ok=${manageOnlyOk} recover_ok=${recoverOk}`,
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
