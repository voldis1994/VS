/**
 * P6 — System Health matrix for desktop + API.
 * Subsystems: MARKET DATA, CAPITAL SESSION, STRATEGY, RISK, EXECUTION,
 * POSITIONS, STORAGE, UPDATER — OK | WARNING | ERROR | CRITICAL
 */
import { healthCheck } from '../db/pool.js';
import { runtimeBuildInfo } from './runtimeBuild.js';
import { listRobotSessions } from './robotDesk.js';
import {
  getCapitalSessionHealth,
  recordCapitalSessionError,
  type CapitalSessionHealthLevel,
} from './capitalSessionManager.js';
import { DecisionCodes } from './decisionCodes.js';
import { listManagedOrders } from './orderLifecycle.js';

export type HealthLevel = 'OK' | 'WARNING' | 'ERROR' | 'CRITICAL';

export type HealthSubsystem = {
  id: string;
  name: string;
  level: HealthLevel;
  code: string;
  detail: string;
  broken_at: string | null;
  error_code: string | null;
  broker_error: string | null;
  retry_count: number;
  last_success_at: string | null;
};

export type SystemHealthReport = {
  overall: HealthLevel;
  checked_at: string;
  build: ReturnType<typeof runtimeBuildInfo>;
  subsystems: HealthSubsystem[];
};

/** Safe diagnostic inject for P6 reality checks (no broker side-effects). */
export function injectSafeDiagnosticFault(connectionId: number, reason: string): void {
  recordCapitalSessionError(
    connectionId,
    `[DIAGNOSTIC_INJECT] ${reason || 'safe test fault'}`,
    undefined
  );
}

function worst(a: HealthLevel, b: HealthLevel): HealthLevel {
  const rank: Record<HealthLevel, number> = { OK: 0, WARNING: 1, ERROR: 2, CRITICAL: 3 };
  return rank[a] >= rank[b] ? a : b;
}

function mapCapitalLevel(l: CapitalSessionHealthLevel): HealthLevel {
  return l;
}

export async function buildSystemHealth(opts?: {
  primaryConnectionId?: number | null;
}): Promise<SystemHealthReport> {
  const checked_at = new Date().toISOString();
  const build = runtimeBuildInfo();
  const subsystems: HealthSubsystem[] = [];

  // STORAGE
  let dbOk = false;
  try {
    dbOk = await healthCheck();
  } catch {
    dbOk = false;
  }
  subsystems.push({
    id: 'STORAGE',
    name: 'STORAGE',
    level: dbOk ? 'OK' : 'CRITICAL',
    code: dbOk ? 'OK' : 'ERROR_STORAGE',
    detail: dbOk ? 'Postgres healthy' : 'Postgres healthCheck failed',
    broken_at: dbOk ? null : checked_at,
    error_code: dbOk ? null : 'PG_DOWN',
    broker_error: null,
    retry_count: 0,
    last_success_at: dbOk ? checked_at : null,
  });

  // STRATEGY + EXECUTION + RISK + POSITIONS from robot sessions
  const sessions = listRobotSessions();
  const running = sessions.filter((s) => s.running);
  const withError = running.filter((s) => s.error);
  const lastTick = running
    .flatMap((s) => s.ticks.slice(-1))
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];

  let strategyLevel: HealthLevel = running.length === 0 ? 'WARNING' : 'OK';
  let strategyDetail =
    running.length === 0 ? 'No robot session running' : `${running.length} robot(s) running`;
  let strategyCode = running.length === 0 ? 'IDLE' : 'OK';
  if (withError.length) {
    strategyLevel = 'ERROR';
    strategyCode = DecisionCodes.ERROR_STATE_UNRESOLVED;
    strategyDetail = withError[0]!.error || 'Robot error';
  } else if (lastTick?.code === DecisionCodes.ERROR_STATE_UNRESOLVED) {
    strategyLevel = 'ERROR';
    strategyCode = DecisionCodes.ERROR_STATE_UNRESOLVED;
    strategyDetail = lastTick.detail;
  }

  subsystems.push({
    id: 'STRATEGY',
    name: 'STRATEGY',
    level: strategyLevel,
    code: strategyCode,
    detail: strategyDetail,
    broken_at: strategyLevel === 'ERROR' ? checked_at : null,
    error_code: strategyLevel === 'ERROR' ? strategyCode : null,
    broker_error: null,
    retry_count: 0,
    last_success_at: lastTick?.phase !== 'ERROR' ? lastTick?.at || null : null,
  });

  // MARKET DATA
  const quoteAges = running
    .map((s) => (s.last_quote_at ? Date.now() - Date.parse(s.last_quote_at) : null))
    .filter((x): x is number => x != null);
  const oldest = quoteAges.length ? Math.max(...quoteAges) : null;
  let marketLevel: HealthLevel = 'WARNING';
  let marketDetail = 'No live quotes yet';
  let marketCode = 'NO_QUOTE';
  if (oldest != null) {
    if (oldest > 30_000) {
      marketLevel = 'ERROR';
      marketCode = DecisionCodes.STALE_PRICE;
      marketDetail = `Oldest quote age ${Math.round(oldest / 1000)}s`;
    } else if (oldest > 15_000) {
      marketLevel = 'WARNING';
      marketCode = DecisionCodes.STALE_PRICE;
      marketDetail = `Quote age ${Math.round(oldest / 1000)}s`;
    } else {
      marketLevel = 'OK';
      marketCode = 'OK';
      marketDetail = `Quote age ${Math.round(oldest / 1000)}s`;
    }
  } else if (running.length === 0) {
    marketLevel = 'WARNING';
    marketDetail = 'No robot — market data idle';
  }
  subsystems.push({
    id: 'MARKET_DATA',
    name: 'MARKET DATA',
    level: marketLevel,
    code: marketCode,
    detail: marketDetail,
    broken_at: marketLevel === 'ERROR' ? checked_at : null,
    error_code: marketLevel === 'ERROR' ? marketCode : null,
    broker_error: null,
    retry_count: 0,
    last_success_at: running[0]?.last_quote_at || null,
  });

  // CAPITAL SESSION
  const connId = opts?.primaryConnectionId ?? null;
  if (connId != null && connId > 0) {
    const h = getCapitalSessionHealth(connId);
    subsystems.push({
      id: 'CAPITAL_SESSION',
      name: 'CAPITAL SESSION',
      level: mapCapitalLevel(h.level),
      code: String(h.code),
      detail: h.detail,
      broken_at: h.level === 'OK' || h.level === 'WARNING' ? null : h.last_error_at,
      error_code: h.level === 'OK' ? null : String(h.code),
      broker_error: h.last_error,
      retry_count: h.retry_count,
      last_success_at: h.last_ok_at,
    });
  } else {
    subsystems.push({
      id: 'CAPITAL_SESSION',
      name: 'CAPITAL SESSION',
      level: running.length ? 'WARNING' : 'WARNING',
      code: 'NO_CONNECTION_ID',
      detail: 'No primary Capital connection id in health context',
      broken_at: null,
      error_code: null,
      broker_error: null,
      retry_count: 0,
      last_success_at: null,
    });
  }

  // RISK
  const riskReject = lastTick?.code === DecisionCodes.RISK_REJECTED;
  subsystems.push({
    id: 'RISK',
    name: 'RISK',
    level: riskReject ? 'WARNING' : 'OK',
    code: riskReject ? String(lastTick?.code) : 'OK',
    detail: riskReject ? lastTick?.detail || 'Risk rejected' : 'Risk gates nominal (SL 0.15% of price / 0.00150)',
    broken_at: null,
    error_code: null,
    broker_error: null,
    retry_count: 0,
    last_success_at: checked_at,
  });

  // EXECUTION
  const recentOrders = listManagedOrders();
  const rejected = recentOrders.filter((o) => o.state === 'BROKER_REJECTED').slice(-1)[0];
  const submitting = recentOrders.filter((o) => o.state === 'ORDER_SUBMITTING');
  let execLevel: HealthLevel = 'OK';
  let execDetail = `${recentOrders.length} tracked orders`;
  let execCode = 'OK';
  if (submitting.length) {
    execLevel = 'WARNING';
    execCode = DecisionCodes.ORDER_SUBMITTING;
    execDetail = `${submitting.length} order(s) submitting — reconcile before duplicate`;
  }
  if (rejected) {
    execLevel = 'ERROR';
    execCode = DecisionCodes.BROKER_REJECTED;
    execDetail = rejected.broker_detail || 'Broker rejected';
  }
  subsystems.push({
    id: 'EXECUTION',
    name: 'EXECUTION',
    level: execLevel,
    code: execCode,
    detail: execDetail,
    broken_at: execLevel === 'ERROR' ? rejected?.updated_at || checked_at : null,
    error_code: rejected?.broker_error_code || (execLevel === 'ERROR' ? execCode : null),
    broker_error: rejected?.broker_detail || null,
    retry_count: 0,
    last_success_at:
      recentOrders.find((o) => o.state === 'POSITION_OPEN' || o.state === 'FILLED')?.updated_at || null,
  });

  // POSITIONS
  const openLocal = running.filter((s) => s.open_side).length;
  subsystems.push({
    id: 'POSITIONS',
    name: 'POSITIONS',
    level: 'OK',
    code: 'OK',
    detail: `${openLocal} open on running robots`,
    broken_at: null,
    error_code: null,
    broker_error: null,
    retry_count: 0,
    last_success_at: checked_at,
  });

  // UPDATER
  const sha = build.git_sha;
  subsystems.push({
    id: 'UPDATER',
    name: 'UPDATER',
    level: sha && sha !== 'unknown' ? 'OK' : 'WARNING',
    code: sha && sha !== 'unknown' ? 'OK' : 'UNKNOWN_BUILD',
    detail: `VERSION=${build.version} GIT=${sha} STRATEGY=${build.strategy_version} BUILT=${build.build_time}`,
    broken_at: null,
    error_code: null,
    broker_error: null,
    retry_count: 0,
    last_success_at: checked_at,
  });

  let overall: HealthLevel = 'OK';
  for (const s of subsystems) overall = worst(overall, s.level);

  return { overall, checked_at, build, subsystems };
}
