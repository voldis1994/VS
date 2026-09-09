/**
 * One-command verification gate for VS MASTER objective requirements.
 * Writes /opt/cursor/artifacts/vs_master_verify.json
 *
 *   npm run master:verify
 */
import 'dotenv/config';
import { spawnSync } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');
const artifactDir = process.env.ARTIFACT_DIR || '/opt/cursor/artifacts';

type Check = {
  id: string;
  requirement: string;
  ok: boolean;
  detail: string;
};

function run(cmd: string, args: string[], timeoutMs: number): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: process.env,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, out: out.slice(-4000) };
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  mkdirSync(artifactDir, { recursive: true });
  const checks: Check[] = [];

  // 1) Unit tests
  {
    const r = run('npm', ['test'], 120_000);
    checks.push({
      id: 'tests',
      requirement: 'Automated tests for MASTER pipeline',
      ok: r.ok && /Tests\s+\d+\s+passed/.test(r.out),
      detail: r.ok ? r.out.match(/Tests\s+\d+\s+passed[^\n]*/)?.[0] || 'passed' : r.out.slice(-500),
    });
  }

  // 2) Stage audit (paper fill→exit)
  {
    const r = run('npm', ['run', 'master:audit'], 60_000);
    const audit = readJson(join(artifactDir, 'vs_master_system_audit.json'));
    const deskStagesOk =
      audit?.stages?.desk_closed_10s_gate?.ok === true &&
      audit?.stages?.desk_hour_bias?.ok === true &&
      audit?.stages?.desk_entry_confirm?.ok === true &&
      audit?.stages?.desk_confirm_helper?.ok === true;
    checks.push({
      id: 'pipeline_stages',
      requirement:
        'market→validation→analysis→candidates→filters→decision→risk→execution→broker→position→exit→journal→performance + desk closed_10s/hour_bars → resolveDeskEntryConfirm setup|move',
      ok: r.ok && audit?.status === 'PASS' && deskStagesOk,
      detail: audit ? JSON.stringify(audit.stages) : r.out.slice(-500),
    });
  }

  // 3) Live market data PAPER (retry DECIDED/TRADED — never forge fills)
  {
    const { shouldRetryLivePaperDemo, isHonestLivePaperClosed } = await import(
      '../livePaperHonesty.js'
    );
    const maxAttempts = Math.max(
      1,
      Number(process.env.MASTER_VERIFY_LIVE_PAPER_ATTEMPTS || 3)
    );
    let attempts = 0;
    let demo: any = null;
    let r = { ok: false, out: '' };
    let honestClosed = false;
    while (attempts < maxAttempts) {
      attempts += 1;
      r = run('npm', ['run', 'master:live-paper'], 120_000);
      demo = readJson(join(artifactDir, 'vs_master_live_paper_demo.json'));
      try {
        honestClosed = !!(demo && isHonestLivePaperClosed(demo));
      } catch {
        honestClosed = false;
      }
      const closedOk =
        r.ok &&
        typeof demo?.status === 'string' &&
        demo.status === 'PASS_LIVE_DATA_CLOSED' &&
        demo.forced_live_paper_fill !== true &&
        (demo.performance_trades ?? 0) >= 1 &&
        typeof demo.performance_total_pnl === 'number' &&
        Number.isFinite(demo.performance_total_pnl) &&
        (demo.exit_phase === true || (demo.exit_cycles ?? 0) >= 1) &&
        (demo.executed_cycles ?? 0) >= 1 &&
        (demo.executed_cycles ?? 0) <= 2 &&
        (demo.open_positions ?? 0) === 0 &&
        demo.desk_confirm_fed === true &&
        (demo.desk_entry_source === 'setup' ||
          demo.desk_entry_source === 'move') &&
        honestClosed;
      if (closedOk) break;
      if (!shouldRetryLivePaperDemo(demo?.status)) break;
    }
    const ok =
      r.ok &&
      typeof demo?.status === 'string' &&
      demo.status === 'PASS_LIVE_DATA_CLOSED' &&
      demo.forced_live_paper_fill !== true &&
      (demo.performance_trades ?? 0) >= 1 &&
      typeof demo.performance_total_pnl === 'number' &&
      Number.isFinite(demo.performance_total_pnl) &&
      (demo.exit_phase === true || (demo.exit_cycles ?? 0) >= 1) &&
      (demo.executed_cycles ?? 0) >= 1 &&
      (demo.executed_cycles ?? 0) <= 2 &&
      (demo.open_positions ?? 0) === 0 &&
      demo.desk_confirm_fed === true &&
      (demo.desk_entry_source === 'setup' ||
        demo.desk_entry_source === 'move') &&
      honestClosed;
    checks.push({
      id: 'live_market_paper',
      requirement:
        'Live market data → desk closed_10s/hour_bars → one natural fill with setup|move confirm → tick-observed exit → journal/performance (no churn, no |none bypass)',
      ok,
      detail: demo
        ? `${demo.status} mid=${demo.first_mid} feed=${demo.feed} executed=${demo.executed_cycles} exit_phase=${!!demo.exit_phase} exits=${demo.exit_cycles} trades=${demo.performance_trades} closed_pnl=${demo.performance_total_pnl} forced=${!!demo.forced_live_paper_fill} honest=${honestClosed} desk_fed=${demo.desk_confirm_fed} desk_src=${demo.desk_entry_source} attempts=${attempts}${
            Array.isArray(demo.entry_whys) && demo.entry_whys.length
              ? ` whys=${demo.entry_whys.slice(0, 4).join('|')}`
              : ''
          }`
        : r.out.slice(-500),
    });
  }

  // 3b) Paper restart continuity — boot hydrate + recover (no forged-empty book)
  {
    const r = run('npm', ['run', 'master:restart-check'], 60_000);
    const demo = readJson(join(artifactDir, 'vs_master_restart_continuity.json'));
    const ok =
      r.ok &&
      demo?.status === 'PASS_RESTART_CONTINUITY' &&
      demo?.journals?.pg_primary_heal_ok === true &&
      demo?.journals?.market_cache_pg_primary_heal_ok === true &&
      demo?.journals?.epic_cycle_stash_pg_primary_heal_ok === true &&
      demo?.journals?.runtime_gates_pg_primary_heal_ok === true &&
      demo?.journals?.manage_config_pg_primary_heal_ok === true &&
      demo?.journals?.owns_pipeline_pg_primary_heal_ok === true &&
      demo?.journals?.monitoring_snapshot_pg_primary_heal_ok === true &&
      demo?.journals?.spread_history_pg_primary_heal_ok === true &&
      demo?.journals?.trade_ack_journal_pg_primary_heal_ok === true &&
      demo?.journals?.error_journal_pg_primary_heal_ok === true &&
      demo?.journals?.news_window_pg_primary_heal_ok === true &&
      demo?.journals?.client_fanout_pg_primary_heal_ok === true &&
      demo?.journals?.news_calendar_pg_primary_heal_ok === true &&
      demo?.journals?.peak_equity_healed_ok === true &&
      demo?.journals?.day_start_equity_healed_ok === true &&
      demo?.journals?.consecutive_losses_healed_ok === true &&
      demo?.journals?.decision_stage_ok === false &&
      demo?.journals?.analysis_stage_ok === false &&
      demo?.journals?.execution_stage_ok === false &&
      demo?.journals?.market_validation_stage_ok === false &&
      demo?.journals?.normalization_stage_ok === false &&
      demo?.journals?.broker_stage_ok === false &&
      demo?.journals?.filters_stage_ok === false &&
      demo?.journals?.dual_candidates_stage_ok === false &&
      demo?.journals?.buy_filter_ok === false &&
      demo?.journals?.sell_filter_ok === false &&
      demo?.journals?.regime_hydrated === true &&
      demo?.journals?.market_state_hydrated === true &&
      demo?.journals?.quote_cached === true &&
      demo?.journals?.bars_cached === true &&
      (demo?.journals?.bars_available ?? 0) >= 40 &&
      demo?.journals?.hour_bars_cached === true &&
      (demo?.journals?.hour_bars_available ?? 0) >= 6 &&
      demo?.journals?.hour_bars_source === 'disk_cache' &&
      demo?.journals?.closed_10s_present === true &&
      demo?.journals?.closed_10s_cached === true &&
      demo?.journals?.closed_10s_source === 'disk_cache' &&
      demo?.sticky_desk?.ok === true &&
      demo?.sticky_desk?.hour_bias === 'UP' &&
      (demo?.sticky_desk?.desk_entry_source === 'setup' ||
        demo?.sticky_desk?.desk_entry_source === 'move') &&
      demo?.journals?.entry_gates_session_hydrated === true &&
      typeof demo?.journals?.entry_gates_session === 'string' &&
      String(demo.journals.entry_gates_session).startsWith('hydrated ·') &&
      demo?.journals?.monitoring_hydrated === true &&
      typeof demo?.journals?.monitoring_entry_block === 'string' &&
      String(demo.journals.monitoring_entry_block).startsWith('hydrated ·') &&
      demo?.journals?.last_block_reason_hydrated === true &&
      demo?.journals?.risk_stage_hydrated === true &&
      demo?.journals?.floating_pnl_cached === true &&
      demo?.journals?.floating_pnl != null &&
      Number.isFinite(Number(demo.journals.floating_pnl)) &&
      demo?.journals?.exit_stage_ok === false &&
      demo?.journals?.exit_stage_hydrated === true &&
      typeof demo?.journals?.exit_stage_detail === 'string' &&
      String(demo.journals.exit_stage_detail).startsWith('hydrated ·') &&
      demo?.journals?.execution_stage_ok === false &&
      demo?.journals?.execution_stage_hydrated === true &&
      typeof demo?.journals?.execution_stage_detail === 'string' &&
      String(demo.journals.execution_stage_detail).startsWith('hydrated ·') &&
      demo?.journals?.market_validation_stage_ok === false &&
      demo?.journals?.market_validation_stage_hydrated === true &&
      typeof demo?.journals?.market_validation_stage_detail === 'string' &&
      String(demo.journals.market_validation_stage_detail).includes('disk_cache') &&
      !String(demo.journals.market_validation_stage_detail).includes(
        'stale_quote · age='
      ) &&
      demo?.journals?.normalization_stage_ok === false &&
      demo?.journals?.normalization_stage_hydrated === true &&
      typeof demo?.journals?.normalization_stage_detail === 'string' &&
      String(demo.journals.normalization_stage_detail).includes('disk_cache') &&
      !String(demo.journals.normalization_stage_detail).includes('stale_quote') &&
      demo?.hydrate?.performance_total_pnl === 8 &&
      typeof demo?.journals?.performance_stage_detail === 'string' &&
      String(demo.journals.performance_stage_detail).includes('pnl=') &&
      (demo?.journals?.recent_trades_desk_setup ?? 0) >= 1 &&
      (demo?.journals?.trade_jsonl_desk_setup ?? 0) >= 1 &&
      (demo?.journals?.decision_jsonl_desk_setup ?? 0) >= 1 &&
      (demo?.journals?.performance_by_desk_setup_trades ?? 0) >= 1 &&
      demo?.journals?.desk_entry_source_status === 'setup' &&
      demo?.journals?.desk_entry_hydrated === true;
    checks.push({
      id: 'paper_restart_continuity',
      requirement:
        'Paper restart: hydrateBookFromDisk restores opens/journal; DualPersist primary heal; recover reconciles; tick without opts sticky-uses disk hour_bars/closed_10s for desk setup|move; cycle stages stay red until live tick; Stage·perf surfaces closed pnl=; regime/market_state cards mark hydrated; Quote/Bars/Hour bars/Closed 10s mark disk_cache; entry_gates session hydrated; Why/monitor disk hydrate honesty; Stage·risk from opportunity.risk; Float UPL disk_cache; Stage·exit journal hydrate honesty; Stage·exec decision-journal seed; Stage·validate/normalize disk_cache hydrate (aged quote not live stale); Stage·regime hydrated · (not no cycle ·); Stage·position/broker hydrated awaiting manage/attach; Stage·journal/perf hydrated · while green; Closed PnL/Last error hydrate; Peak/Equity/News/Close-fail/Expectancy/Fees/Win rate/Loss streak KPI hydrate honesty; Peak eq / Day start / Loss streak from runtime_gates DualPersist heal; TradeEvent+Decision desk_entry setup survive DualPersist wipe; Confirm PnL setup bucket + Desk entry hydrated',
      ok,
      detail: demo
        ? `${demo.status} hydrate_pos=${demo.hydrate?.positions} exit=${demo.hydrate?.last_exit_reason} exit_stage=${demo.journals?.exit_stage_detail} exec_stage=${demo.journals?.execution_stage_detail} validate=${demo.journals?.market_validation_stage_detail} normalize=${demo.journals?.normalization_stage_detail} pnl=${demo.hydrate?.daily_pnl} peak=${demo.hydrate?.peak_equity ?? demo.journals?.peak_equity} streak=${demo.hydrate?.consecutive_losses ?? demo.journals?.consecutive_losses} closed_pnl=${demo.hydrate?.performance_total_pnl} perf_detail=${demo.journals?.performance_stage_detail} regime=${demo.journals?.regime} market_state=${demo.journals?.market_state} quote_src=${demo.journals?.quote_source} bars=${demo.journals?.bars_available} bars_cached=${demo.journals?.bars_cached} hour_bars=${demo.journals?.hour_bars_available} hour_cached=${demo.journals?.hour_bars_cached} hour_src=${demo.journals?.hour_bars_source} closed_10s_cached=${demo.journals?.closed_10s_cached} closed_10s_src=${demo.journals?.closed_10s_source} sticky_desk=${demo.sticky_desk?.desk_entry_source} sticky_hour=${demo.sticky_desk?.hour_bias} sticky_10s_src=${demo.sticky_desk?.closed_10s_source} entry_session=${demo.journals?.entry_gates_session} mon_hydrated=${demo.journals?.monitoring_hydrated} why=${demo.journals?.last_block_reason} risk=${demo.journals?.risk_stage_detail} float=${demo.journals?.floating_pnl} float_cached=${demo.journals?.floating_pnl_cached} manage_seed=${demo.manage_only?.paper_seeded} recover_pos=${demo.recover?.positions} pg_heal=${demo.journals?.pg_primary_heal_ok === true} persist=${demo.journals?.persist_backend || demo.hydrate?.persist_backend || '?'} decision_stage=${demo.journals?.decision_stage_ok} analysis_stage=${demo.journals?.analysis_stage_ok} analysis_hydrated=${demo.journals?.analysis_stage_hydrated} analysis_detail=${demo.journals?.analysis_stage_detail} pos_stage=${demo.journals?.position_stage_pre_manage_detail} broker_stage=${demo.journals?.broker_stage_detail} journal_stage=${demo.journals?.journal_stage_detail} perf_hydrated=${demo.journals?.performance_stage_hydrated} trade_desk_setup=${demo.journals?.trade_jsonl_desk_setup} recent_desk_setup=${demo.journals?.recent_trades_desk_setup} confirm_pnl_setup=${demo.journals?.performance_by_desk_setup_trades} desk_entry=${demo.journals?.desk_entry_source_status} desk_hydrated=${demo.journals?.desk_entry_hydrated} peak_ok=${demo.journals?.peak_equity_healed_ok} streak_ok=${demo.journals?.consecutive_losses_healed_ok}`
        : r.out.slice(-500),
    });
  }

  // 4) LIVE Capital smoke (may SKIP without env OR Brokers desk creds — recorded honestly)
  {
    const r = run('npm', ['run', 'master:live-smoke'], 60_000);
    const smoke = readJson(join(artifactDir, 'vs_master_live_smoke.json'));
    const status = smoke?.status || 'MISSING';
    const credSrc =
      typeof smoke?.credential_source === 'string' ? ` source=${smoke.credential_source}` : '';
    checks.push({
      id: 'live_capital_network',
      requirement:
        'LIVE broker mode against Capital.com network (CAPITAL_* env or Brokers DB desk creds)',
      // Only full quote+account proves Capital LIVE — CONNECTED_PARTIAL is not COMPLETE
      ok: status === 'OK_LIVE_CONNECTED',
      detail:
        status === 'SKIPPED'
          ? `SKIPPED (no CAPITAL_* env and no Brokers desk Capital): ${smoke?.detail || ''}`
          : status === 'CONNECTED_PARTIAL'
            ? `CONNECTED_PARTIAL (quote/account incomplete — not Capital LIVE proof): ${JSON.stringify(smoke)}${credSrc}`
            : `${JSON.stringify(smoke)}${credSrc}`,
      // Note: SKIPPED / PARTIAL means not verified — ok=false
    });
  }

  // 5) Mocked LIVE path unit evidence (always available)
  {
    const r = run('npx', ['vitest', 'run', 'src/master/__tests__/master.livePath.test.ts'], 60_000);
    checks.push({
      id: 'live_capital_mocked',
      requirement: 'LIVE Capital path logic (gate → confirm fill → exit) with mocked broker',
      ok: r.ok,
      detail: r.ok ? 'master.livePath.test.ts passed' : r.out.slice(-500),
    });
  }

  // 6) Legacy MT4 file-bridge demo — optional evidence that ported Open→Close still works.
  // NOT the primary LIVE venue; Capital.com API is. Failure here does not block COMPLETE.
  {
    const r = run('npm', ['run', 'master:mt4-live'], 90_000);
    const demo = readJson(join(artifactDir, 'vs_master_mt4_live_demo.json'));
    const ok = r.ok && demo?.status === 'PASS_MT4_LIVE';
    checks.push({
      id: 'legacy_mt4_bridge_optional',
      requirement:
        'OPTIONAL legacy: MT4/Check- file bridge sim (OPEN→ack fill→exit) — not primary LIVE venue',
      ok,
      detail: demo
        ? `${demo.status} ticket=${demo.ticket || demo.position_id} detail=${demo.detail || ''}`
        : r.out.slice(-500),
    });
  }

  // 7) Recovery + MT4 + filters modules exist
  {
    const files = [
      'src/master/pipeline.ts',
      'src/master/runtime.ts',
      'src/master/broker.ts',
      'src/master/positionManager.ts',
      'src/master/positionSync.ts',
      'src/master/scalpPctChase.ts',
      'src/master/candleBias.ts',
      'src/master/moneyExit.ts',
      'src/master/capitalLoginLock.ts',
      'src/master/capitalDeskCreds.ts',
      'src/master/liveSmokeGate.ts',
      'src/master/capitalMarket.ts',
      'src/master/newsCalendar.ts',
      'src/master/capitalStream.ts',
      'src/master/manageConfig.ts',
      'src/master/tradeAckJournal.ts',
      'src/master/closeRequiresSl.ts',
      'src/master/errorJournal.ts',
      'src/master/decisionJournal.ts',
      'src/master/journalMirror.ts',
      'src/master/atomicIo.ts',
      'src/master/monitoring.ts',
      'src/master/cycleAlerts.ts',
      'src/master/tradeEventJournal.ts',
      'src/master/mt4/VS_MASTER.mq4',
      'src/master/persist.ts',
      'src/master/filePersist.ts',
      'src/master/runtimeGates.ts',
      'src/master/marketCache.ts',
      'src/master/epicCycleStash.ts',
      'src/master/liveFeed.ts',
      'src/master/filters.ts',
      'src/master/deskBridge.ts',
      'src/master/mt4Sim.ts',
      'src/master/scripts/restartContinuity.ts',
      'src/routes/master.ts',
      'src/routes/robotDesk.ts',
      'src/services/robotDesk.ts',
      'src/services/robotDeskOwnsBridge.test.ts',
      'src/db/migrations/011_master_journal.sql',
      'src/db/migrations/014_master_decision_trade_events.sql',
      'src/db/migrations/015_master_decision_desk_entry.sql',
      'src/db/migrations/017_master_market_cache.sql',
      'src/db/migrations/018_master_epic_cycle_stash.sql',
      'src/db/migrations/019_master_runtime_gates.sql',
      'src/db/migrations/020_master_manage_config.sql',
      'src/db/migrations/021_master_owns_pipeline.sql',
      'src/db/migrations/022_master_monitoring_snapshot.sql',
      'src/db/migrations/023_master_spread_history.sql',
      'src/db/migrations/024_master_trade_ack_journal.sql',
      'src/db/migrations/025_master_error_journal.sql',
      'src/db/migrations/026_master_news_window.sql',
      'src/db/migrations/027_master_client_fanout.sql',
      'src/db/migrations/028_master_news_calendar.sql',
      'src/master/auditJournalHydrate.ts',
      'src/master/persistBackend.ts',
      'src/master/setupDerive.ts',
      'src/master/masterClientFanout.ts',
      'src/master/deskEntryConfirm.ts',
      'src/services/marketCoreIntentGate.ts',
      '../dashboard/src/pages/MasterPage.tsx',
      '../dashboard/src/pages/RobotDeskPage.tsx',
    ];
    const missing = files.filter((f) => !existsSync(join(root, f)));
    const masterPage = join(root, '../dashboard/src/pages/MasterPage.tsx');
    const masterPageBody = existsSync(masterPage)
      ? readFileSync(masterPage, 'utf8')
      : '';
    const robotDeskPage = join(root, '../dashboard/src/pages/RobotDeskPage.tsx');
    const robotDeskPageBody = existsSync(robotDeskPage)
      ? readFileSync(robotDeskPage, 'utf8')
      : '';
    const stagesUi =
      masterPageBody.includes('pipeline_stages') &&
      masterPageBody.includes('Stage·validate') &&
      masterPageBody.includes('Stage·journal') &&
      masterPageBody.includes('Stage·perf');
    const manageOwnerMasterUi =
      masterPageBody.includes('manage_owner') &&
      masterPageBody.includes('Manage owner');
    const manageOwnerDeskUi =
      robotDeskPageBody.includes('manage_owner') &&
      robotDeskPageBody.includes('MANAGE OWNER');
    const runtimeBody = readFileSync(join(root, 'src/master/runtime.ts'), 'utf8');
    const marketCacheBody = readFileSync(
      join(root, 'src/master/marketCache.ts'),
      'utf8'
    );
    const epicStashBody = readFileSync(
      join(root, 'src/master/epicCycleStash.ts'),
      'utf8'
    );
    const persistBody = readFileSync(join(root, 'src/master/persist.ts'), 'utf8');
    const restartBody = readFileSync(
      join(root, 'src/master/scripts/restartContinuity.ts'),
      'utf8'
    );
    const stagesApi =
      runtimeBody.includes('pipeline_stages:') &&
      runtimeBody.includes('market_validation:') &&
      runtimeBody.includes('dual_candidates:') &&
      runtimeBody.includes('m.ok && m.bars_out >= 5') &&
      runtimeBody.includes('journal:') &&
      runtimeBody.includes('performance:') &&
      runtimeBody.includes('flat · no exit yet') &&
      runtimeBody.includes('Journal exit_reason alone must not forge green') &&
      runtimeBody.includes('hydrated · ${this.last_exit_reason}') &&
      runtimeBody.includes('no filter evidence') &&
      runtimeBody.includes('filter_ok === true') &&
      runtimeBody.includes('hydrated · BUY') &&
      runtimeBody.includes('no candidate evidence') &&
      runtimeBody.includes('buy?.components') &&
      runtimeBody.includes('liveQuoteStaleForStages') &&
      runtimeBody.includes('stale_quote · age=') &&
      runtimeBody.includes('hydrated · disk_cache · Q=') &&
      runtimeBody.includes('Disk market_cache evidence for validate/normalize') &&
      runtimeBody.includes('!this.quoteFromDiskCache') &&
      runtimeBody.includes('Disk-cache / pre-cycle quotes must not take') &&
      runtimeBody.includes('hydrated · ${d.analysis.regime}:${d.analysis.market_state}') &&
      runtimeBody.includes('Never forge green from journal-hydrate alone') &&
      runtimeBody.includes('hydrated ·') &&
      runtimeBody.includes('Sticky last_risk without a live cycle') &&
      runtimeBody.includes('Opportunity seed often has decision but no execution') &&
      runtimeBody.includes('account unproven') &&
      runtimeBody.includes('hydrated · none · awaiting attach') &&
      runtimeBody.includes('open=${opens} · awaiting manage') &&
      runtimeBody.includes('flat · manage never ran') &&
      runtimeBody.includes('Disk-hydrated audit stays green') &&
      runtimeBody.includes('Disk-hydrated KPIs stay green') &&
      runtimeBody.includes('refreshPublicReferenceMids') &&
      runtimeBody.includes('reference_mids:') &&
      runtimeBody.includes("reason: !this.last_market") &&
      runtimeBody.includes("? 'hydrated'") &&
      runtimeBody.includes('pnl=${Number(perf.total_pnl).toFixed(2)}') &&
      !runtimeBody.includes('journal_performance:');
    const manageOwnerApi =
      runtimeBody.includes('manage_owner:') &&
      runtimeBody.includes('resolveManageOwnerStatus') &&
      runtimeBody.includes('DESK_DEFERRED_HARD');
    const journalAuditApi =
      runtimeBody.includes('persist_backend:') &&
      runtimeBody.includes('journal_audit:') &&
      runtimeBody.includes('healed_from_persist');
    const journalAuditUi =
      masterPageBody.includes('persist_backend') &&
      masterPageBody.includes('journal_audit') &&
      masterPageBody.includes('Journal audit');
    const filterCardsHydrateUi =
      masterPageBody.includes("reason === 'hydrated'") &&
      masterPageBody.includes('hydrated ·') &&
      masterPageBody.includes('awaitingCycle');
    const closedPnlUi =
      (masterPageBody.includes("'Closed PnL'") ||
        masterPageBody.includes('Closed PnL')) &&
      masterPageBody.includes("cyclePending ? 'hydrated · ' : ''}") &&
      masterPageBody.includes('status.performance.total_pnl');
    const kpiHydrateUi =
      masterPageBody.includes("'Peak eq'") &&
      masterPageBody.includes("'Expectancy'") &&
      masterPageBody.includes("'Fees'") &&
      masterPageBody.includes("'Win rate'") &&
      masterPageBody.includes("'Loss streak'") &&
      masterPageBody.includes("'Equity'") &&
      masterPageBody.includes("'News'") &&
      masterPageBody.includes("'Close fail'") &&
      masterPageBody.includes("'Reject cool'") &&
      masterPageBody.includes(
        "cyclePending ? 'hydrated · ' : ''}${Number(status.account.peak_equity)"
      ) &&
      masterPageBody.includes(
        "cyclePending ? 'hydrated · ' : ''}${Number(status.account.equity)"
      ) &&
      masterPageBody.includes(
        "cyclePending ? 'hydrated · ' : ''}${Number(status.performance?.expectancy"
      ) &&
      masterPageBody.includes(
        "cyclePending ? 'hydrated · ' : ''}${Number(status.performance.total_fees"
      ) &&
      masterPageBody.includes(
        "cyclePending ? 'hydrated · ' : ''}${String(status.account.consecutive_losses)"
      ) &&
      masterPageBody.includes(
        "cyclePending ? 'hydrated · ' : ''}${status.news_window.impact"
      ) &&
      masterPageBody.includes(
        "cyclePending ? 'hydrated · ' : ''}${status.last_close_failed.exit_reason"
      );
    const decisionCardsHydrateUi =
      masterPageBody.includes('hydrated · ${Number(status.buy_score') &&
      masterPageBody.includes('hydrated · ${status.last_decision.kind}') &&
      masterPageBody.includes('hydrated · ${whyRaw}');
    const whyMonitorHydrateUi =
      masterPageBody.includes('monHydrated') &&
      masterPageBody.includes("cyclePending && whyRaw !== '—'") &&
      masterPageBody.includes('monitoring?.hydrated') &&
      masterPageBody.includes("k: 'ACK ms'") &&
      masterPageBody.includes(
        "monHydrated ? 'hydrated · ' : ''}${status.monitoring.ack_latency_ms}"
      );
    const quoteBarsCacheUi =
      masterPageBody.includes("status.quote.cached ? 'cached · '") &&
      masterPageBody.includes('status.bars_cached') &&
      masterPageBody.includes('cached · ${status.bars_available') &&
      masterPageBody.includes('quoteStale && !status.quote?.cached');
    const hourBarsCacheUi =
      masterPageBody.includes("'Hour bars'") &&
      masterPageBody.includes('status.hour_bars_cached') &&
      masterPageBody.includes('cached · ${status.hour_bars_available') &&
      masterPageBody.includes('status.hour_bars_available');
    const closed10sCacheUi =
      masterPageBody.includes("'Closed 10s'") &&
      masterPageBody.includes('status.closed_10s_cached') &&
      masterPageBody.includes('cached · present') &&
      masterPageBody.includes("status.closed_10s_source === 'journal'");
    const entryGatesHydrateUi =
      masterPageBody.includes('session_hydrated') &&
      masterPageBody.includes("'Entry gates'");
    const masterRouteBody = readFileSync(join(root, 'src/routes/master.ts'), 'utf8');
    const journalAuditEmbed =
      masterRouteBody.includes('persist_backend') &&
      masterRouteBody.includes('Journal audit') &&
      masterRouteBody.includes('Stage·perf') &&
      masterRouteBody.includes("'journal'") &&
      masterRouteBody.includes("'performance'") &&
      masterRouteBody.includes("reason==='hydrated'") &&
      masterRouteBody.includes('.warn{');
    const closedPnlEmbed =
      masterRouteBody.includes('Closed PnL') &&
      masterRouteBody.includes("cyclePending?'hydrated · ':'')+Number(s.performance.total_pnl") &&
      masterRouteBody.includes("cyclePending||monHydrated?'hydrated · ':'')+s.recent_errors");
    const kpiHydrateEmbed =
      masterRouteBody.includes("card('Peak eq'") &&
      masterRouteBody.includes("card('Expectancy'") &&
      masterRouteBody.includes("card('Fees'") &&
      masterRouteBody.includes("card('Win rate'") &&
      masterRouteBody.includes("card('Loss streak'") &&
      masterRouteBody.includes("card('Equity'") &&
      masterRouteBody.includes("card('News'") &&
      masterRouteBody.includes("card('Close fail'") &&
      masterRouteBody.includes("card('Reject cool'") &&
      masterRouteBody.includes(
        "cyclePending?'hydrated · ':'')+Number(s.account.peak_equity"
      ) &&
      masterRouteBody.includes(
        "cyclePending?'hydrated · ':'')+Number(s.account.equity"
      ) &&
      masterRouteBody.includes(
        "cyclePending?'hydrated · ':'')+Number(s.performance.expectancy"
      ) &&
      masterRouteBody.includes(
        "cyclePending?'hydrated · ':'')+Number(s.performance.total_fees"
      ) &&
      masterRouteBody.includes(
        "cyclePending?'hydrated · ':'')+String(s.account.consecutive_losses"
      ) &&
      masterRouteBody.includes(
        "cyclePending?'hydrated · ':'')+s.news_window.impact"
      ) &&
      masterRouteBody.includes(
        "cyclePending?'hydrated · ':'')+(s.last_close_failed.exit_reason"
      );
    const decisionCardsHydrateEmbed =
      masterRouteBody.includes("cyclePending?('hydrated · '+Number(s.buy_score") &&
      masterRouteBody.includes("cyclePending?('hydrated · '+s.last_decision.kind)") &&
      masterRouteBody.includes("('hydrated · '+whyRaw)");
    const whyMonitorHydrateEmbed =
      masterRouteBody.includes('monHydrated') &&
      masterRouteBody.includes("cyclePending&&whyRaw!=='—'") &&
      masterRouteBody.includes('monitoring.hydrated') &&
      masterRouteBody.includes("card('ACK ms'") &&
      masterRouteBody.includes(
        "monHydrated?'hydrated · ':'')+String(s.monitoring.ack_latency_ms)"
      );
    const quoteBarsCacheEmbed =
      masterRouteBody.includes("s.quote.cached?'cached · '") &&
      masterRouteBody.includes("s.bars_cached?('cached · '") &&
      masterRouteBody.includes("s.quote.cached?'warn'");
    const hourBarsCacheEmbed =
      masterRouteBody.includes("card('Hour bars'") &&
      masterRouteBody.includes("s.hour_bars_cached?('cached · '") &&
      masterRouteBody.includes('s.hour_bars_available');
    const closed10sCacheEmbed =
      masterRouteBody.includes("card('Closed 10s'") &&
      masterRouteBody.includes("s.closed_10s_cached?'cached · present'") &&
      masterRouteBody.includes("s.closed_10s_source==='journal'");
    const entryGatesEmbed =
      masterRouteBody.includes("card('Entry gates'") &&
      masterRouteBody.includes('session_hydrated');
    const regimeHydrateApi =
      runtimeBody.includes('hydrated · ${raw}') &&
      runtimeBody.includes('never look live from journal hydrate alone');
    const quoteBarsCacheApi =
      runtimeBody.includes('quoteFromDiskCache') &&
      runtimeBody.includes("source: this.quoteFromDiskCache ? 'disk_cache' : 'live'") &&
      runtimeBody.includes('bars_cached: this.barsFromDiskCache');
    const hourBarsCacheApi =
      runtimeBody.includes('hourBarsFromDiskCache') &&
      runtimeBody.includes('hour_bars_cached: this.hourBarsFromDiskCache') &&
      runtimeBody.includes("? 'disk_cache'") &&
      runtimeBody.includes('cached.hour_bars') &&
      marketCacheBody.includes('hour_bars') &&
      marketCacheBody.includes('hour_bars_detail');
    const closed10sCacheApi =
      runtimeBody.includes('closed10sFromDiskCache') &&
      runtimeBody.includes('closed_10s_cached:') &&
      runtimeBody.includes('cached.closed_10s') &&
      runtimeBody.includes('this.last_closed_10s') &&
      marketCacheBody.includes('closed_10s') &&
      marketCacheBody.includes('finiteTenSec');
    const marketCachePgHealApi =
      marketCacheBody.includes('hydrateMarketCacheFromPersist') &&
      marketCacheBody.includes('persistMarketCacheState') &&
      runtimeBody.includes('hydrateMarketCacheFromPersist') &&
      persistBody.includes('master_market_cache') &&
      existsSync(join(root, 'src/db/migrations/017_master_market_cache.sql')) &&
      restartBody.includes('market_cache_pg_primary_heal_ok') &&
      restartBody.includes('Do NOT re-seed market_cache');
    const epicCycleStashPgHealApi =
      epicStashBody.includes('hydrateEpicCycleStashFromPersist') &&
      epicStashBody.includes('persistEpicCycleStashState') &&
      runtimeBody.includes('hydrateEpicCycleStashFromPersist') &&
      persistBody.includes('master_epic_cycle_stash') &&
      existsSync(
        join(root, 'src/db/migrations/018_master_epic_cycle_stash.sql')
      ) &&
      restartBody.includes('epic_cycle_stash_pg_primary_heal_ok') &&
      restartBody.includes('Do NOT re-seed epic_cycle_stash');
    const gatesBody = readFileSync(
      join(root, 'src/master/runtimeGates.ts'),
      'utf8'
    );
    const runtimeGatesPgHealApi =
      gatesBody.includes('hydrateRuntimeGatesFromPersist') &&
      gatesBody.includes('persistRuntimeGatesState') &&
      runtimeBody.includes('hydrateRuntimeGatesFromPersist') &&
      persistBody.includes('master_runtime_gates') &&
      existsSync(join(root, 'src/db/migrations/019_master_runtime_gates.sql')) &&
      restartBody.includes('runtime_gates_pg_primary_heal_ok') &&
      restartBody.includes('Do NOT re-seed runtime_gates') &&
      restartBody.includes('peak_equity_healed_ok') &&
      restartBody.includes('consecutive_losses_healed_ok') &&
      restartBody.includes('day_start_equity_healed_ok');
    const manageConfigBody = readFileSync(
      join(root, 'src/master/manageConfig.ts'),
      'utf8'
    );
    const manageConfigPgHealApi =
      manageConfigBody.includes('hydrateManageConfigFromPersist') &&
      manageConfigBody.includes('persistManageConfigState') &&
      runtimeBody.includes('hydrateManageConfigFromPersist') &&
      persistBody.includes('master_manage_config') &&
      existsSync(join(root, 'src/db/migrations/020_master_manage_config.sql')) &&
      restartBody.includes('manage_config_pg_primary_heal_ok') &&
      restartBody.includes('Do NOT re-seed manage_config');
    const ownsBody = readFileSync(
      join(root, 'src/master/ownsPipelinePref.ts'),
      'utf8'
    );
    const ownsPipelinePgHealApi =
      ownsBody.includes('hydrateOwnsPipelineFromPersist') &&
      ownsBody.includes('persistOwnsPipelineState') &&
      runtimeBody.includes('hydrateOwnsPipelineFromPersist') &&
      persistBody.includes('master_owns_pipeline') &&
      existsSync(join(root, 'src/db/migrations/021_master_owns_pipeline.sql')) &&
      restartBody.includes('owns_pipeline_pg_primary_heal_ok') &&
      restartBody.includes('Do NOT re-seed owns_pipeline');
    const monitoringBody = readFileSync(
      join(root, 'src/master/monitoring.ts'),
      'utf8'
    );
    const monitoringSnapshotPgHealApi =
      monitoringBody.includes('hydrateMonitoringSnapshotFromPersist') &&
      monitoringBody.includes('persistMonitoringSnapshotState') &&
      runtimeBody.includes('hydrateMonitoringSnapshotFromPersist') &&
      persistBody.includes('master_monitoring_snapshot') &&
      existsSync(
        join(root, 'src/db/migrations/022_master_monitoring_snapshot.sql')
      ) &&
      restartBody.includes('monitoring_snapshot_pg_primary_heal_ok') &&
      restartBody.includes('Do NOT re-seed monitoring_snapshot');
    const spreadBody = readFileSync(
      join(root, 'src/master/spreadModel.ts'),
      'utf8'
    );
    const spreadHistoryPgHealApi =
      spreadBody.includes('hydrateSpreadHistoryFromPersist') &&
      spreadBody.includes('persistSpreadHistoryState') &&
      runtimeBody.includes('hydrateSpreadHistoryFromPersist') &&
      persistBody.includes('master_spread_history') &&
      existsSync(join(root, 'src/db/migrations/023_master_spread_history.sql')) &&
      restartBody.includes('spread_history_pg_primary_heal_ok') &&
      restartBody.includes('Do NOT re-seed spread_history');
    const tradeAckBody = readFileSync(
      join(root, 'src/master/tradeAckJournal.ts'),
      'utf8'
    );
    const tradeAckJournalPgHealApi =
      tradeAckBody.includes('hydrateTradeAckJournalFromPersist') &&
      tradeAckBody.includes('persistTradeAckJournalState') &&
      runtimeBody.includes('hydrateTradeAckJournalFromPersist') &&
      persistBody.includes('master_trade_ack_journal') &&
      existsSync(
        join(root, 'src/db/migrations/024_master_trade_ack_journal.sql')
      ) &&
      restartBody.includes('trade_ack_journal_pg_primary_heal_ok') &&
      restartBody.includes('Do NOT re-seed trade_ack_journal');
    const errorJournalBody = readFileSync(
      join(root, 'src/master/errorJournal.ts'),
      'utf8'
    );
    const errorJournalPgHealApi =
      errorJournalBody.includes('hydrateErrorJournalFromPersist') &&
      errorJournalBody.includes('persistErrorJournalState') &&
      runtimeBody.includes('hydrateErrorJournalFromPersist') &&
      persistBody.includes('master_error_journal') &&
      existsSync(join(root, 'src/db/migrations/025_master_error_journal.sql')) &&
      restartBody.includes('error_journal_pg_primary_heal_ok') &&
      restartBody.includes('Do NOT re-seed error_journal');
    const newsGateBody = readFileSync(
      join(root, 'src/master/newsGate.ts'),
      'utf8'
    );
    const newsWindowPgHealApi =
      newsGateBody.includes('hydrateNewsWindowFromPersist') &&
      newsGateBody.includes('persistNewsWindowState') &&
      newsGateBody.includes('saveNewsWindow') &&
      runtimeBody.includes('hydrateNewsWindowFromPersist') &&
      persistBody.includes('master_news_window') &&
      existsSync(join(root, 'src/db/migrations/026_master_news_window.sql')) &&
      restartBody.includes('news_window_pg_primary_heal_ok') &&
      restartBody.includes('Do NOT re-seed news_window');
    const fanoutBody = readFileSync(
      join(root, 'src/master/masterClientFanout.ts'),
      'utf8'
    );
    const clientFanoutPgHealApi =
      fanoutBody.includes('hydrateClientFanoutFromPersist') &&
      fanoutBody.includes('persistClientFanoutState') &&
      fanoutBody.includes('saveClientFanoutSummary') &&
      runtimeBody.includes('hydrateClientFanoutFromPersist') &&
      persistBody.includes('master_client_fanout') &&
      existsSync(join(root, 'src/db/migrations/027_master_client_fanout.sql')) &&
      restartBody.includes('client_fanout_pg_primary_heal_ok') &&
      restartBody.includes('Do NOT re-seed client_fanout');
    const newsCalBody = readFileSync(
      join(root, 'src/master/newsCalendar.ts'),
      'utf8'
    );
    const newsCalendarPgHealApi =
      newsCalBody.includes('hydrateNewsCalendarFromPersist') &&
      newsCalBody.includes('persistNewsCalendarState') &&
      newsCalBody.includes('saveCalendarDisk') &&
      runtimeBody.includes('hydrateNewsCalendarFromPersist') &&
      persistBody.includes('master_news_calendar') &&
      existsSync(join(root, 'src/db/migrations/028_master_news_calendar.sql')) &&
      restartBody.includes('news_calendar_pg_primary_heal_ok') &&
      restartBody.includes('Do NOT re-seed news_calendar');
    const filePersistBody = readFileSync(
      join(root, 'src/master/filePersist.ts'),
      'utf8'
    );
    const monitoringOpMetaBody = readFileSync(
      join(root, 'src/master/monitoring.ts'),
      'utf8'
    );
    const operatorMetaSidecarParityApi =
      filePersistBody.includes('monitoring_snapshot') &&
      filePersistBody.includes('spread_history') &&
      filePersistBody.includes('news_window') &&
      filePersistBody.includes('client_fanout') &&
      filePersistBody.includes('trade_ack_journal') &&
      filePersistBody.includes('error_journal') &&
      filePersistBody.includes('error_journal.jsonl') &&
      monitoringOpMetaBody.includes('embedOperatorMetaPatch') &&
      monitoringOpMetaBody.includes('monitoring_snapshot') &&
      readFileSync(join(root, 'src/master/spreadModel.ts'), 'utf8').includes(
        'embedOperatorMetaPatch'
      ) &&
      readFileSync(join(root, 'src/master/newsGate.ts'), 'utf8').includes(
        'embedOperatorMetaPatch'
      ) &&
      fanoutBody.includes('embedOperatorMetaPatch') &&
      tradeAckBody.includes('embedOperatorMetaPatch') &&
      errorJournalBody.includes('embedOperatorMetaPatch') &&
      errorJournalBody.includes('error_journal') &&
      existsSync(
        join(root, 'src/master/__tests__/operatorMetaSidecarParity.test.ts')
      );
    const tickStickyDeskArmsApi =
      runtimeBody.includes('hourBarsForCycle') &&
      runtimeBody.includes('closed10sForCycle') &&
      runtimeBody.includes('opts?.closed_10s ?? this.last_closed_10s') &&
      runtimeBody.includes('this.last_hour_bars.length >= 6');
    const entryGatesHydrateApi =
      runtimeBody.includes('session_hydrated: sessionHydrated') &&
      runtimeBody.includes('Journal session must not look live');
    const whyMonitorHydrateApi =
      runtimeBody.includes('Journal / disk Why must not paint') &&
      runtimeBody.includes('monHydrated') &&
      runtimeBody.includes('Disk-hydrated monitor must not look');
    const floatUplCacheUi =
      masterPageBody.includes('floating_pnl_cached') &&
      masterPageBody.includes("cached · '") &&
      masterPageBody.includes("'Float UPL'");
    const floatUplCacheEmbed =
      masterRouteBody.includes('floating_pnl_cached') &&
      masterRouteBody.includes("s.floating_pnl_cached?'cached · '");
    const floatUplCacheApi =
      runtimeBody.includes('floating_pnl_cached:') &&
      runtimeBody.includes('quoteFromDiskCache === true');
    const riskSeedApi =
      runtimeBody.includes('Seed Stage·risk evidence from journal opportunity') &&
      runtimeBody.includes('latestOpp.risk');
    const exitHydrateUi =
      masterPageBody.includes("hydrated · ${status.last_exit_reason}") &&
      masterPageBody.includes("'Last exit'");
    const exitHydrateEmbed =
      masterRouteBody.includes("cyclePending?('hydrated · '+s.last_exit_reason)") &&
      masterRouteBody.includes("card('Last exit'");
    const normDiskHydrateUi =
      masterPageBody.includes("normalization?.detail?.startsWith(") &&
      masterPageBody.includes("'Norm'");
    const normDiskHydrateEmbed =
      masterRouteBody.includes("card('Norm'") &&
      masterRouteBody.includes("normalization.detail") &&
      masterRouteBody.includes("hydrated ·");
    const livePaperDemoBody = readFileSync(
      join(root, 'src/master/scripts/livePaperDemo.ts'),
      'utf8'
    );
    const livePaperHonestyBody = readFileSync(
      join(root, 'src/master/livePaperHonesty.ts'),
      'utf8'
    );
    const verifyBody = readFileSync(
      join(root, 'src/master/scripts/verify.ts'),
      'utf8'
    );
    const livePaperRetry =
      livePaperDemoBody.includes('resetLivePaperRuntime') &&
      livePaperDemoBody.includes('MASTER_LIVE_PAPER_ENTRY_ATTEMPTS') &&
      livePaperHonestyBody.includes('shouldRetryLivePaperDemo') &&
      verifyBody.includes('shouldRetryLivePaperDemo') &&
      verifyBody.includes('MASTER_VERIFY_LIVE_PAPER_ATTEMPTS');
    const paperEquityReseedApi =
      runtimeBody.includes('seedPaperBrokerFromPositions') &&
      runtimeBody.includes('Flat book: still reseed PaperBroker equity') &&
      runtimeBody.includes(
        "overwrites recovered equity back to PaperBroker's default £10k"
      ) &&
      runtimeBody.includes('Always restore equity/balance from recovered account') &&
      readFileSync(
        join(root, 'src/master/__tests__/master.gaps.test.ts'),
        'utf8'
      ).includes('flat paper book reseeds equity');
    const dualPersistBody = readFileSync(
      join(root, 'src/master/dualPersist.ts'),
      'utf8'
    );
    const dualPersistNewerMirrorApi =
      dualPersistBody.includes('Non-empty stale PG after a failed primary write') &&
      dualPersistBody.includes('prefer higher saved_at_ms on singleton') &&
      dualPersistBody.includes('Open book diverged') &&
      dualPersistBody.includes('fingerprint(mirrorResult.rows)') &&
      readFileSync(
        join(root, 'src/master/__tests__/filePersist.test.ts'),
        'utf8'
      ).includes('prefers newer mirror open book when non-empty primary is stale');
    const filePersistSingletonSeedApi =
      filePersistBody.includes('seedSingletonPayloadsFromDisk') &&
      filePersistBody.includes(
        'Sidecars alone must still back DualPersist mirror SELECTs'
      ) &&
      filePersistBody.includes('Cold start: sidecar JSON/jsonl must populate') &&
      readFileSync(
        join(root, 'src/master/__tests__/filePersist.test.ts'),
        'utf8'
      ).includes(
        'cold FilePersist seeds singleton mem from sidecar JSON for DualPersist SELECT'
      );
    const livePaperDeskConfirm =
      livePaperDemoBody.includes('deskConfirmTickOpts') &&
      livePaperDemoBody.includes('closed10sFromReplayBar') &&
      livePaperDemoBody.includes('fetchYahooHourBars') &&
      livePaperDemoBody.includes('desk_confirm_fed') &&
      livePaperHonestyBody.includes('desk_confirm_fed !== true') &&
      livePaperHonestyBody.includes("desk !== 'setup' && desk !== 'move'") &&
      existsSync(
        join(root, 'src/master/__tests__/livePaperDeskConfirm.test.ts')
      );
    const decisionBody = readFileSync(join(root, 'src/master/decision.ts'), 'utf8');
    const pipelineBody = readFileSync(join(root, 'src/master/pipeline.ts'), 'utf8');
    const typesBody = readFileSync(join(root, 'src/master/types.ts'), 'utf8');
    const liveFeedTestBody = readFileSync(
      join(root, 'src/master/__tests__/liveFeed.test.ts'),
      'utf8'
    );
    const setupDeriveExists = existsSync(join(root, 'src/master/setupDerive.ts'));
    const setupArmedApi =
      decisionBody.includes('gatePreferredBySetup') &&
      decisionBody.includes('setup_side_mismatch') &&
      decisionBody.includes('setup_none') &&
      runtimeBody.includes("require_armed_setup: mode === 'LIVE'") &&
      runtimeBody.includes('setup_gate_armed:') &&
      runtimeBody.includes('last_market_setup') &&
      pipelineBody.includes('advanceMarketSetup') &&
      pipelineBody.includes('market_setup:') &&
      setupDeriveExists;
    const setupArmedUi =
      masterPageBody.includes("'SETUP'") &&
      masterPageBody.includes('setup_gate_armed') &&
      masterPageBody.includes('market_setup') &&
      masterPageBody.includes(
        "cyclePending ? 'hydrated · ' : ''}${status.setup_gate_armed ? 'gate · ' : ''}${status.market_setup.status"
      ) &&
      masterPageBody.includes("'Entries'") &&
      masterPageBody.includes(
        "cyclePending ? 'hydrated · ' : ''}armed"
      );
    const setupArmedEmbed =
      masterRouteBody.includes("card('SETUP'") &&
      masterRouteBody.includes('setup_gate_armed') &&
      masterRouteBody.includes(
        "cyclePending?'hydrated · ':'')+(s.setup_gate_armed?'gate · ':'')+s.market_setup.status"
      ) &&
      masterRouteBody.includes("card('Entries'") &&
      masterRouteBody.includes("cyclePending?'hydrated · ':'')+'armed'");
    const liveExpectancyDefaultApi =
      runtimeBody.includes("require_positive_expectancy: mode === 'LIVE'") &&
      runtimeBody.includes('require_positive_expectancy') &&
      runtimeBody.includes('expectancy_gate_armed:') &&
      decisionBody.includes('negative_expectancy') &&
      decisionBody.includes('require_positive_expectancy');
    const liveExpectancyDefaultUi =
      masterPageBody.includes("'EV gate'") &&
      masterPageBody.includes('expectancy_gate_armed') &&
      masterPageBody.includes('expectancy_would_block');
    const liveExpectancyDefaultEmbed =
      masterRouteBody.includes("card('EV gate'") &&
      masterRouteBody.includes('expectancy_gate_armed') &&
      masterRouteBody.includes('expectancy_would_block');
    const masterOwnsFanoutApi =
      runtimeBody.includes('fanoutAcceptedOpenToClients') &&
      runtimeBody.includes('executeMasterOwnedFanout') &&
      runtimeBody.includes('journalMasterFanoutFills') &&
      runtimeBody.includes('recordFanoutClientClose') &&
      runtimeBody.includes('last_client_fanout') &&
      existsSync(join(root, 'src/master/masterClientFanout.ts')) &&
      readFileSync(join(root, 'src/master/masterClientFanout.ts'), 'utf8').includes(
        'journalMasterFanoutFills'
      ) &&
      readFileSync(join(root, 'src/master/masterClientFanout.ts'), 'utf8').includes(
        'buildFanoutCloseOutcome'
      ) &&
      readFileSync(join(root, 'src/services/intentFanout.ts'), 'utf8').includes(
        'executeMasterOwnedFanout'
      ) &&
      readFileSync(join(root, 'src/services/robotDesk.ts'), 'utf8').includes(
        'recordFanoutClientClose'
      );
    const masterOwnsFanoutUi =
      masterPageBody.includes("'Client fanout'") &&
      masterPageBody.includes('last_client_fanout');
    const masterOwnsFanoutEmbed =
      masterRouteBody.includes("card('Client fanout'") &&
      masterRouteBody.includes('last_client_fanout');
    const deskEntryApi =
      existsSync(join(root, 'src/master/deskEntryConfirm.ts')) &&
      runtimeBody.includes('closed_10s') &&
      runtimeBody.includes('hour_bars') &&
      pipelineBody.includes('resolveDeskEntryConfirm') &&
      pipelineBody.includes('closed_10s') &&
      pipelineBody.includes('hour_bars') &&
      decisionBody.includes('setup_confirm_pending') &&
      readFileSync(join(root, 'src/services/robotDesk.ts'), 'utf8').includes(
        'resolveDeskEntryConfirm'
      ) &&
      !readFileSync(join(root, 'src/services/robotDesk.ts'), 'utf8').includes(
        'decideEntryFromSetup('
      ) &&
      readFileSync(join(root, 'src/master/deskBridge.ts'), 'utf8').includes(
        'hourCandles'
      ) &&
      readFileSync(join(root, 'src/services/robotDesk.ts'), 'utf8').includes(
        'last_hour_candles'
      );
    const liveFeedBody = readFileSync(join(root, 'src/master/liveFeed.ts'), 'utf8');
    const liveFeedClosed10s =
      liveFeedBody.includes('closed10sFromJustClosed') &&
      liveFeedBody.includes('stickyClosed10s') &&
      runtimeBody.includes('stickyClosed10s') &&
      runtimeBody.includes('lastClosed10s') &&
      runtimeBody.includes('justClosed') &&
      /startBrokerLiveFeed[\s\S]*stickyClosed10s[\s\S]*lastClosed10s[\s\S]*closed_10s/.test(
        runtimeBody
      ) &&
      /startPublicLiveFeed[\s\S]*stickyClosed10s[\s\S]*lastClosed10s[\s\S]*closed_10s/.test(
        runtimeBody
      );
    const brokerBody = readFileSync(join(root, 'src/master/broker.ts'), 'utf8');
    const liveFeedHourBars =
      liveFeedBody.includes('fetchYahooHourBars') &&
      liveFeedBody.includes('refreshHourBarsCache') &&
      brokerBody.includes('getHourBars') &&
      brokerBody.includes("'HOUR'") &&
      runtimeBody.includes('refreshHourBarsCache') &&
      /startBrokerLiveFeed[\s\S]*refreshHourBarsCache[\s\S]*hour_bars/.test(
        runtimeBody
      ) &&
      /startPublicLiveFeed[\s\S]*refreshHourBarsCache[\s\S]*hour_bars/.test(
        runtimeBody
      );
    const deskEntryDash =
      runtimeBody.includes('last_desk_entry') &&
      runtimeBody.includes('last_hour_bias') &&
      runtimeBody.includes('desk_entry:') &&
      runtimeBody.includes('hour_bias:') &&
      runtimeBody.includes('closed_10s_present:') &&
      runtimeBody.includes('last_closed_10s_present') &&
      masterPageBody.includes("'Desk entry'") &&
      masterPageBody.includes('hour_bias') &&
      masterPageBody.includes("'Closed 10s'") &&
      masterPageBody.includes('closed_10s_present') &&
      masterRouteBody.includes("card('Desk entry'") &&
      masterRouteBody.includes("card('Hour bias'") &&
      masterRouteBody.includes("card('Closed 10s'");
    const decisionJournalBody = readFileSync(
      join(root, 'src/master/decisionJournal.ts'),
      'utf8'
    );
    const deskEntryJournal =
      decisionJournalBody.includes('desk_entry_source') &&
      decisionJournalBody.includes('hour_bias') &&
      decisionJournalBody.includes('closed_10s_present') &&
      runtimeBody.includes('desk_entry_source:') &&
      runtimeBody.includes('desk_entry_side:') &&
      runtimeBody.includes('closed_10s_present: this.last_closed_10s_present') &&
      masterPageBody.includes('desk_entry_source') &&
      masterPageBody.includes('confirm ${d.desk_entry_source') &&
      masterRouteBody.includes('desk_entry_source');
    const deskEntryPgMig = readFileSync(
      join(root, 'src/db/migrations/015_master_decision_desk_entry.sql'),
      'utf8'
    );
    const deskEntryPgHydrate =
      existsSync(join(root, 'src/db/migrations/015_master_decision_desk_entry.sql')) &&
      deskEntryPgMig.includes('desk_entry_source') &&
      deskEntryPgMig.includes('closed_10s_present') &&
      persistBody.includes('desk_entry_source') &&
      persistBody.includes('closed_10s_present') &&
      persistBody.includes('hour_bias') &&
      /INSERT INTO master_decision_events[\s\S]*desk_entry_source[\s\S]*closed_10s_present/.test(
        persistBody
      ) &&
      /SELECT[\s\S]*desk_entry_source[\s\S]*closed_10s_present[\s\S]*master_decision_events/.test(
        persistBody
      ) &&
      readFileSync(join(root, 'src/master/auditJournalHydrate.ts'), 'utf8').includes(
        'loadDecisionEventsFromPersist'
      );
    const performanceBody = readFileSync(
      join(root, 'src/master/performance.ts'),
      'utf8'
    );
    const deskEntryPerfJoin =
      performanceBody.includes('performanceByDeskEntry') &&
      performanceBody.includes('opportunity.decision') &&
      performanceBody.includes('fromOpp') &&
      performanceBody.includes('deskSourceFromSetupKey') &&
      performanceBody.includes('r.setup_key') &&
      runtimeBody.includes('performanceByDeskEntry') &&
      runtimeBody.includes('applyOutcomeSetupKeys') &&
      runtimeBody.includes('performance_by_desk_entry') &&
      masterPageBody.includes('performance_by_desk_entry') &&
      masterPageBody.includes("'Confirm PnL'") &&
      masterRouteBody.includes("card('Confirm PnL'");
    const expectancyBody = readFileSync(
      join(root, 'src/master/expectancy.ts'),
      'utf8'
    );
    const deskSourceExpectancyDash =
      expectancyBody.includes('expectancyByDeskSource') &&
      runtimeBody.includes('expectancyByDeskSource') &&
      runtimeBody.includes('expectancy_by_desk_entry') &&
      masterPageBody.includes('expectancy_by_desk_entry') &&
      masterPageBody.includes("'Confirm EV'") &&
      masterRouteBody.includes("card('Confirm EV'");
    const confirmDeskHydrateWarn =
      masterPageBody.includes("'Confirm PnL'") &&
      masterPageBody.includes("'Confirm EV'") &&
      masterPageBody.includes("cyclePending ? 'hydrated · ' : ''}${body}") &&
      /Confirm PnL[\s\S]*warn:[\s\S]*cyclePending &&[\s\S]*performance_by_desk_entry/.test(
        masterPageBody
      ) &&
      masterRouteBody.includes("card('Confirm PnL'") &&
      masterRouteBody.includes("card('Confirm EV'") &&
      masterRouteBody.includes("cyclePending?'hydrated · ':'')+body");
    const tradeDeskRestartHydrate =
      restartBody.includes("desk_entry_source: 'setup'") &&
      restartBody.includes('recent_trades_desk_setup') &&
      restartBody.includes('trade_jsonl_desk_setup') &&
      restartBody.includes('performance_by_desk_setup_trades') &&
      restartBody.includes('desk_entry_hydrated') &&
      restartBody.includes('GOLD|BUY|LOW_VOLATILITY|UP|LONDON|setup');
    const deskEntryOpenHydrate =
      existsSync(join(root, 'src/master/deskEntryHydrate.ts')) &&
      runtimeBody.includes('backfillDeskEntrySources') &&
      runtimeBody.includes('hydrateBookFromDisk') &&
      readFileSync(join(root, 'src/master/positionManager.ts'), 'utf8').includes(
        "desk_entry_source: 'none'"
      );
    const deskEntryStatusHydrate =
      runtimeBody.includes('seedDashboardFromHistory') &&
      runtimeBody.includes('hydrated · ${withConfirm.desk_entry_source}') &&
      runtimeBody.includes('last_closed_10s_present = true') &&
      runtimeBody.includes('withBias?.hour_bias') &&
      runtimeBody.includes('oppConfirm?.decision?.desk_entry_source');
    const openPosConfirmDash =
      runtimeBody.includes('desk_entry_source:') &&
      /positionsForApi[\s\S]*desk_entry_source/.test(runtimeBody) &&
      masterPageBody.includes('desk_entry_source') &&
      masterPageBody.includes('confirm ${p.desk_entry_source}') &&
      masterRouteBody.includes("confirm '+p.desk_entry_source");
    const closedTradeConfirmDash =
      runtimeBody.includes('deskSourceFromSetupKey') &&
      /recent_trades:[\s\S]*desk_entry_source/.test(runtimeBody) &&
      masterPageBody.includes('confirm ${t.desk_entry_source}') &&
      masterPageBody.includes("confirm ${src}") &&
      masterRouteBody.includes("confirm '+t.desk_entry_source") &&
      masterRouteBody.includes("confirm '+src");
    const tradeEventDeskConfirm =
      existsSync(
        join(root, 'src/db/migrations/016_master_trade_desk_entry.sql')
      ) &&
      readFileSync(
        join(root, 'src/db/migrations/016_master_trade_desk_entry.sql'),
        'utf8'
      ).includes('desk_entry_source') &&
      readFileSync(join(root, 'src/master/tradeEventJournal.ts'), 'utf8').includes(
        'normalizeTradeDeskSource'
      ) &&
      persistBody.includes('desk_entry_source') &&
      /INSERT INTO master_trade_events[\s\S]*desk_entry_source/.test(persistBody) &&
      runtimeBody.includes('desk_entry_source: cycle.decision.desk_entry_source') &&
      runtimeBody.includes('normalizeTradeDeskSource(e.desk_entry_source)') &&
      existsSync(
        join(root, 'src/master/__tests__/tradeEventDeskConfirm.test.ts')
      );
    const deskConfirmCardHydrate =
      masterPageBody.includes("cyclePending ? 'hydrated · ' : ''}${status.desk_entry.source") &&
      masterPageBody.includes("cyclePending ? 'hydrated · ' : ''}${status.hour_bias}") &&
      masterPageBody.includes("cyclePending ? 'hydrated · ' : ''}${") &&
      masterPageBody.includes('!cyclePending && !!status.desk_entry') &&
      masterRouteBody.includes("cyclePending?'hydrated · ':'')+s.desk_entry.source") &&
      masterRouteBody.includes("cyclePending?'hydrated · ':'')+s.hour_bias") &&
      masterRouteBody.includes("!cyclePending&&s.desk_entry?'ok'") &&
      masterRouteBody.includes("!cyclePending&&s.market_setup&&s.market_setup.status==='ARMED'");
    const pipelineRouteBody = readFileSync(
      join(root, 'src/routes/pipeline.ts'),
      'utf8'
    );
    const marketCoreFailClosed =
      existsSync(join(root, 'src/services/marketCoreIntentGate.ts')) &&
      pipelineRouteBody.includes('marketCoreEntryIntentsAllowed') &&
      pipelineRouteBody.includes('409') &&
      runtimeBody.includes('market_core_intents_allowed') &&
      masterPageBody.includes("'Market Core intents'") &&
      masterRouteBody.includes("card('Market Core intents'");
    const deskBody = readFileSync(join(root, 'src/services/robotDesk.ts'), 'utf8');
    const deskBridgeMeta =
      deskBody.includes('manage_owner:') &&
      deskBody.includes('MASTER BRIDGE') &&
      deskBody.includes('deskSessionStartPolicy') &&
      deskBody.includes('disableDeskEntryBrainsWhileOwns') &&
      runtimeBody.includes('disableDeskEntryBrainsWhileOwns');
    const deskBridgeBody = readFileSync(
      join(root, 'src/master/deskBridge.ts'),
      'utf8'
    );
    const deskFeedDivergent =
      deskBridgeBody.includes('refreshPublicReferenceMids') &&
      deskBridgeBody.includes('reference_mids:') &&
      runtimeBody.includes('refreshPublicReferenceMids') &&
      readFileSync(join(root, 'src/master/marketData.ts'), 'utf8').includes(
        'feed_divergent'
      );
    const multiEpicCycleApi =
      runtimeBody.includes('cycles_by_epic') &&
      runtimeBody.includes('setupByEpic') &&
      runtimeBody.includes('rememberCycleForEpic') &&
      pipelineBody.includes('restoreMarketSetup') &&
      pipelineBody.includes('snapshotMarketSetup') &&
      readFileSync(join(root, 'src/master/positionManager.ts'), 'utf8').includes(
        'quoteMatchesPosition'
      );
    const positionManagerBody = readFileSync(
      join(root, 'src/master/positionManager.ts'),
      'utf8'
    );
    const barsOpenTimeStopApi =
      positionManagerBody.includes('export function resolveTimeStop') &&
      positionManagerBody.includes('time_stop_max_bars') &&
      positionManagerBody.includes('bars_open') &&
      positionManagerBody.includes(
        'Count this manage cycle (Reader bars_open)'
      ) &&
      typesBody.includes('time_stop_max_bars: number') &&
      pipelineBody.includes('time_stop_max_bars: 12') &&
      runtimeBody.includes('time_stop_max_bars: this.cfg.time_stop_max_bars') &&
      persistBody.includes('bars_open:') &&
      liveFeedTestBody.includes(
        'bars_open TIME_STOP ignores wall-clock max_hold_ms'
      ) &&
      liveFeedTestBody.includes('resolveTimeStop prefers bars mode');
    const paperSlTpAutofillApi =
      brokerBody.includes('processStopsAndTargets') &&
      brokerBody.includes('takeRecentAutoFill') &&
      brokerBody.includes('peekRecentAutoFill') &&
      brokerBody.includes('paper_auto_') &&
      brokerBody.includes('return net fill_pnl so manage never journals stale UPL') &&
      brokerBody.includes('fill_pnl: net') &&
      readFileSync(join(root, 'src/master/positionSync.ts'), 'utf8').includes(
        'paperAutofillReady'
      ) &&
      runtimeBody.includes('takeRecentAutoFill') &&
      runtimeBody.includes('paperAuto?.reason') &&
      runtimeBody.includes('paperAuto?.fill_pnl') &&
      existsSync(
        join(root, 'src/master/__tests__/paperSlTpAutofill.test.ts')
      ) &&
      readFileSync(
        join(root, 'src/master/__tests__/paperSlTpAutofill.test.ts'),
        'utf8'
      ).includes('auto-fills STOP_HIT on quote without manageTick') &&
      readFileSync(
        join(root, 'src/master/__tests__/paperSlTpAutofill.test.ts'),
        'utf8'
      ).includes('sync journals STOP_HIT same cycle') &&
      readFileSync(
        join(root, 'src/master/__tests__/paperSlTpAutofill.test.ts'),
        'utf8'
      ).includes('manage TIME_STOP journals net fill_pnl not stale broker_upl');
    const paperManageFillPnlApi =
      brokerBody.includes('return net fill_pnl so manage never journals stale UPL') &&
      brokerBody.includes('fill_pnl: net') &&
      readFileSync(
        join(root, 'src/master/__tests__/monitoringFees.test.ts'),
        'utf8'
      ).includes('PaperBroker close returns net fill_pnl');
    const paperTickManageBeforeSyncApi =
      runtimeBody.includes(
        'Paper: manage BEFORE sync so setQuote auto SL/TP is tick-observed'
      ) &&
      runtimeBody.includes('managed = await runTickManage()') &&
      runtimeBody.includes('await runTickSync()') &&
      runtimeBody.includes(
        'Paper: manage before sync so auto-fill STOP_HIT is tick-observed'
      ) &&
      readFileSync(
        join(root, 'src/master/__tests__/paperSlTpAutofill.test.ts'),
        'utf8'
      ).includes(
        'full tick() returns exits≥1 with STOP_HIT (not sync-only ghost)'
      );
    const moneyExitBody = readFileSync(
      join(root, 'src/master/moneyExit.ts'),
      'utf8'
    );
    const gapsTestBody = readFileSync(
      join(root, 'src/master/__tests__/master.gaps.test.ts'),
      'utf8'
    );
    const softExitRMultipleApi =
      moneyExitBody.includes('export function rMultipleFromClose') &&
      moneyExitBody.includes('Soft/scalp exits must not hardcode 0') &&
      positionManagerBody.includes('rMultipleFromClose({') &&
      !positionManagerBody.includes('r_multiple: 0') &&
      runtimeBody.includes('rMultipleFromClose({') &&
      gapsTestBody.includes(
        'Soft trail must journal real R (not hardcoded 0)'
      );
    const manageOnlyEquityRefreshApi =
      runtimeBody.includes('applyVenueAccountAfterClose') &&
      runtimeBody.includes('applyVenueAccountSnapshot') &&
      runtimeBody.includes(
        'Always refresh full venue account snapshot after manageOnly MTM'
      ) &&
      runtimeBody.includes(
        'open book (Stop-with-opens)'
      ) &&
      readFileSync(
        join(root, 'src/master/__tests__/paperSlTpAutofill.test.ts'),
        'utf8'
      ).includes(
        'manageOnlyTick refreshes account.equity from PaperBroker after STOP_HIT'
      );
    const manageOnlyMtmEquityApi =
      brokerBody.includes(
        'balance = realized cash; equity = cash + Σ open UPL'
      ) &&
      brokerBody.includes(
        'Updates position.upl and mirrors Capital-style equity = cash + ΣUPL'
      ) &&
      runtimeBody.includes(
        'Always refresh full venue account snapshot after manageOnly MTM'
      ) &&
      runtimeBody.includes(
        'Paper: seed venue with caller mark first so getQuote cannot revive a stale'
      ) &&
      readFileSync(
        join(root, 'src/master/__tests__/paperSlTpAutofill.test.ts'),
        'utf8'
      ).includes(
        'manageOnlyTick updates account.equity from PaperBroker MTM while open'
      );
    const manageOnlyAccountFieldsApi =
      runtimeBody.includes('applyVenueAccountSnapshot') &&
      runtimeBody.includes(
        'copies currency / available_to_deal / trade_allowed when the venue'
      ) &&
      runtimeBody.includes(
        'or Capital prove stale until the next full tick'
      ) &&
      readFileSync(
        join(root, 'src/master/__tests__/paperSlTpAutofill.test.ts'),
        'utf8'
      ).includes(
        'manageOnlyTick refreshes available_to_deal and trade_allowed from getAccount'
      );
    const postClosePeakEquityApi =
      runtimeBody.includes('applyVenueAccountAfterClose') &&
      runtimeBody.includes(
        'After manage closes: copy venue equity/balance and raise peak_equity'
      ) &&
      runtimeBody.includes(
        'Same-tick risk + manageOnly Peak eq KPI must not lag'
      ) &&
      readFileSync(
        join(root, 'src/master/__tests__/paperSlTpAutofill.test.ts'),
        'utf8'
      ).includes(
        'manageOnlyTick raises peak_equity after winning TP auto-fill'
      );
    const manualCloseVenueEquityApi =
      runtimeBody.includes(
        'Desk Flatten/Close: refresh full venue account snapshot'
      ) &&
      runtimeBody.includes('applyVenueAccountSnapshot(broker, acct, quote)') &&
      readFileSync(
        join(root, 'src/master/__tests__/operatorClose.test.ts'),
        'utf8'
      ).includes(
        'Desk close must refresh venue equity/peak (not wait for next full tick)'
      );
    const syncGhostVenueEquityApi =
      runtimeBody.includes(
        'Sync-ghost / external-partial closes move venue equity'
      ) &&
      runtimeBody.includes('syncClosed > 0') &&
      runtimeBody.includes('async applySyncJournal') &&
      runtimeBody.includes(
        'await this.applyVenueAccountSnapshot(this.broker, acct, quote)'
      ) &&
      readFileSync(
        join(root, 'src/master/__tests__/paperSlTpAutofill.test.ts'),
        'utf8'
      ).includes(
        'sync-ghost STOP_HIT refreshes account equity without manage close'
      );
    const syncGhostPostExitApi =
      runtimeBody.includes(
        'settle like manage: post-exit cool + full'
      ) &&
      runtimeBody.includes('syncClosed > 0') &&
      runtimeBody.includes('post_exit_until_ms') &&
      readFileSync(
        join(root, 'src/master/__tests__/paperSlTpAutofill.test.ts'),
        'utf8'
      ).includes(
        'Sync-ghost must arm post-exit cool like manage/manual closes'
      );
    const closePathAccountSnapshotApi =
      runtimeBody.includes(
        'Desk Flatten/Close: refresh full venue account snapshot'
      ) &&
      runtimeBody.includes(
        'await this.applyVenueAccountSnapshot(this.broker, acct, quote)'
      ) &&
      runtimeBody.includes(
        'available/trade_allowed + Capital prove), not thinner AfterClose only'
      ) &&
      readFileSync(
        join(root, 'src/master/__tests__/operatorClose.test.ts'),
        'utf8'
      ).includes(
        'Desk close refreshes available_to_deal via venue account snapshot'
      );
    const manageOnlyDailyPnlRollApi =
      runtimeBody.includes(
        'Roll UTC day before any manage/sync close mutates daily_pnl'
      ) &&
      runtimeBody.includes('this.rollDailyPnl();') &&
      runtimeBody.includes('manageOnlyUnlocked') &&
      readFileSync(
        join(root, 'src/master/__tests__/dailyPnl.test.ts'),
        'utf8'
      ).includes(
        'manageOnlyTick rolls stale daily_pnl_day before sync-ghost close'
      );
    const manageOnlyFingerprintClearApi =
      runtimeBody.includes('clearSpentEntryFingerprint') &&
      runtimeBody.includes(
        'manageOnly must mirror full tick so Stop-with-opens does not persist'
      ) &&
      runtimeBody.includes(
        'Flat after manage/sync close + cool elapsed → clear spent fingerprint'
      ) &&
      readFileSync(
        join(root, 'src/master/__tests__/paperSlTpAutofill.test.ts'),
        'utf8'
      ).includes(
        'manageOnlyTick clears spent last_entry_fingerprint when flat'
      );
    const multiEpicManageApi =
      positionManagerBody.includes('quoteMatchesPosition') &&
      positionManagerBody.includes('skipped_wrong_epic') &&
      positionManagerBody.includes('portfolioUniverse') &&
      runtimeBody.includes('runManageAcrossOpenEpics') &&
      runtimeBody.includes('manage_epics') &&
      runtimeBody.includes('floating_pnl_epic_scoped') &&
      runtimeBody.includes('openEpicKeys');
    const paperQuoteEpicStrictApi =
      brokerBody.includes(
        'never return a foreign-epic lastQuote'
      ) &&
      brokerBody.includes(
        'getQuote already fail-closed; quoteForEpic must match for MTM / close / place'
      ) &&
      readFileSync(
        join(root, 'src/master/__tests__/multiEpicManage.test.ts'),
        'utf8'
      ).includes(
        'markToMarket does not apply GOLD quote to SILVER open (equity isolation)'
      );
    const bootstrapManageOnQuoteApi =
      runtimeBody.includes(
        'Quote alone is enough for hard STOP/TP + venue account snapshot'
      ) &&
      runtimeBody.includes(
        'wait for bars.length >= 5 (OHLC structure is optional on manageOnly)'
      ) &&
      runtimeBody.includes(
        'Missing ts_ms → fail closed (aged), never forge Date.now() freshness'
      ) &&
      readFileSync(
        join(root, 'src/master/__tests__/master.gaps.test.ts'),
        'utf8'
      ).includes(
        'bootstrap manage-on-quote runs without waiting for 5 OHLC bars'
      );
    const feedMissManageOnQuoteApi =
      runtimeBody.includes(
        'Quote alone is enough (parity with bootstrap manage-on-quote); OHLC ≥5 optional'
      ) &&
      runtimeBody.includes('feedMissManageFallbackPublic') &&
      (runtimeBody.match(
        /Quote alone is enough \(parity with bootstrap manage-on-quote\); OHLC ≥5 optional/g
      )?.length ?? 0) >= 2 &&
      readFileSync(
        join(root, 'src/master/__tests__/master.gaps.test.ts'),
        'utf8'
      ).includes(
        'feed-miss manage-on-quote runs with short OHLC cache (parity with bootstrap)'
      );
    const multiEpicManageUi =
      masterPageBody.includes("'Manage epics'") &&
      masterPageBody.includes('manage_epics') &&
      masterPageBody.includes('floating_pnl_epic_scoped');
    const multiEpicManageEmbed =
      masterRouteBody.includes("card('Manage epics'") &&
      masterRouteBody.includes('manage_epics') &&
      masterRouteBody.includes('floating_pnl_epic_scoped');
    const multiEpicCycleUi =
      masterPageBody.includes("'Cycles by epic'") &&
      masterPageBody.includes('cycles_by_epic') &&
      masterPageBody.includes('cycles_by_epic_hydrated');
    const multiEpicCycleEmbed =
      masterRouteBody.includes("card('Cycles by epic'") &&
      masterRouteBody.includes('cycles_by_epic') &&
      masterRouteBody.includes('cycles_by_epic_hydrated');
    const epicCycleStashPersist =
      existsSync(join(root, 'src/master/epicCycleStash.ts')) &&
      runtimeBody.includes('saveEpicCycleStash') &&
      runtimeBody.includes('loadEpicCycleStash') &&
      runtimeBody.includes('hydrateEpicCycleStashFromDisk') &&
      readFileSync(join(root, 'src/master/filePersist.ts'), 'utf8').includes(
        'epic_cycle_stash'
      );
    const epicScopedSetupKey =
      decisionBody.includes('capitalApiEpic') &&
      decisionBody.includes('epicPart') &&
      pipelineBody.includes('epic: input.instrument.epic') &&
      readFileSync(join(root, 'src/master/decision.ts'), 'utf8').includes(
        '${epicPart}|${side}|'
      );
    const deskSourceSetupKey =
      decisionBody.includes('normalizeDeskConfirmSource') &&
      decisionBody.includes('desk_entry_source: deskSrc') &&
      decisionBody.includes('|${desk}') &&
      pipelineBody.includes('decision.desk_entry_source') &&
      runtimeBody.includes('pos.decision.desk_entry_source') &&
      runtimeBody.includes('c.position.decision.desk_entry_source');
    const replayBody = readFileSync(join(root, 'src/master/replay.ts'), 'utf8');
    const replayDeskConfirm =
      replayBody.includes('closed10sFromReplayBar') &&
      replayBody.includes('hourBarsFromReplayMinutes') &&
      replayBody.includes('desk_confirm') &&
      replayBody.includes('closed_10s: closed10sFromReplayBar') &&
      replayBody.includes('hour_bars: hourBarsFromReplayMinutes') &&
      existsSync(join(root, 'src/master/__tests__/replayDeskConfirm.test.ts'));
    const systemAuditBody = readFileSync(
      join(root, 'src/master/scripts/systemAudit.ts'),
      'utf8'
    );
    const systemAuditDeskConfirm =
      systemAuditBody.includes('resolveDeskEntryConfirm') &&
      systemAuditBody.includes('closed10sFromReplayBar') &&
      systemAuditBody.includes('hour_bars: hourBars') &&
      systemAuditBody.includes('closed_10s: closed10s') &&
      systemAuditBody.includes('desk_entry_confirm') &&
      systemAuditBody.includes('desk_hour_bias') &&
      systemAuditBody.includes('desk_closed_10s_gate') &&
      systemAuditBody.includes('desk_confirm_helper');
    const honestyOk =
      stagesUi &&
      stagesApi &&
      manageOwnerMasterUi &&
      manageOwnerDeskUi &&
      manageOwnerApi &&
      journalAuditApi &&
      journalAuditUi &&
      journalAuditEmbed &&
      filterCardsHydrateUi &&
      closedPnlUi &&
      closedPnlEmbed &&
      kpiHydrateUi &&
      kpiHydrateEmbed &&
      decisionCardsHydrateUi &&
      decisionCardsHydrateEmbed &&
      regimeHydrateApi &&
      quoteBarsCacheUi &&
      quoteBarsCacheEmbed &&
      quoteBarsCacheApi &&
      hourBarsCacheUi &&
      hourBarsCacheEmbed &&
      hourBarsCacheApi &&
      closed10sCacheUi &&
      closed10sCacheEmbed &&
      closed10sCacheApi &&
      marketCachePgHealApi &&
      epicCycleStashPgHealApi &&
      runtimeGatesPgHealApi &&
      manageConfigPgHealApi &&
      ownsPipelinePgHealApi &&
      monitoringSnapshotPgHealApi &&
      spreadHistoryPgHealApi &&
      tradeAckJournalPgHealApi &&
      errorJournalPgHealApi &&
      newsWindowPgHealApi &&
      clientFanoutPgHealApi &&
      newsCalendarPgHealApi &&
      operatorMetaSidecarParityApi &&
      tickStickyDeskArmsApi &&
      entryGatesHydrateUi &&
      entryGatesEmbed &&
      entryGatesHydrateApi &&
      whyMonitorHydrateUi &&
      whyMonitorHydrateEmbed &&
      whyMonitorHydrateApi &&
      floatUplCacheUi &&
      floatUplCacheEmbed &&
      floatUplCacheApi &&
      riskSeedApi &&
      exitHydrateUi &&
      exitHydrateEmbed &&
      normDiskHydrateUi &&
      normDiskHydrateEmbed &&
      livePaperRetry &&
      paperEquityReseedApi &&
      dualPersistNewerMirrorApi &&
      filePersistSingletonSeedApi &&
      barsOpenTimeStopApi &&
      paperSlTpAutofillApi &&
      paperManageFillPnlApi &&
      paperTickManageBeforeSyncApi &&
      softExitRMultipleApi &&
      manageOnlyEquityRefreshApi &&
      postClosePeakEquityApi &&
      manualCloseVenueEquityApi &&
      syncGhostVenueEquityApi &&
      syncGhostPostExitApi &&
      manageOnlyDailyPnlRollApi &&
      manageOnlyFingerprintClearApi &&
      manageOnlyMtmEquityApi &&
      manageOnlyAccountFieldsApi &&
      closePathAccountSnapshotApi &&
      paperQuoteEpicStrictApi &&
      bootstrapManageOnQuoteApi &&
      feedMissManageOnQuoteApi &&
      livePaperDeskConfirm &&
      setupArmedApi &&
      setupArmedUi &&
      setupArmedEmbed &&
      liveExpectancyDefaultApi &&
      liveExpectancyDefaultUi &&
      liveExpectancyDefaultEmbed &&
      masterOwnsFanoutApi &&
      masterOwnsFanoutUi &&
      masterOwnsFanoutEmbed &&
      deskEntryApi &&
      liveFeedClosed10s &&
      liveFeedHourBars &&
      deskEntryDash &&
      deskEntryJournal &&
      deskEntryPgHydrate &&
      deskEntryPerfJoin &&
      deskSourceExpectancyDash &&
      confirmDeskHydrateWarn &&
      tradeDeskRestartHydrate &&
      deskEntryOpenHydrate &&
      deskEntryStatusHydrate &&
      openPosConfirmDash &&
      closedTradeConfirmDash &&
      tradeEventDeskConfirm &&
      deskConfirmCardHydrate &&
      marketCoreFailClosed &&
      deskBridgeMeta &&
      deskFeedDivergent &&
      multiEpicCycleApi &&
      multiEpicCycleUi &&
      multiEpicCycleEmbed &&
      multiEpicManageApi &&
      multiEpicManageUi &&
      multiEpicManageEmbed &&
      epicCycleStashPersist &&
      epicScopedSetupKey &&
      deskSourceSetupKey &&
      replayDeskConfirm &&
      systemAuditDeskConfirm;
    checks.push({
      id: 'artifacts_present',
      requirement:
        'Dashboard routes, brokers, recovery, desk bridge, manage_owner + journal_audit + hydrate filter/decision cards + Closed PnL + Quote/Bars disk_cache + Hour bars disk_cache + Closed 10s disk_cache + market_cache DualPersist PG heal + epic_cycle_stash DualPersist PG heal + runtime_gates DualPersist PG heal + manage_config DualPersist PG heal + owns_pipeline DualPersist PG heal + monitoring_snapshot DualPersist PG heal + spread_history DualPersist PG heal + trade_ack_journal DualPersist PG heal + error_journal DualPersist PG heal + news_window DualPersist PG heal + client_fanout DualPersist PG heal + news_calendar DualPersist PG heal + Peak/Equity/News/Close-fail/Expectancy/Fees/Win rate/Loss streak KPI hydrate honesty + operator_meta sidecar parity (monitoring/spread/news/fanout/trade_ack/error_journal) + tick sticky desk arms fallback + Entry gates + Why/monitor hydrate + Float UPL cache + risk seed + Stage·exit hydrate + Norm/validate disk_cache + live-paper retry harden + flat paper equity reseed + DualPersist prefer newer mirror + FilePersist singleton cold-seed + live-paper desk closed_10s/hour_bars setup|move CLOSED + desk SETUP ARMED decide gate + LIVE positive expectancy default + MASTER owns Client fanout + desk 1h/10s entry confirm + live-feed sticky justClosed→closed_10s + live-feed hour_bars hour_bias + desk_entry/hour_bias/closed_10s dashboard + decision journal desk_entry provenance + DualPersist PG desk_entry hydrate + Confirm PnL desk_entry perf join + Confirm EV desk-source expectancy + open desk_entry hydrate/backfill + desk_entry status hydrate + open-pos confirm dash + closed-trade confirm dash + TradeEvent durable desk_entry_source + Confirm PnL/EV hydrate warn + TradeEvent desk restart DualPersist heal + desk confirm card hydrate warn + Market Core EntryReady fail-closed + multi-epic cycle stash + epic-scoped setupKey + desk-source setupKey EV + epic cycle stash restart hydrate + multi-epic manage quote safety + desk feed_divergent + replay closed_10s/hour_bars desk confirm + systemAudit desk closed_10s/hour_bars resolveDeskEntryConfirm',
      ok: missing.length === 0 && honestyOk,
      detail: missing.length
        ? `missing: ${missing.join(',')}`
        : `${files.length} core files; pipeline_stages api=${stagesApi} ui=${stagesUi}; manage_owner api=${manageOwnerApi} masterUi=${manageOwnerMasterUi} deskUi=${manageOwnerDeskUi} deskBridge=${deskBridgeMeta}; desk_feed_divergent=${deskFeedDivergent}; journal_audit api=${journalAuditApi} ui=${journalAuditUi} embed=${journalAuditEmbed}; filter_hydrate_ui=${filterCardsHydrateUi}; closed_pnl ui=${closedPnlUi} embed=${closedPnlEmbed}; kpi_hydrate ui=${kpiHydrateUi} embed=${kpiHydrateEmbed}; decision_hydrate ui=${decisionCardsHydrateUi} embed=${decisionCardsHydrateEmbed} api=${regimeHydrateApi}; quote_bars_cache ui=${quoteBarsCacheUi} embed=${quoteBarsCacheEmbed} api=${quoteBarsCacheApi}; hour_bars_cache ui=${hourBarsCacheUi} embed=${hourBarsCacheEmbed} api=${hourBarsCacheApi}; closed_10s_cache ui=${closed10sCacheUi} embed=${closed10sCacheEmbed} api=${closed10sCacheApi}; market_cache_pg_heal=${marketCachePgHealApi}; epic_stash_pg_heal=${epicCycleStashPgHealApi}; runtime_gates_pg_heal=${runtimeGatesPgHealApi}; manage_config_pg_heal=${manageConfigPgHealApi}; owns_pipeline_pg_heal=${ownsPipelinePgHealApi}; monitoring_snapshot_pg_heal=${monitoringSnapshotPgHealApi}; spread_history_pg_heal=${spreadHistoryPgHealApi}; trade_ack_journal_pg_heal=${tradeAckJournalPgHealApi}; error_journal_pg_heal=${errorJournalPgHealApi}; news_window_pg_heal=${newsWindowPgHealApi}; client_fanout_pg_heal=${clientFanoutPgHealApi}; news_calendar_pg_heal=${newsCalendarPgHealApi}; operator_meta_sidecar_parity=${operatorMetaSidecarParityApi}; tick_sticky_desk_arms=${tickStickyDeskArmsApi}; entry_gates ui=${entryGatesHydrateUi} embed=${entryGatesEmbed} api=${entryGatesHydrateApi}; why_monitor ui=${whyMonitorHydrateUi} embed=${whyMonitorHydrateEmbed} api=${whyMonitorHydrateApi}; float_upl ui=${floatUplCacheUi} embed=${floatUplCacheEmbed} api=${floatUplCacheApi}; risk_seed=${riskSeedApi}; exit_hydrate ui=${exitHydrateUi} embed=${exitHydrateEmbed}; norm_disk ui=${normDiskHydrateUi} embed=${normDiskHydrateEmbed}; live_paper_retry=${livePaperRetry}; live_paper_desk_confirm=${livePaperDeskConfirm}; paper_equity_reseed=${paperEquityReseedApi}; dualpersist_newer_mirror=${dualPersistNewerMirrorApi}; filepersist_singleton_seed=${filePersistSingletonSeedApi}; bars_open_time_stop=${barsOpenTimeStopApi}; paper_sl_tp_autofill=${paperSlTpAutofillApi}; paper_manage_fill_pnl=${paperManageFillPnlApi}; paper_tick_manage_before_sync=${paperTickManageBeforeSyncApi}; soft_exit_r_multiple=${softExitRMultipleApi}; manage_only_equity_refresh=${manageOnlyEquityRefreshApi}; post_close_peak_equity=${postClosePeakEquityApi}; manual_close_venue_equity=${manualCloseVenueEquityApi}; sync_ghost_venue_equity=${syncGhostVenueEquityApi}; sync_ghost_post_exit=${syncGhostPostExitApi}; manage_only_daily_pnl_roll=${manageOnlyDailyPnlRollApi}; manage_only_fingerprint_clear=${manageOnlyFingerprintClearApi}; manage_only_mtm_equity=${manageOnlyMtmEquityApi}; manage_only_account_fields=${manageOnlyAccountFieldsApi}; close_path_account_snapshot=${closePathAccountSnapshotApi}; paper_quote_epic_strict=${paperQuoteEpicStrictApi}; bootstrap_manage_on_quote=${bootstrapManageOnQuoteApi}; feed_miss_manage_on_quote=${feedMissManageOnQuoteApi}; setup_armed api=${setupArmedApi} ui=${setupArmedUi} embed=${setupArmedEmbed}; live_exp_default api=${liveExpectancyDefaultApi} ui=${liveExpectancyDefaultUi} embed=${liveExpectancyDefaultEmbed}; master_owns_fanout api=${masterOwnsFanoutApi} ui=${masterOwnsFanoutUi} embed=${masterOwnsFanoutEmbed}; desk_entry=${deskEntryApi}; live_feed_closed_10s=${liveFeedClosed10s}; live_feed_hour_bars=${liveFeedHourBars}; desk_entry_dash=${deskEntryDash}; desk_entry_journal=${deskEntryJournal}; desk_entry_pg=${deskEntryPgHydrate}; desk_entry_perf=${deskEntryPerfJoin}; desk_source_expectancy=${deskSourceExpectancyDash}; confirm_desk_hydrate=${confirmDeskHydrateWarn}; trade_desk_restart=${tradeDeskRestartHydrate}; desk_entry_open_hydrate=${deskEntryOpenHydrate}; desk_entry_status_hydrate=${deskEntryStatusHydrate}; open_pos_confirm=${openPosConfirmDash}; closed_trade_confirm=${closedTradeConfirmDash}; trade_event_desk_confirm=${tradeEventDeskConfirm}; desk_confirm_card_hydrate=${deskConfirmCardHydrate}; market_core_failclosed=${marketCoreFailClosed}; multi_epic_cycle api=${multiEpicCycleApi} ui=${multiEpicCycleUi} embed=${multiEpicCycleEmbed}; multi_epic_manage api=${multiEpicManageApi} ui=${multiEpicManageUi} embed=${multiEpicManageEmbed}; epic_stash=${epicCycleStashPersist}; epic_setup_key=${epicScopedSetupKey}; desk_source_setup_key=${deskSourceSetupKey}; replay_desk_confirm=${replayDeskConfirm}; system_audit_desk_confirm=${systemAuditDeskConfirm}`,
    });
  }

  // Primary LIVE venue = Capital.com. MT4 bridge demo is legacy optional (excluded from core).
  const requiredForComplete = checks.filter(
    (c) => c.id !== 'live_capital_network' && c.id !== 'legacy_mt4_bridge_optional'
  );
  const allCore = requiredForComplete.every((c) => c.ok);
  const capitalLive = checks.find((c) => c.id === 'live_capital_network')?.ok === true;
  const mt4Legacy = checks.find((c) => c.id === 'legacy_mt4_bridge_optional')?.ok === true;

  const report = {
    ts: new Date().toISOString(),
    primary_live_venue: 'capital.com_api_direct',
    status:
      allCore && capitalLive
        ? 'COMPLETE'
        : allCore
          ? 'CAPITAL_NETWORK_PENDING'
          : 'INCOMPLETE',
    checks,
    summary: {
      core_ok: allCore,
      legacy_mt4_optional_ok: mt4Legacy,
      capital_live_network_ok: capitalLive,
      note: capitalLive
        ? 'Capital.com network connectivity proven (quote+equity+open-list). Live mutate covered by mocked livePath — not a live-mutate network proof'
        : allCore
          ? 'Paper + live-data + mocked Capital verified; primary LIVE is Capital.com — set CAPITAL_* env or Brokers-page Capital credentials (not MT4 bridge)'
          : 'One or more core requirements failed',
    },
  };

  writeFileSync(join(artifactDir, 'vs_master_verify.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'INCOMPLETE') process.exitCode = 1;
  // COMPLETE* statuses exit 0 — Capital pending is explicit in status when applicable
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
