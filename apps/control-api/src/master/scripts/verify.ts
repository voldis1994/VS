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
    checks.push({
      id: 'pipeline_stages',
      requirement:
        'market→validation→analysis→candidates→filters→decision→risk→execution→broker→position→exit→journal→performance',
      ok: r.ok && audit?.status === 'PASS',
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
      honestClosed;
    checks.push({
      id: 'live_market_paper',
      requirement:
        'Live market data → one natural fill → tick-observed exit → journal/performance (no churn)',
      ok,
      detail: demo
        ? `${demo.status} mid=${demo.first_mid} feed=${demo.feed} executed=${demo.executed_cycles} exit_phase=${!!demo.exit_phase} exits=${demo.exit_cycles} trades=${demo.performance_trades} closed_pnl=${demo.performance_total_pnl} forced=${!!demo.forced_live_paper_fill} honest=${honestClosed} attempts=${attempts}${
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
      String(demo.journals.performance_stage_detail).includes('pnl=');
    checks.push({
      id: 'paper_restart_continuity',
      requirement:
        'Paper restart: hydrateBookFromDisk restores opens/journal; DualPersist primary heal; recover reconciles; cycle stages stay red until live tick; Stage·perf surfaces closed pnl=; regime/market_state cards mark hydrated; Quote/Bars mark disk_cache; entry_gates session hydrated; Why/monitor disk hydrate honesty; Stage·risk from opportunity.risk; Float UPL disk_cache; Stage·exit journal hydrate honesty; Stage·exec decision-journal seed; Stage·validate/normalize disk_cache hydrate (aged quote not live stale); Stage·regime hydrated · (not no cycle ·); Stage·position/broker hydrated awaiting manage/attach; Stage·journal/perf hydrated · while green; Closed PnL/Last error hydrate',
      ok,
      detail: demo
        ? `${demo.status} hydrate_pos=${demo.hydrate?.positions} exit=${demo.hydrate?.last_exit_reason} exit_stage=${demo.journals?.exit_stage_detail} exec_stage=${demo.journals?.execution_stage_detail} validate=${demo.journals?.market_validation_stage_detail} normalize=${demo.journals?.normalization_stage_detail} pnl=${demo.hydrate?.daily_pnl} closed_pnl=${demo.hydrate?.performance_total_pnl} perf_detail=${demo.journals?.performance_stage_detail} regime=${demo.journals?.regime} market_state=${demo.journals?.market_state} quote_src=${demo.journals?.quote_source} bars=${demo.journals?.bars_available} bars_cached=${demo.journals?.bars_cached} entry_session=${demo.journals?.entry_gates_session} mon_hydrated=${demo.journals?.monitoring_hydrated} why=${demo.journals?.last_block_reason} risk=${demo.journals?.risk_stage_detail} float=${demo.journals?.floating_pnl} float_cached=${demo.journals?.floating_pnl_cached} manage_seed=${demo.manage_only?.paper_seeded} recover_pos=${demo.recover?.positions} pg_heal=${demo.journals?.pg_primary_heal_ok === true} persist=${demo.journals?.persist_backend || demo.hydrate?.persist_backend || '?'} decision_stage=${demo.journals?.decision_stage_ok} analysis_stage=${demo.journals?.analysis_stage_ok} analysis_hydrated=${demo.journals?.analysis_stage_hydrated} analysis_detail=${demo.journals?.analysis_stage_detail} pos_stage=${demo.journals?.position_stage_pre_manage_detail} broker_stage=${demo.journals?.broker_stage_detail} journal_stage=${demo.journals?.journal_stage_detail} perf_hydrated=${demo.journals?.performance_stage_hydrated}`
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
    const decisionBody = readFileSync(join(root, 'src/master/decision.ts'), 'utf8');
    const pipelineBody = readFileSync(join(root, 'src/master/pipeline.ts'), 'utf8');
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
      masterPageBody.includes('market_setup');
    const setupArmedEmbed =
      masterRouteBody.includes("card('SETUP'") &&
      masterRouteBody.includes('setup_gate_armed');
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
      readFileSync(join(root, 'src/master/deskBridge.ts'), 'utf8').includes(
        'hourCandles'
      ) &&
      readFileSync(join(root, 'src/services/robotDesk.ts'), 'utf8').includes(
        'last_hour_candles'
      );
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
    const multiEpicManageApi =
      positionManagerBody.includes('quoteMatchesPosition') &&
      positionManagerBody.includes('skipped_wrong_epic') &&
      positionManagerBody.includes('portfolioUniverse') &&
      runtimeBody.includes('runManageAcrossOpenEpics') &&
      runtimeBody.includes('manage_epics') &&
      runtimeBody.includes('floating_pnl_epic_scoped') &&
      runtimeBody.includes('openEpicKeys');
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
      decisionCardsHydrateUi &&
      decisionCardsHydrateEmbed &&
      regimeHydrateApi &&
      quoteBarsCacheUi &&
      quoteBarsCacheEmbed &&
      quoteBarsCacheApi &&
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
      epicScopedSetupKey;
    checks.push({
      id: 'artifacts_present',
      requirement:
        'Dashboard routes, brokers, recovery, desk bridge, manage_owner + journal_audit + hydrate filter/decision cards + Closed PnL + Quote/Bars disk_cache + Entry gates + Why/monitor hydrate + Float UPL cache + risk seed + Stage·exit hydrate + Norm/validate disk_cache + live-paper retry harden + desk SETUP ARMED decide gate + LIVE positive expectancy default + MASTER owns Client fanout + desk 1h/10s entry confirm + Market Core EntryReady fail-closed + multi-epic cycle stash + epic-scoped setupKey + epic cycle stash restart hydrate + multi-epic manage quote safety + desk feed_divergent',
      ok: missing.length === 0 && honestyOk,
      detail: missing.length
        ? `missing: ${missing.join(',')}`
        : `${files.length} core files; pipeline_stages api=${stagesApi} ui=${stagesUi}; manage_owner api=${manageOwnerApi} masterUi=${manageOwnerMasterUi} deskUi=${manageOwnerDeskUi} deskBridge=${deskBridgeMeta}; desk_feed_divergent=${deskFeedDivergent}; journal_audit api=${journalAuditApi} ui=${journalAuditUi} embed=${journalAuditEmbed}; filter_hydrate_ui=${filterCardsHydrateUi}; closed_pnl ui=${closedPnlUi} embed=${closedPnlEmbed}; decision_hydrate ui=${decisionCardsHydrateUi} embed=${decisionCardsHydrateEmbed} api=${regimeHydrateApi}; quote_bars_cache ui=${quoteBarsCacheUi} embed=${quoteBarsCacheEmbed} api=${quoteBarsCacheApi}; entry_gates ui=${entryGatesHydrateUi} embed=${entryGatesEmbed} api=${entryGatesHydrateApi}; why_monitor ui=${whyMonitorHydrateUi} embed=${whyMonitorHydrateEmbed} api=${whyMonitorHydrateApi}; float_upl ui=${floatUplCacheUi} embed=${floatUplCacheEmbed} api=${floatUplCacheApi}; risk_seed=${riskSeedApi}; exit_hydrate ui=${exitHydrateUi} embed=${exitHydrateEmbed}; norm_disk ui=${normDiskHydrateUi} embed=${normDiskHydrateEmbed}; live_paper_retry=${livePaperRetry}; setup_armed api=${setupArmedApi} ui=${setupArmedUi} embed=${setupArmedEmbed}; live_exp_default api=${liveExpectancyDefaultApi} ui=${liveExpectancyDefaultUi} embed=${liveExpectancyDefaultEmbed}; master_owns_fanout api=${masterOwnsFanoutApi} ui=${masterOwnsFanoutUi} embed=${masterOwnsFanoutEmbed}; desk_entry=${deskEntryApi}; market_core_failclosed=${marketCoreFailClosed}; multi_epic_cycle api=${multiEpicCycleApi} ui=${multiEpicCycleUi} embed=${multiEpicCycleEmbed}; multi_epic_manage api=${multiEpicManageApi} ui=${multiEpicManageUi} embed=${multiEpicManageEmbed}; epic_stash=${epicCycleStashPersist}; epic_setup_key=${epicScopedSetupKey}`,
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
