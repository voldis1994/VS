/**
 * Crash recovery — after power loss / restart:
 * Capital connect → account → orders → positions → local DB → reconcile → then allow entries.
 */

import { reconcilePositions, type BrokerPosition, type LocalPosition } from './positionReconcile.js';
import type { CapitalSessionManager } from './capitalSessionManager.js';

export type RecoveryStep =
  | 'NETWORK'
  | 'CAPITAL_CONNECT'
  | 'ACCOUNT'
  | 'WORKING_ORDERS'
  | 'POSITIONS'
  | 'RECENT_FILLS'
  | 'LOCAL_DATABASE'
  | 'RECONCILE'
  | 'STRATEGY_RESTORE'
  | 'READY';

export type RecoveryStepResult = {
  step: RecoveryStep;
  ok: boolean;
  detail: string;
};

export type CrashRecoveryReport = {
  ok: boolean;
  entries_allowed: boolean;
  reason_code: string | null;
  steps: RecoveryStepResult[];
  reconcile_clean: boolean;
};

export type CrashRecoveryDeps = {
  networkOk: () => Promise<boolean>;
  sessionManager: CapitalSessionManager;
  client_id: number;
  account_id: number;
  loadLocalPositions: () => Promise<LocalPosition[]>;
  loadBrokerPositions: () => Promise<BrokerPosition[]>;
  loadWorkingOrders: () => Promise<{ ok: boolean; count: number; detail: string }>;
  loadRecentFills: () => Promise<{ ok: boolean; count: number; detail: string }>;
  databaseOk: () => Promise<boolean>;
  restoreStrategy: () => Promise<{ ok: boolean; detail: string }>;
};

export async function runCrashRecovery(deps: CrashRecoveryDeps): Promise<CrashRecoveryReport> {
  const steps: RecoveryStepResult[] = [];

  const push = (step: RecoveryStep, ok: boolean, detail: string) => {
    steps.push({ step, ok, detail });
  };

  if (!(await deps.networkOk())) {
    push('NETWORK', false, 'network offline');
    return {
      ok: false,
      entries_allowed: false,
      reason_code: 'NETWORK_OFFLINE',
      steps,
      reconcile_clean: false,
    };
  }
  push('NETWORK', true, 'ok');

  const session = await deps.sessionManager.connect(deps.client_id, deps.account_id);
  if (session.health !== 'CONNECTED') {
    push('CAPITAL_CONNECT', false, session.last_error || session.health);
    return {
      ok: false,
      entries_allowed: false,
      reason_code: 'CAPITAL_CONNECT_FAILED',
      steps,
      reconcile_clean: false,
    };
  }
  push('CAPITAL_CONNECT', true, 'connected');

  const verified = await deps.sessionManager.verify(deps.client_id, deps.account_id);
  if (verified.health !== 'CONNECTED') {
    push('ACCOUNT', false, verified.last_error || verified.health);
    return {
      ok: false,
      entries_allowed: false,
      reason_code: 'ACCOUNT_UNVERIFIED',
      steps,
      reconcile_clean: false,
    };
  }
  push('ACCOUNT', true, 'account verified');

  const orders = await deps.loadWorkingOrders();
  push('WORKING_ORDERS', orders.ok, `${orders.count} · ${orders.detail}`);
  if (!orders.ok) {
    return {
      ok: false,
      entries_allowed: false,
      reason_code: 'WORKING_ORDERS_FAILED',
      steps,
      reconcile_clean: false,
    };
  }

  let brokerPositions: BrokerPosition[] = [];
  try {
    brokerPositions = await deps.loadBrokerPositions();
    push('POSITIONS', true, `${brokerPositions.length} broker positions`);
  } catch (e) {
    push('POSITIONS', false, e instanceof Error ? e.message : String(e));
    return {
      ok: false,
      entries_allowed: false,
      reason_code: 'POSITIONS_FAILED',
      steps,
      reconcile_clean: false,
    };
  }

  const fills = await deps.loadRecentFills();
  push('RECENT_FILLS', fills.ok, `${fills.count} · ${fills.detail}`);
  if (!fills.ok) {
    return {
      ok: false,
      entries_allowed: false,
      reason_code: 'FILLS_FAILED',
      steps,
      reconcile_clean: false,
    };
  }

  if (!(await deps.databaseOk())) {
    push('LOCAL_DATABASE', false, 'database unavailable');
    return {
      ok: false,
      entries_allowed: false,
      reason_code: 'DATABASE_DOWN',
      steps,
      reconcile_clean: false,
    };
  }
  push('LOCAL_DATABASE', true, 'ok');

  const local = await deps.loadLocalPositions();
  const recon = reconcilePositions(local, brokerPositions, deps.account_id);
  push(
    'RECONCILE',
    recon.clean,
    recon.clean ? 'RECONCILE_OK' : `POSITION_STATE_MISMATCH · ${recon.mismatches.length}`
  );
  if (!recon.clean) {
    return {
      ok: false,
      entries_allowed: false,
      reason_code: 'POSITION_STATE_MISMATCH',
      steps,
      reconcile_clean: false,
    };
  }

  const strat = await deps.restoreStrategy();
  push('STRATEGY_RESTORE', strat.ok, strat.detail);
  if (!strat.ok) {
    return {
      ok: false,
      entries_allowed: false,
      reason_code: 'STRATEGY_RESTORE_FAILED',
      steps,
      reconcile_clean: true,
    };
  }

  push('READY', true, 'entries allowed');
  return {
    ok: true,
    entries_allowed: true,
    reason_code: null,
    steps,
    reconcile_clean: true,
  };
}
