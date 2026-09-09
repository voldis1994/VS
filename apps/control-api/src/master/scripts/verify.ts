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

  // 3) Live market data PAPER
  {
    const r = run('npm', ['run', 'master:live-paper'], 90_000);
    const demo = readJson(join(artifactDir, 'vs_master_live_paper_demo.json'));
    let honestClosed = false;
    try {
      const { isHonestLivePaperClosed } = await import('../livePaperHonesty.js');
      honestClosed = !!(demo && isHonestLivePaperClosed(demo));
    } catch {
      honestClosed = false;
    }
    const ok =
      r.ok &&
      typeof demo?.status === 'string' &&
      demo.status === 'PASS_LIVE_DATA_CLOSED' &&
      demo.forced_live_paper_fill !== true &&
      (demo.performance_trades ?? 0) >= 1 &&
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
        ? `${demo.status} mid=${demo.first_mid} feed=${demo.feed} executed=${demo.executed_cycles} exit_phase=${!!demo.exit_phase} exits=${demo.exit_cycles} trades=${demo.performance_trades} forced=${!!demo.forced_live_paper_fill} honest=${honestClosed}`
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
      demo?.journals?.pg_primary_heal_ok === true;
    checks.push({
      id: 'paper_restart_continuity',
      requirement:
        'Paper restart: hydrateBookFromDisk restores opens/journal; DualPersist primary heal; recover reconciles',
      ok,
      detail: demo
        ? `${demo.status} hydrate_pos=${demo.hydrate?.positions} exit=${demo.hydrate?.last_exit_reason} pnl=${demo.hydrate?.daily_pnl} manage_seed=${demo.manage_only?.paper_seeded} recover_pos=${demo.recover?.positions} pg_heal=${demo.journals?.pg_primary_heal_ok === true} persist=${demo.journals?.persist_backend || demo.hydrate?.persist_backend || '?'}`
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
      masterPageBody.includes('Stage·validate');
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
      runtimeBody.includes('dual_candidates:');
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
    const masterRouteBody = readFileSync(join(root, 'src/routes/master.ts'), 'utf8');
    const journalAuditEmbed =
      masterRouteBody.includes('persist_backend') &&
      masterRouteBody.includes('Journal audit');
    const deskBody = readFileSync(join(root, 'src/services/robotDesk.ts'), 'utf8');
    const deskBridgeMeta =
      deskBody.includes('manage_owner:') &&
      deskBody.includes('MASTER BRIDGE') &&
      deskBody.includes('deskSessionStartPolicy');
    const honestyOk =
      stagesUi &&
      stagesApi &&
      manageOwnerMasterUi &&
      manageOwnerDeskUi &&
      manageOwnerApi &&
      journalAuditApi &&
      journalAuditUi &&
      journalAuditEmbed &&
      deskBridgeMeta;
    checks.push({
      id: 'artifacts_present',
      requirement:
        'Dashboard routes, brokers, recovery, desk bridge, manage_owner + journal_audit honesty',
      ok: missing.length === 0 && honestyOk,
      detail: missing.length
        ? `missing: ${missing.join(',')}`
        : `${files.length} core files; pipeline_stages api=${stagesApi} ui=${stagesUi}; manage_owner api=${manageOwnerApi} masterUi=${manageOwnerMasterUi} deskUi=${manageOwnerDeskUi} deskBridge=${deskBridgeMeta}; journal_audit api=${journalAuditApi} ui=${journalAuditUi} embed=${journalAuditEmbed}`,
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
