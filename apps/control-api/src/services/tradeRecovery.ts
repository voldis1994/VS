/**
 * Close confirmation + execution / BO restart recovery helpers.
 */

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
  close_phase: ClosePhase;
  pending_deal_reference: string | null;
  epic: string;
  account_id: number;
  robot_id: string;
  updated_at: string;
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

/** After closeCapitalPosition().ok — do NOT mark CLOSED until broker flat. */
export function nextClosePhaseAfterBrokerAck(stillOpenOnBroker: boolean): ClosePhase {
  if (stillOpenOnBroker) return 'CLOSE_UNCERTAIN';
  return 'CLOSED';
}

export function shouldClearTradeState(phase: ClosePhase): boolean {
  return phase === 'CLOSED';
}

export function shouldRetryClose(phase: ClosePhase): boolean {
  return phase === 'CLOSE_UNCERTAIN' || phase === 'RECONCILING' || phase === 'CLOSE_REQUESTED';
}

/** Prefer broker fill over signal mid. */
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
  if (opts.signal_mid != null && Number.isFinite(opts.signal_mid)) {
    return opts.signal_mid;
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
  close_phase?: ClosePhase;
  pending_deal_reference?: string | null;
  epic: string;
  account_id: number;
  robot_id: string;
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
    close_phase: input.close_phase ?? 'OPEN',
    pending_deal_reference: input.pending_deal_reference ?? null,
    epic: input.epic,
    account_id: input.account_id,
    robot_id: input.robot_id,
    updated_at: new Date().toISOString(),
  };
}

/** Merge broker open position into BO state after restart. */
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
    close_phase: 'OPEN',
    pending_deal_reference: null,
    epic: opts.epic,
    account_id: opts.account_id,
    robot_id: opts.robot_id,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Crash after claim / order accepted but DB incomplete:
 * if broker has open on epic → adopt, do not re-order.
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
    return {
      action: 'ADOPT',
      detail: `recover · broker open ${opts.brokerOpen.direction} ${opts.brokerOpen.deal_id} · skip duplicate`,
    };
  }
  if (opts.pending.deal_reference) {
    return { action: 'WAIT', detail: 'pending dealRef · reconcile confirm' };
  }
  return { action: 'CLEAR_PENDING', detail: 'pending claim without broker open · clear' };
}

// ——— in-memory persist (survives within process; DB migration optional later) ———

const boByRobot = new Map<string, PersistedBoState>();
const pendingByRobot = new Map<string, PendingExecution>();
const riskSnapByAccount = new Map<
  number,
  { json: string; updated_at: string }
>();

export function saveBoState(state: PersistedBoState): void {
  boByRobot.set(state.robot_id, { ...state, updated_at: new Date().toISOString() });
}

export function loadBoState(robotId: string): PersistedBoState | null {
  return boByRobot.get(robotId) ?? null;
}

export function clearBoState(robotId: string): void {
  boByRobot.delete(robotId);
}

export function savePendingExecution(p: PendingExecution): void {
  pendingByRobot.set(p.robot_id, p);
}

export function loadPendingExecution(robotId: string): PendingExecution | null {
  return pendingByRobot.get(robotId) ?? null;
}

export function clearPendingExecution(robotId: string): void {
  pendingByRobot.delete(robotId);
}

export function persistRiskSnapshotJson(accountId: number, snapshot: unknown): void {
  riskSnapByAccount.set(accountId, {
    json: JSON.stringify(snapshot),
    updated_at: new Date().toISOString(),
  });
}

export function loadRiskSnapshotJson(accountId: number): unknown | null {
  const row = riskSnapByAccount.get(accountId);
  if (!row) return null;
  try {
    return JSON.parse(row.json);
  } catch {
    return null;
  }
}

export function resetTradeRecoveryStore(): void {
  boByRobot.clear();
  pendingByRobot.clear();
  riskSnapByAccount.clear();
}
