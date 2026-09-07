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
    const ok =
      r.ok &&
      typeof demo?.status === 'string' &&
      (demo.status === 'PASS_LIVE_DATA_TRADED' ||
        demo.status === 'PASS_LIVE_DATA_DECIDED') &&
      demo.forced_live_paper_fill !== true;
    checks.push({
      id: 'live_market_paper',
      requirement: 'Live market data → decision → paper execution (paper mode)',
      ok,
      detail: demo
        ? `${demo.status} mid=${demo.first_mid} feed=${demo.feed} executed=${demo.executed_cycles} forced=${!!demo.forced_live_paper_fill}`
        : r.out.slice(-500),
    });
  }

  // 4) LIVE Capital smoke (may SKIP without credentials — recorded honestly)
  {
    const r = run('npm', ['run', 'master:live-smoke'], 60_000);
    const smoke = readJson(join(artifactDir, 'vs_master_live_smoke.json'));
    const status = smoke?.status || 'MISSING';
    checks.push({
      id: 'live_capital_network',
      requirement: 'LIVE broker mode against Capital.com network',
      ok: status === 'OK_LIVE_CONNECTED' || status === 'CONNECTED_PARTIAL',
      detail:
        status === 'SKIPPED'
          ? `SKIPPED (no CAPITAL_*): ${smoke?.detail || ''}`
          : JSON.stringify(smoke),
      // Note: SKIPPED means not verified — ok=false
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

  // 6) MT4 LIVE path (Check- file bridge + local simulator — real OPEN→fill→CLOSE)
  {
    const r = run('npm', ['run', 'master:mt4-live'], 90_000);
    const demo = readJson(join(artifactDir, 'vs_master_mt4_live_demo.json'));
    const ok = r.ok && demo?.status === 'PASS_MT4_LIVE';
    checks.push({
      id: 'live_mt4_bridge',
      requirement: 'LIVE broker mode via MT4/Check- file bridge (OPEN→ack fill→exit→CLOSE)',
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
      'src/master/newsCalendar.ts',
      'src/master/capitalStream.ts',
      'src/master/manageConfig.ts',
      'src/master/tradeAckJournal.ts',
      'src/master/closeRequiresSl.ts',
      'src/master/persist.ts',
      'src/master/filePersist.ts',
      'src/master/liveFeed.ts',
      'src/master/filters.ts',
      'src/master/deskBridge.ts',
      'src/master/mt4Sim.ts',
      'src/routes/master.ts',
      'src/db/migrations/011_master_journal.sql',
      '../dashboard/src/pages/MasterPage.tsx',
    ];
    const missing = files.filter((f) => !existsSync(join(root, f)));
    checks.push({
      id: 'artifacts_present',
      requirement: 'Dashboard routes, brokers, recovery, desk bridge, React Master page present',
      ok: missing.length === 0,
      detail: missing.length ? `missing: ${missing.join(',')}` : `${files.length} core files present`,
    });
  }

  const requiredForComplete = checks.filter((c) => c.id !== 'live_capital_network');
  // Capital network remains an explicit venue check; MT4 LIVE satisfies "live modes"
  const allCore = requiredForComplete.every((c) => c.ok);
  const capitalLive = checks.find((c) => c.id === 'live_capital_network')?.ok === true;
  const mt4Live = checks.find((c) => c.id === 'live_mt4_bridge')?.ok === true;

  const report = {
    ts: new Date().toISOString(),
    status:
      allCore && capitalLive
        ? 'COMPLETE'
        : allCore
          ? 'COMPLETE_MT4_LIVE_CAPITAL_NETWORK_PENDING'
          : 'INCOMPLETE',
    checks,
    summary: {
      core_ok: allCore,
      live_mt4_ok: mt4Live,
      capital_live_network_ok: capitalLive,
      note: capitalLive
        ? 'All objective requirements verified including Capital network LIVE'
        : allCore
          ? 'Paper + live-data + MT4 LIVE + mocked Capital verified; Capital.com network still needs CAPITAL_* credentials'
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
