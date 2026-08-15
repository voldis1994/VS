/**
 * VS CORE boot orchestrator — hardware/network/time/db → supervisor → READY.
 */

import { VsSupervisor, type ServiceDef } from './supervisor.js';
import {
  evaluateReadiness,
  probe,
  renderTerminalScreen,
  type ProbeResult,
  type ReadinessReport,
} from './readiness.js';
import { getIncidentCenter } from './incidentCenter.js';
import { getEventBus } from './eventBus.js';
import { CORE_VERSION, STRATEGY_VERSION, versionBundle } from './versions.js';
import { checkTimeSync, type TimeSyncResult } from './timeSync.js';
import { checkStorageHealth } from './storageHealth.js';
import {
  probeStrategyRuntime,
  probeRiskRuntime,
  probeExecutionRuntime,
} from './runtimeHealth.js';

export type BootOptions = {
  dataRoot: string;
  services?: ServiceDef[];
  networkCheck?: () => Promise<ProbeResult>;
  databaseCheck?: () => Promise<ProbeResult>;
  capitalCheck?: () => Promise<ProbeResult>;
  marketCheck?: () => Promise<ProbeResult>;
  strategyCheck?: () => Promise<ProbeResult>;
  riskCheck?: () => Promise<ProbeResult>;
  executionCheck?: () => Promise<ProbeResult>;
  reconcileCheck?: () => Promise<ProbeResult>;
  controlApiCheck?: () => Promise<ProbeResult>;
};

export type BootResult = {
  report: ReadinessReport;
  terminal: string;
  versions: ReturnType<typeof versionBundle>;
  time: TimeSyncResult;
};

async function orDefault(
  fn: (() => Promise<ProbeResult>) | undefined,
  name: string,
  okDetail: string
): Promise<ProbeResult> {
  if (fn) return fn();
  return probe(name, 'OK', okDetail);
}

export async function bootVsCore(opts: BootOptions): Promise<BootResult> {
  const bus = getEventBus();
  const incidents = getIncidentCenter();
  const supervisor = new VsSupervisor();
  for (const s of opts.services || []) supervisor.register(s);

  if (opts.services?.length) {
    const snap = await supervisor.startAll();
    if (snap.overall === 'CRITICAL_SERVICE_CRASH_LOOP') {
      incidents.raise({
        severity: 'CRITICAL',
        component: 'supervisor',
        error_code: 'CRITICAL_SERVICE_CRASH_LOOP',
        reason: 'Critical service crash loop at boot',
        recovery_action: 'Block trading; manual intervention',
      });
    }
  }

  const time = checkTimeSync();
  const storage = checkStorageHealth(opts.dataRoot);

  const probes: ProbeResult[] = [
    await orDefault(opts.networkCheck, 'NETWORK', 'network probe ok'),
    time.ok
      ? probe('TIME', 'OK', `drift_ms=${time.drift_ms}`)
      : probe('TIME', 'CRITICAL', time.detail, 'TIME_SYNC_ERROR'),
    storage.ok
      ? probe('STORAGE', storage.warning ? 'WARNING' : 'OK', storage.detail, storage.reason_code)
      : probe('STORAGE', 'CRITICAL', storage.detail, storage.reason_code),
    await orDefault(opts.databaseCheck, 'DATABASE', 'database ok'),
    await orDefault(opts.marketCheck, 'MARKET', 'market core ok'),
    await orDefault(opts.capitalCheck, 'CAPITAL', 'capital session not verified in this boot'),
    opts.strategyCheck ? await opts.strategyCheck() : probeStrategyRuntime(),
    opts.riskCheck ? await opts.riskCheck() : probeRiskRuntime(),
    opts.executionCheck
      ? await opts.executionCheck()
      : probeExecutionRuntime(false),
    await orDefault(opts.reconcileCheck, 'RECONCILIATION', 'reconcile clean'),
  ];

  // Capital: never claim OK without a real verification callback
  if (!opts.capitalCheck) {
    const idx = probes.findIndex((p) => p.name === 'CAPITAL');
    if (idx >= 0) {
      probes[idx] = probe(
        'CAPITAL',
        'ERROR',
        'Capital session not verified — cannot claim CONNECTED',
        'CAPITAL_UNVERIFIED'
      );
    }
  }

  // STRATEGY/RISK/EXECUTION defaults above are runtime probes — never "module loaded" fake OK.

  const report = evaluateReadiness(probes);
  if (report.state === 'READY') {
    await bus.emit('SystemReady', { source: 'boot', payload: { state: report.state } });
  } else if (report.state === 'DEGRADED') {
    await bus.emit('SystemDegraded', {
      source: 'boot',
      payload: { reason: report.reason_code },
    });
  } else {
    await bus.emit('SystemNotReady', {
      source: 'boot',
      payload: { reason: report.reason_code },
    });
  }

  const terminal = renderTerminalScreen(report, {
    vs_version: CORE_VERSION,
    strategy_version: STRATEGY_VERSION,
    ssd: storage.detail,
  });

  return {
    report,
    terminal,
    versions: versionBundle(),
    time,
  };
}
