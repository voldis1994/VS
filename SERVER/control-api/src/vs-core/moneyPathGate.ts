/**
 * Money-path readiness gate — entries blocked until boot recovery PASS.
 * Manage/exit remain available for safety; NEW opens require entries_allowed.
 */

export type MoneyPathGateState = {
  service_running: boolean;
  money_path_ready: boolean;
  entries_allowed: boolean;
  recovery_ok: boolean;
  reason_code: string | null;
  detail: string | null;
  recovered_at: string | null;
};

let state: MoneyPathGateState = {
  service_running: false,
  money_path_ready: false,
  entries_allowed: false,
  recovery_ok: false,
  reason_code: 'BOOT_PENDING',
  detail: 'money path not recovered yet',
  recovered_at: null,
};

export function getMoneyPathGate(): MoneyPathGateState {
  return { ...state };
}

export function markServiceRunning(): void {
  state = { ...state, service_running: true };
}

/** Fail-closed default — used at module load and in tests. */
export function resetMoneyPathGateForTests(partial?: Partial<MoneyPathGateState>): void {
  state = {
    service_running: false,
    money_path_ready: false,
    entries_allowed: false,
    recovery_ok: false,
    reason_code: 'BOOT_PENDING',
    detail: 'money path not recovered yet',
    recovered_at: null,
    ...partial,
  };
}

export function setMoneyPathRecoveryResult(input: {
  ok: boolean;
  entries_allowed: boolean;
  reason_code: string | null;
  detail?: string | null;
}): void {
  state = {
    ...state,
    service_running: true,
    money_path_ready: input.ok,
    entries_allowed: input.ok && input.entries_allowed,
    recovery_ok: input.ok,
    reason_code: input.reason_code,
    detail: input.detail ?? null,
    recovered_at: new Date().toISOString(),
  };
}

export type EntryGateResult =
  | { allowed: true }
  | { allowed: false; code: string; reason: string };

/** Block NEW broker opens until recovery PASS. */
export function assertEntriesAllowed(): EntryGateResult {
  if (!state.entries_allowed || !state.money_path_ready) {
    return {
      allowed: false,
      code: 'MONEY_PATH_NOT_READY',
      reason:
        state.detail ||
        state.reason_code ||
        'Entries blocked until crash recovery PASS',
    };
  }
  return { allowed: true };
}

/**
 * Alternate openers (pipeline fanout / admin direct order) are permanently
 * fail-closed on the production money path. Sole opener: robotDesk → executeTradeIntent.
 */
export function assertAuthoritativeOpener(source: string): {
  allowed: false;
  code: 'ALTERNATE_OPENER_DISABLED';
  reason: string;
} {
  return {
    allowed: false,
    code: 'ALTERNATE_OPENER_DISABLED',
    reason: `Production money path refuses opener '${source}' — use robotDesk durable executeTradeIntent only`,
  };
}
