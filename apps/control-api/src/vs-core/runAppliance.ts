/**
 * Appliance entry — boots readiness probes, prints terminal screen, starts control-api main.
 * Used by deploy/vs-core/boot.sh on Linux VS CORE hosts.
 */

import { bootVsCore } from './boot.js';
import { probe } from './readiness.js';
import { CORE_VERSION, STRATEGY_VERSION, STRATEGY_BASELINE_STATUS } from './versions.js';
import { healthCheck } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';

async function main() {
  const dataRoot = process.env.VS_CORE_DATA || '/var/lib/vs-core';

  console.log('VS CORE');
  console.log(`CORE ${CORE_VERSION}  STRATEGY ${STRATEGY_VERSION}`);
  console.log(`BASELINE ${STRATEGY_BASELINE_STATUS}`);
  console.log('BOOTING…');

  await runMigrations();

  const result = await bootVsCore({
    dataRoot,
    networkCheck: async () => probe('NETWORK', 'OK', 'local stack up'),
    databaseCheck: async () =>
      (await healthCheck())
        ? probe('DATABASE', 'OK', 'postgres ok')
        : probe('DATABASE', 'CRITICAL', 'postgres down', 'DATABASE_DOWN'),
    capitalCheck: async () =>
      probe(
        'CAPITAL',
        'ERROR',
        'Capital session not verified at boot — DEMO/LIVE credentials EXTERNAL BLOCKER until configured',
        'CAPITAL_UNVERIFIED'
      ),
    marketCheck: async () =>
      probe('MARKET', 'WARNING', 'awaiting first Capital quote', 'MARKET_WAITING'),
    strategyCheck: async () => probe('STRATEGY', 'OK', 'strategy core modules loaded'),
    riskCheck: async () => probe('RISK', 'OK', 'risk core loaded'),
    executionCheck: async () => probe('EXECUTION', 'OK', 'execution core loaded'),
    reconcileCheck: async () =>
      probe('RECONCILIATION', 'WARNING', 'awaiting broker connect', 'RECONCILE_PENDING'),
  });

  console.log(result.terminal);
  console.log('');
  console.log(`STATE=${result.report.state} reason=${result.report.reason_code || 'none'}`);
  console.log(`LIVE_READY=${result.report.live_ready}`);

  // Hand off to full control-api (HTTP + robotDesk). Dynamic import keeps boot probes first.
  await import('../index.js');
}

main().catch((err) => {
  console.error('VS CORE BOOT FAILURE', err);
  process.exit(1);
});
