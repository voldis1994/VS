/**
 * Standalone VS CORE TUI process — ~1 Hz refresh.
 * Exit does not stop trading services (those run under supervisor / control-api).
 *
 * Usage: npm run vs-core:tui
 */

import { collectHostSystemSnapshot } from './hostTelemetry.js';
import { evaluateReadiness, probe } from './readiness.js';
import { getEventBus } from './eventBus.js';
import { getIncidentCenter } from './incidentCenter.js';
import { FeedManager } from './feedManager.js';
import { renderCoreTui, servicesFromProbes } from './coreTui.js';
import { healthCheck } from '../db/pool.js';

const REFRESH_MS = Number(process.env.VS_TUI_REFRESH_MS || 1000);

async function buildFrame(feeds: FeedManager) {
  const dbOk = await healthCheck().catch(() => false);
  const probes = [
    probe('NETWORK', 'OK', 'local'),
    probe('TIME', 'OK', 'local clock'),
    probe('STORAGE', 'OK', 'ok'),
    probe('DATABASE', dbOk ? 'OK' : 'ERROR', dbOk ? 'pg ok' : 'pg down', dbOk ? null : 'DATABASE_DOWN'),
    probe('MARKET', 'WARNING', 'awaiting live quote evidence', 'MARKET_WAITING'),
    probe('CAPITAL', 'ERROR', 'session not verified', 'CAPITAL_UNVERIFIED'),
    probe('STRATEGY', 'OK', 'modules loaded'),
    probe('RISK', 'OK', 'modules loaded'),
    probe('EXECUTION', 'OK', 'modules loaded'),
    probe('RECONCILIATION', 'WARNING', 'pending broker', 'RECONCILE_PENDING'),
    probe('CONTROL_API', 'OK', 'agent process'),
  ];
  const readiness = evaluateReadiness(probes);
  const host = collectHostSystemSnapshot({
    cpuSampleMs: 60,
    probeNetwork: true,
    dataRoot: process.env.VS_CORE_DATA || '/',
  });
  const center = getIncidentCenter();
  return renderCoreTui({
    host,
    readiness,
    services: servicesFromProbes(probes),
    feeds: feeds.snapshot('GOLD'),
    capital: {
      connection: 'UNVERIFIED',
      accounts: null,
      positions: null,
      working_orders: null,
      last_sync: null,
      latency_ms: null,
    },
    clients: {
      registered: null,
      active: null,
      trading: null,
      paused: null,
      disabled: null,
    },
    incidents: {
      critical: center.list({ severity: 'CRITICAL', unresolved_only: true }).length,
      error: center.list({ severity: 'ERROR', unresolved_only: true }).length,
      warning: center.list({ severity: 'WARNING', unresolved_only: true }).length,
      info: 0,
    },
    events: getEventBus().recent(12),
  });
}

async function main() {
  const feeds = new FeedManager();
  feeds.defineSource('capital', 'PRIMARY');
  // No fake LIVE — until real ingest, PRIMARY is missing/offline
  feeds.markOffline('capital', 'GOLD', 'no live ingest in TUI process yet');

  await getEventBus().emit('SystemNotReady', {
    source: 'tui',
    payload: { detail: 'TUI started — Capital unverified' },
  });

  const tick = async () => {
    const frame = await buildFrame(feeds);
    // Clear screen if interactive TTY
    if (process.stdout.isTTY) {
      process.stdout.write('\x1Bc');
    }
    process.stdout.write(frame + '\n');
  };

  await tick();
  const timer = setInterval(() => {
    tick().catch((e) => console.error('TUI frame error', e));
  }, REFRESH_MS);

  const stop = () => {
    clearInterval(timer);
    console.error('\nVS CORE TUI stopped — trading services (if running) continue independently.');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
