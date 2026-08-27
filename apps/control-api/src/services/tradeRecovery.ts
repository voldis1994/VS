/**
 * Close confirmation + execution / BO restart recovery helpers.
 * Persistent file store survives process crash (#27).
 */

import {
  deleteJson,
  loadJson,
  persistJson,
  resetPersistNamespace,
} from './persistentStore.js';

export type ClosePhase =
  | 'OPEN'
  | 'CLOSE_REQUESTED'
  | 'BROKER_CLOSE_SENT'
  | 'RECONCILING'
  | 'CLOSED'
  | 'CLOSE_UNCERTAIN';

export type PersistedBoState = {
  deal_id: string | null;
  side: 'BUY' | 'SELL';
  entry_price: number;
  entry_at: string;
  mfe: number;
  mae: number;
  peak_favorable: number;
  peak_retention: number | null;
  structural_sl: number | null;
  safety_sl: number | null;
  /** Favorable distance to structure/liquidity target — survive restart */
  structure_target: number | null;
  close_phase: ClosePhase;
  pending_deal_reference: string | null;
  epic: string;
  account_id: number;
  robot_id: string;
  updated_at: string;
  /** True only when entry_price is broker/confirm fill */
  fill_confirmed?: boolean;
};

export type PendingExecution = {
  robot_id: string;
  account_id: number;
  epic: string;
  side: 'BUY' | 'SELL';
  deal_reference: string | null;
  claimed_at: string;
  signal_mid: number | null;
};

export function nextClosePhaseAfterBrokerAck(stillOpenOnBroker: boolean): ClosePhase {
  if (stillOpenOnBroker) return 'CLOSE_UNCERTAIN';
  return 'CLOSED';
}

/** List failure → stay RECONCILING (#56). */
export function nextClosePhaseAfterListFailure(current: ClosePhase): ClosePhase {
  if (current === 'CLOSE_REQUESTED' || current === 'BROKER_CLOSE_SENT' || current === 'CLOSE_UNCERTAIN') {
    return 'RECONCILING';
  }
  return 'RECONCILING';
}

export function shouldClearTradeState(phase: ClosePhase): boolean {
  return phase === 'CLOSED';
}

export function shouldRetryClose(phase: ClosePhase): boolean {
  return phase === 'CLOSE_UNCERTAIN' || phase === 'RECONCILING' || phase === 'CLOSE_REQUESTED';
}

/**
 * Broker / confirm fill only. Signal mid is NEVER execution truth.
 */
export function resolveEntryPrice(opts: {
  broker_open_level?: number | null;
  confirm_level?: number | null;
  signal_mid?: number | null;
}): number | null {
  if (opts.broker_open_level != null && Number.isFinite(opts.broker_open_level)) {
    return opts.broker_open_level;
  }
  if (opts.confirm_level != null && Number.isFinite(opts.confirm_level)) {
    return opts.confirm_level;
  }
  return null;
}

export function buildBoStateFromOpen(input: {
  deal_id: string | null;
  side: 'BUY' | 'SELL';
  entry_price: number;
  entry_at?: string | null;
  mfe?: number;
  mae?: number;
  peak_favorable?: number;
  peak_retention?: number | null;
  structural_sl?: number | null;
  safety_sl?: number | null;
  structure_target?: number | null;
  close_phase?: ClosePhase;
  pending_deal_reference?: string | null;
  epic: string;
  account_id: number;
  robot_id: string;
  fill_confirmed?: boolean;
}): PersistedBoState {
  return {
    deal_id: input.deal_id,
    side: input.side,
    entry_price: input.entry_price,
    entry_at: input.entry_at || new Date().toISOString(),
    mfe: input.mfe ?? 0,
    mae: input.mae ?? 0,
    peak_favorable: input.peak_favorable ?? input.entry_price,
    peak_retention: input.peak_retention ?? null,
    structural_sl: input.structural_sl ?? null,
    safety_sl: input.safety_sl ?? null,
    structure_target:
      input.structure_target != null && Number.isFinite(input.structure_target)
        ? input.structure_target
        : null,
    close_phase: input.close_phase ?? 'OPEN',
    pending_deal_reference: input.pending_deal_reference ?? null,
    epic: input.epic,
    account_id: input.account_id,
    robot_id: input.robot_id,
    updated_at: new Date().toISOString(),
    fill_confirmed: input.fill_confirmed ?? false,
  };
}

export function adoptBrokerOpenForBo(opts: {
  prior: PersistedBoState | null;
  deal_id: string;
  side: 'BUY' | 'SELL';
  open_level: number | null;
  stop_level?: number | null;
  epic: string;
  account_id: number;
  robot_id: string;
}): PersistedBoState {
  const entry =
    opts.open_level != null && Number.isFinite(opts.open_level)
      ? opts.open_level
      : opts.prior?.entry_price;
  if (entry == null || !Number.isFinite(entry)) {
    throw new Error('cannot adopt BO without entry price');
  }
  const fillConfirmed = opts.open_level != null && Number.isFinite(opts.open_level);
  return {
    deal_id: opts.deal_id,
    side: opts.side,
    entry_price: entry,
    entry_at: opts.prior?.entry_at || new Date().toISOString(),
    mfe: opts.prior?.mfe ?? 0,
    mae: opts.prior?.mae ?? 0,
    peak_favorable: opts.prior?.peak_favorable ?? entry,
    peak_retention: opts.prior?.peak_retention ?? null,
    structural_sl: opts.prior?.structural_sl ?? null,
    safety_sl: opts.stop_level ?? opts.prior?.safety_sl ?? null,
    structure_target: opts.prior?.structure_target ?? null,
    close_phase: 'OPEN',
    pending_deal_reference: null,
    epic: opts.epic,
    account_id: opts.account_id,
    robot_id: opts.robot_id,
    updated_at: new Date().toISOString(),
    fill_confirmed: fillConfirmed,
  };
}

/**
 * Crash recovery: clear pending only when broker open + fill known (#26).
 */
export function recoverPendingExecution(opts: {
  pending: PendingExecution | null;
  brokerOpen: { deal_id: string; direction: 'BUY' | 'SELL'; open_level: number | null } | null;
}): {
  action: 'ADOPT' | 'CLEAR_PENDING' | 'WAIT' | 'NONE';
  detail: string;
} {
  if (!opts.pending) return { action: 'NONE', detail: 'no pending' };
  if (opts.brokerOpen) {
    if (opts.brokerOpen.open_level == null || !Number.isFinite(opts.brokerOpen.open_level)) {
      return {
        action: 'WAIT',
        detail: 'broker open without fill/open_level · keep pending',
      };
    }
    return {
      action: 'ADOPT',
      detail: `recover · broker open ${opts.brokerOpen.direction} ${opts.brokerOpen.deal_id} · fill ${opts.brokerOpen.open_level}`,
    };
  }
  if (opts.pending.deal_reference) {
    return { action: 'WAIT', detail: 'pending dealRef · reconcile confirm' };
  }
  return { action: 'WAIT', detail: 'pending claim · waiting broker position · keep pending' };
}

/** Clear pending only when broker position + fill confirmed (#26). */
export function canClearPendingExecution(opts: {
  brokerOpen: boolean;
  fillLevel: number | null | undefined;
}): boolean {
  return opts.brokerOpen && opts.fillLevel != null && Number.isFinite(opts.fillLevel);
}

// ——— persistent + in-memory cache ———

const boByRobot = new Map<string, PersistedBoState>();
const pendingByRobot = new Map<string, PendingExecution>();
const riskSnapByAccount = new Map<number, { json: string; updated_at: string }>();

export function saveBoState(state: PersistedBoState): void {
  const next = { ...state, updated_at: new Date().toISOString() };
  boByRobot.set(state.robot_id, next);
  persistJson('bo', state.robot_id, next);
}

export function loadBoState(robotId: string): PersistedBoState | null {
  const mem = boByRobot.get(robotId);
  if (mem) return mem;
  const disk = loadJson<PersistedBoState>('bo', robotId);
  if (disk) boByRobot.set(robotId, disk);
  return disk;
}

export function clearBoState(robotId: string): void {
  boByRobot.delete(robotId);
  deleteJson('bo', robotId);
}

export function savePendingExecution(p: PendingExecution): void {
  pendingByRobot.set(p.robot_id, p);
  persistJson('pending', p.robot_id, p);
}

export function loadPendingExecution(robotId: string): PendingExecution | null {
  const mem = pendingByRobot.get(robotId);
  if (mem) return mem;
  const disk = loadJson<PendingExecution>('pending', robotId);
  if (disk) pendingByRobot.set(robotId, disk);
  return disk;
}

export function clearPendingExecution(robotId: string): void {
  pendingByRobot.delete(robotId);
  deleteJson('pending', robotId);
}

export function persistRiskSnapshotJson(accountId: number, snapshot: unknown): void {
  const row = { json: JSON.stringify(snapshot), updated_at: new Date().toISOString() };
  riskSnapByAccount.set(accountId, row);
  persistJson('risk-snap', String(accountId), row);
}

export function loadRiskSnapshotJson(accountId: number): unknown | null {
  const mem = riskSnapByAccount.get(accountId);
  if (mem) {
    try {
      return JSON.parse(mem.json);
    } catch {
      /* fall through */
    }
  }
  const disk = loadJson<{ json: string }>('risk-snap', String(accountId));
  if (!disk?.json) return null;
  try {
    return JSON.parse(disk.json);
  } catch {
    return null;
  }
}

export function resetTradeRecoveryStore(): void {
  boByRobot.clear();
  pendingByRobot.clear();
  riskSnapByAccount.clear();
  resetPersistNamespace('bo');
  resetPersistNamespace('pending');
  resetPersistNamespace('risk-snap');
  resetPersistNamespace('risk-state');
}
