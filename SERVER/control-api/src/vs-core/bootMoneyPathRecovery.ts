/**
 * Boot-time money-path recovery — load durable state, inventory close-pending,
 * gate entries until safe. Prefer SAFE/NO-TRADE over guessing.
 */

import { join } from 'path';
import { getDurableOrderStore } from './durableOrderStore.js';
import {
  getMoneyPathGate,
  setMoneyPathRecoveryResult,
  type MoneyPathGateState,
} from './moneyPathGate.js';

export type BootRecoveryReport = {
  ok: boolean;
  entries_allowed: boolean;
  reason_code: string | null;
  detail: string;
  close_pending_restored: number;
  open_ledger: number;
};

/**
 * Minimal production boot recovery:
 * 1) Load durable order ledger from disk
 * 2) Inventory CLOSE_PENDING / POSITION_OPEN
 * 3) Allow entries only when durable store loaded cleanly
 *
 * Per-position broker reconcile continues in robotDesk (adopt / close_pending verify).
 * Corrupt durable load → FAIL CLOSED (entries blocked).
 */
export function runBootMoneyPathRecovery(dataRoot?: string): BootRecoveryReport {
  const root =
    dataRoot || process.env.VS_CORE_DATA || join(process.cwd(), 'data', 'vs-core');

  try {
    const store = getDurableOrderStore(root);
    if (store.getLoadError()) {
      setMoneyPathRecoveryResult({
        ok: false,
        entries_allowed: false,
        reason_code: 'DURABLE_CORRUPT',
        detail: store.getLoadError(),
      });
      return {
        ok: false,
        entries_allowed: false,
        reason_code: 'DURABLE_CORRUPT',
        detail: store.getLoadError() || 'corrupt',
        close_pending_restored: 0,
        open_ledger: 0,
      };
    }
    const pending = store.listClosePending();
    const open = store.listAll().filter((o) => o.state === 'POSITION_OPEN');
    const unresolved = store.listAll().filter((o) =>
      ['SUBMITTING', 'BROKER_ACCEPTED', 'BROKER_RESULT_UNRESOLVED', 'FILLED'].includes(
        o.state
      )
    );

    const detail = `durable loaded · open=${open.length} close_pending=${pending.length} unresolved=${unresolved.length}`;
    setMoneyPathRecoveryResult({
      ok: true,
      entries_allowed: true,
      reason_code: null,
      detail,
    });
    return {
      ok: true,
      entries_allowed: true,
      reason_code: null,
      detail,
      close_pending_restored: pending.length,
      open_ledger: open.length,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setMoneyPathRecoveryResult({
      ok: false,
      entries_allowed: false,
      reason_code: 'DURABLE_LOAD_FAILED',
      detail: msg,
    });
    return {
      ok: false,
      entries_allowed: false,
      reason_code: 'DURABLE_LOAD_FAILED',
      detail: msg,
      close_pending_restored: 0,
      open_ledger: 0,
    };
  }
}

export function moneyPathStatusPayload(): MoneyPathGateState & {
  status: 'READY' | 'BLOCKED' | 'STARTING';
} {
  const g = getMoneyPathGate();
  return {
    ...g,
    status: !g.service_running
      ? 'STARTING'
      : g.money_path_ready && g.entries_allowed
        ? 'READY'
        : 'BLOCKED',
  };
}
