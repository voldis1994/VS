/**
 * Paper restart continuity — durable opens/journal survive boot hydrate
 * without broker recover, then recover still reconciles.
 *
 *   npm run master:restart-check
 */
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
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

  // Simulate process restart — empty in-memory book, durable state on disk
  masterRuntime.pipeline = new MasterPipeline('PAPER');
  masterRuntime.positions = new PositionManager();
  masterRuntime.broker = null;
  masterRuntime.broker_detail = null;
  masterRuntime.running = false;
  masterRuntime.recovered = false;
  (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated = false;
  masterRuntime.last_exit_reason = null;
  masterRuntime.last_decision = null;
  masterRuntime.account.daily_pnl = 0;
  masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'PAPER' };

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

  const recovered = await masterRuntime.recover();
  const stRecover = masterRuntime.status();
  const recoverOk =
    masterRuntime.recovered === true &&
    recovered.positions === 1 &&
    recovered.opportunities >= 1 &&
    recovered.outcomes >= 1 &&
    stRecover.recovered === true;

  const report = {
    status: hydrateOk && recoverOk ? 'PASS_RESTART_CONTINUITY' : 'FAIL',
    hydrate: { ok: hydrateOk, ...hydrateSnap },
    recover: {
      ok: recoverOk,
      positions: recovered.positions,
      opportunities: recovered.opportunities,
      outcomes: recovered.outcomes,
    },
    detail: hydrateOk && recoverOk
      ? 'boot hydrate restored opens+journal; recover reconciled without empty forge'
      : `hydrate_ok=${hydrateOk} recover_ok=${recoverOk}`,
  };

  writeFileSync(
    join(artifactDir, 'vs_master_restart_continuity.json'),
    JSON.stringify(report, null, 2)
  );
  console.log(JSON.stringify(report, null, 2));
  setPersistClient(null);
  if (report.status !== 'PASS_RESTART_CONTINUITY') process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
