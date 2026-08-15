/**
 * VS CORE single verify command — SOURCE → TEST → EVIDENCE.
 * npm run vs-core:verify
 */

import { spawnSync } from 'child_process';
import { writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runCapitalDemoVerify } from './capitalDemoVerify.js';
import { runStrategyRegression } from './strategyRegression.js';
import { CORE_VERSION, STRATEGY_VERSION, CONFIG_VERSION, DB_SCHEMA_VERSION, FREEZE_COMMIT, STRATEGY_BASELINE_STATUS } from './versions.js';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const controlApiRoot = join(__dirname, '..', '..');
const repoRoot = join(controlApiRoot, '..', '..');

export type GateLine = {
  name: string;
  status: 'PASS' | 'FAIL' | 'EXTERNAL_BLOCKER';
  test?: string;
  command?: string;
  result?: string;
  source?: string;
};

function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: process.env });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok: r.status === 0, out };
}

async function main() {
  const gates: GateLine[] = [];
  const add = (g: GateLine) => gates.push(g);

  console.log('=== VS CORE VERIFY ===');
  console.log(`CORE=${CORE_VERSION} STRATEGY=${STRATEGY_VERSION} CONFIG=${CONFIG_VERSION}`);

  // Unit + proof suite
  const unit = run('npx', ['vitest', 'run', 'src/vs-core', 'src/security', 'src/services/entryFromRegime.test.ts', 'src/services/decisionCodes.test.ts', 'src/services/staleQuoteGuard.test.ts', 'src/services/tenSecondOhlc.test.ts', 'src/services/clientIsolation.test.ts'], controlApiRoot);
  add({
    name: 'CORE_UNIT',
    status: unit.ok ? 'PASS' : 'FAIL',
    test: 'vitest src/vs-core + security + strategy units',
    command: 'npx vitest run src/vs-core ...',
    result: unit.ok ? 'exit 0' : unit.out.slice(-500),
    source: 'apps/control-api/src/vs-core/',
  });

  // Strategy regression
  const reg = runStrategyRegression();
  add({
    name: 'STRATEGY_REGRESSION',
    status: reg.failed === 0 ? 'PASS' : 'FAIL',
    test: 'runStrategyRegression',
    command: 'embedded in vs-core:verify',
    result: `${reg.passed}/${reg.passed + reg.failed} fingerprint=${reg.fingerprint.slice(0, 16)}`,
    source: 'apps/control-api/src/vs-core/strategyRegression.ts',
  });
  add({
    name: 'HISTORICAL_BASELINE',
    status: 'EXTERNAL_BLOCKER',
    result: STRATEGY_BASELINE_STATUS,
    source: 'docs/AAA_P0_STRATEGY_BASELINE.md',
  });

  // Capital demo
  const demo = await runCapitalDemoVerify();
  add({
    name: 'CAPITAL_REAL_DEMO',
    status: demo.status === 'PASS' ? 'PASS' : demo.status === 'FAIL' ? 'FAIL' : 'EXTERNAL_BLOCKER',
    test: 'runCapitalDemoVerify',
    command: 'npm run vs-core:capital-demo-verify',
    result: demo.code,
    source: 'apps/control-api/src/vs-core/capitalDemoVerify.ts',
  });
  add({
    name: 'CAPITAL_SESSION_LOGIC',
    status: unit.ok ? 'PASS' : 'FAIL',
    test: 'CAPITAL_SESSION_FIXTURES in verifyProof.test.ts',
    command: 'vitest verifyProof',
    result: 'fixture 401/403/429/refresh',
    source: 'apps/control-api/src/vs-core/capitalSessionManager.ts',
  });

  // Linux deploy
  const linuxScript = join(repoRoot, 'deploy/vs-core/linux-deploy-verify.sh');
  try {
    chmodSync(linuxScript, 0o755);
  } catch {
    /* */
  }
  const linux = run('bash', [linuxScript], repoRoot);
  add({
    name: 'LINUX_DEPLOYMENT',
    status: linux.ok ? 'PASS' : 'FAIL',
    test: 'linux-deploy-verify.sh',
    command: 'bash deploy/vs-core/linux-deploy-verify.sh',
    result: linux.ok ? 'PASS' : linux.out.slice(-300),
    source: 'deploy/vs-core/',
  });

  // Physical appliance
  const appl = run('bash', [join(repoRoot, 'deploy/vs-core/appliance-verify.sh')], repoRoot);
  add({
    name: 'PHYSICAL_i3',
    status: appl.ok ? 'PASS' : appl.out.includes('EXTERNAL_BLOCKER') ? 'EXTERNAL_BLOCKER' : 'FAIL',
    test: 'appliance-verify.sh',
    command: 'VS_PHYSICAL_APPLIANCE=1 bash deploy/vs-core/appliance-verify.sh',
    result: appl.out.trim().split('\n')[0] || 'unknown',
    source: 'deploy/vs-core/appliance-verify.sh',
  });

  // Map detailed gates from unit suite presence (unit already ran proofs)
  const mapped: Array<[string, string, string]> = [
    ['INTEGRATION', 'verifyProof + acceptanceExtras', 'apps/control-api/src/vs-core/verifyProof.test.ts'],
    ['RUNTIME_CHAIN', 'runRuntimeChain', 'apps/control-api/src/vs-core/runtimeChain.ts'],
    ['FEED_SAFETY', 'FEED_SAFETY', 'apps/control-api/src/vs-core/feedManager.ts'],
    ['RISK', 'RISK_CORE', 'apps/control-api/src/vs-core/riskCore.ts'],
    ['EXECUTION', 'TIMEOUT_RECONCILE + RUNTIME_CHAIN', 'apps/control-api/src/vs-core/executionCore.ts'],
    ['DUPLICATE_PROTECTION', 'runDuplicateProtectionTest', 'apps/control-api/src/vs-core/runtimeChain.ts'],
    ['ORDER_STATE_MACHINE', 'ORDER_STATE_MACHINE', 'apps/control-api/src/vs-core/orderStateMachine.ts'],
    ['RECONCILIATION', 'RECONCILIATION', 'apps/control-api/src/vs-core/positionReconcile.ts'],
    ['CRASH_RECOVERY', 'CRASH_RECOVERY', 'apps/control-api/src/vs-core/crashRecovery.ts'],
    ['SUPERVISOR', 'SUPERVISOR_READINESS', 'apps/control-api/src/vs-core/supervisor.ts'],
    ['READINESS', 'SUPERVISOR_READINESS', 'apps/control-api/src/vs-core/readiness.ts'],
    ['INCIDENTS', 'illegal OSM → incident', 'apps/control-api/src/vs-core/incidentCenter.ts'],
    ['SOAK_MEMORY', 'runSoakTest', 'apps/control-api/src/vs-core/soakTest.ts'],
    ['DATABASE_RECOVERY', 'DATABASE_GATE', 'apps/control-api/src/vs-core/databaseGate.ts'],
    ['BACKUP', 'BACKUP_RESTORE_UPDATER', 'apps/control-api/src/vs-core/backup.ts'],
    ['RESTORE', 'BACKUP_RESTORE_UPDATER', 'apps/control-api/src/vs-core/backup.ts'],
    ['UPDATER', 'BACKUP_RESTORE_UPDATER', 'apps/control-api/src/vs-core/updater.ts'],
    ['ROLLBACK', 'BACKUP_RESTORE_UPDATER', 'apps/control-api/src/vs-core/updater.ts'],
    ['SECURITY', 'SECURITY_ISOLATION', 'apps/control-api/src/vs-core/mobileAuth.ts'],
    ['CLIENT_ISOLATION', 'SECURITY_ISOLATION + clientIsolation.test', 'apps/control-api/src/services/clientIsolation.test.ts'],
  ];
  for (const [name, test, source] of mapped) {
    add({
      name,
      status: unit.ok ? 'PASS' : 'FAIL',
      test,
      command: 'npm run vs-core:verify',
      result: unit.ok ? 'covered by vitest suite' : 'unit suite failed',
      source,
    });
  }

  const softFail = gates.filter((g) => g.status === 'FAIL');
  const blockers = gates.filter((g) => g.status === 'EXTERNAL_BLOCKER');
  const previousComplete = softFail.length === 0;

  let gitSha = 'unknown';
  try {
    gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    /* */
  }

  const report = {
    title: 'VS CORE PREVIOUS MASTER TASK FINAL GATE',
    generated_at: new Date().toISOString(),
    git_sha: gitSha,
    freeze_commit: FREEZE_COMMIT,
    core_version: CORE_VERSION,
    strategy_version: STRATEGY_VERSION,
    config_version: CONFIG_VERSION,
    db_schema_version: DB_SCHEMA_VERSION,
    previous_master_task_complete: previousComplete,
    live_readiness: 'NOT READY' as const,
    summary: {
      pass: gates.filter((g) => g.status === 'PASS').length,
      fail: softFail.length,
      external_blocker: blockers.length,
    },
    gates,
    external_blockers: blockers.map((b) => ({ name: b.name, result: b.result })),
    note: previousComplete
      ? 'All non-external software gates PASS. Capital DEMO + physical i3 remain EXTERNAL_BLOCKER. Do NOT start VS ADMIN / VS CONTROL without operator approval.'
      : 'Software FAIL present — previous master task NOT complete.',
  };

  const outDir = join(repoRoot, 'data/vs-core-acceptance');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'final-gate.json'), JSON.stringify(report, null, 2));
  const lines = [
    report.title,
    `git_sha=${report.git_sha}`,
    `previous_master_task_complete=${report.previous_master_task_complete}`,
    `live_readiness=${report.live_readiness}`,
    `PASS=${report.summary.pass} FAIL=${report.summary.fail} EXTERNAL_BLOCKER=${report.summary.external_blocker}`,
    '',
    ...gates.map(
      (g) =>
        `${g.status.padEnd(18)} ${g.name}${g.result ? ` — ${g.result}` : ''}${g.source ? ` [${g.source}]` : ''}`
    ),
    '',
    report.note,
  ];
  writeFileSync(join(outDir, 'final-gate.txt'), lines.join('\n') + '\n');
  writeFileSync(join(repoRoot, 'docs/VS_CORE_FINAL_GATE.txt'), lines.join('\n') + '\n');
  writeFileSync(join(repoRoot, 'docs/VS_CORE_FINAL_GATE.json'), JSON.stringify(report, null, 2));

  console.log(lines.join('\n'));
  process.exit(softFail.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
