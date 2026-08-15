/**
 * P4 — Order lifecycle + reconciliation.
 * Every order has client_order_id. Timeout never blind-resubmits —
 * reconcile against Capital.com first.
 */
import { randomUUID } from 'crypto';
import {
  confirmCapitalDeal,
  createCapitalPosition,
  listCapitalOpenPositions,
  type CapitalOpenPosition,
  type CapitalSession,
} from './capitalCom.js';
import { DecisionCodes, type DecisionCode } from './decisionCodes.js';
import { parseCapitalBrokerError } from './capitalSessionManager.js';

export type OrderLifecycleState =
  | 'SIGNAL_CREATED'
  | 'RISK_ACCEPTED'
  | 'ORDER_SUBMITTING'
  | 'BROKER_ACCEPTED'
  | 'BROKER_REJECTED'
  | 'FILLED'
  | 'PARTIAL_FILL'
  | 'POSITION_OPEN'
  | 'POSITION_CLOSED';

export type ManagedOrder = {
  client_order_id: string;
  account_id: number;
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  state: OrderLifecycleState;
  code: DecisionCode;
  created_at: string;
  updated_at: string;
  deal_reference: string | null;
  deal_id: string | null;
  broker_detail: string | null;
  broker_error_code: string | null;
  stop_level?: number;
  stop_distance?: number;
  submit_started_at: string | null;
  submit_timeout_ms: number;
};

const orders = new Map<string, ManagedOrder>();
/** account+epic → last in-flight client_order_id */
const inflightByKey = new Map<string, string>();

function keyOf(accountId: number, epic: string): string {
  return `${accountId}:${epic.trim().toUpperCase()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function setState(order: ManagedOrder, state: OrderLifecycleState, code: DecisionCode, detail?: string) {
  order.state = state;
  order.code = code;
  order.updated_at = nowIso();
  if (detail) order.broker_detail = detail;
}

export function createManagedOrder(input: {
  account_id: number;
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  stop_level?: number;
  stop_distance?: number;
  submit_timeout_ms?: number;
  client_order_id?: string;
}): ManagedOrder {
  const client_order_id = input.client_order_id || `vs-${randomUUID()}`;
  const order: ManagedOrder = {
    client_order_id,
    account_id: input.account_id,
    epic: input.epic.trim(),
    direction: input.direction,
    size: input.size,
    state: 'SIGNAL_CREATED',
    code: DecisionCodes.SIGNAL_CREATED,
    created_at: nowIso(),
    updated_at: nowIso(),
    deal_reference: null,
    deal_id: null,
    broker_detail: null,
    broker_error_code: null,
    stop_level: input.stop_level,
    stop_distance: input.stop_distance,
    submit_started_at: null,
    submit_timeout_ms: input.submit_timeout_ms ?? 12_000,
  };
  orders.set(client_order_id, order);
  return order;
}

export function getManagedOrder(clientOrderId: string): ManagedOrder | undefined {
  return orders.get(clientOrderId);
}

export function listManagedOrders(filter?: {
  account_id?: number;
  epic?: string;
}): ManagedOrder[] {
  const all = [...orders.values()];
  return all.filter((o) => {
    if (filter?.account_id != null && o.account_id !== filter.account_id) return false;
    if (filter?.epic && o.epic.toUpperCase() !== filter.epic.trim().toUpperCase()) return false;
    return true;
  });
}

export function markRiskAccepted(order: ManagedOrder): ManagedOrder {
  setState(order, 'RISK_ACCEPTED', DecisionCodes.RISK_ACCEPTED, 'Risk gates passed');
  return order;
}

export function markRiskRejected(order: ManagedOrder, detail: string): ManagedOrder {
  setState(order, 'BROKER_REJECTED', DecisionCodes.RISK_REJECTED, detail);
  inflightByKey.delete(keyOf(order.account_id, order.epic));
  return order;
}

function matchOpen(
  positions: CapitalOpenPosition[],
  epic: string,
  direction?: 'BUY' | 'SELL'
): CapitalOpenPosition | null {
  const e = epic.trim().toUpperCase();
  for (const p of positions) {
    if (p.epic.trim().toUpperCase() !== e) continue;
    if (direction && p.direction !== direction) continue;
    return p;
  }
  return null;
}

/**
 * Before any new submit: if an in-flight order exists for account+epic,
 * reconcile with broker. Never blind-duplicate.
 */
export async function reconcileBeforeSubmit(
  session: CapitalSession,
  accountId: number,
  epic: string
): Promise<{
  allow_submit: boolean;
  reason: string;
  existing?: ManagedOrder;
  broker_position?: CapitalOpenPosition | null;
}> {
  const k = keyOf(accountId, epic);
  const inflightId = inflightByKey.get(k);
  const listed = await listCapitalOpenPositions(session);
  const brokerPos = listed.ok ? matchOpen(listed.positions, epic) : null;

  if (brokerPos) {
    if (inflightId) {
      const o = orders.get(inflightId);
      if (o) {
        o.deal_id = brokerPos.deal_id;
        setState(o, 'POSITION_OPEN', DecisionCodes.POSITION_OPEN, `Reconciled dealId=${brokerPos.deal_id}`);
      }
      inflightByKey.delete(k);
    }
    return {
      allow_submit: false,
      reason: `Broker already has open ${brokerPos.direction} dealId=${brokerPos.deal_id}`,
      existing: inflightId ? orders.get(inflightId) : undefined,
      broker_position: brokerPos,
    };
  }

  if (inflightId) {
    const o = orders.get(inflightId);
    if (o && (o.state === 'ORDER_SUBMITTING' || o.state === 'BROKER_ACCEPTED')) {
      // Timeout path: check confirms if we have deal_reference
      if (o.deal_reference) {
        const conf = await confirmCapitalDeal(session, o.deal_reference);
        if (conf.ok && conf.deal_id) {
          o.deal_id = conf.deal_id;
          setState(o, 'FILLED', DecisionCodes.FILLED, conf.detail);
          setState(o, 'POSITION_OPEN', DecisionCodes.POSITION_OPEN, conf.detail);
          inflightByKey.delete(k);
          return {
            allow_submit: false,
            reason: `In-flight order filled via confirm dealId=${conf.deal_id}`,
            existing: o,
            broker_position: null,
          };
        }
      }
      const started = o.submit_started_at ? Date.parse(o.submit_started_at) : 0;
      const age = Date.now() - started;
      if (age < o.submit_timeout_ms) {
        return {
          allow_submit: false,
          reason: `ORDER_SUBMITTING in flight (${Math.round(age / 1000)}s) — wait/reconcile, no duplicate`,
          existing: o,
          broker_position: null,
        };
      }
      // Timed out and no broker position — clear inflight so operator can retry intentionally
      setState(
        o,
        'BROKER_REJECTED',
        DecisionCodes.NETWORK_TIMEOUT,
        `Submit timeout ${o.submit_timeout_ms}ms — no broker position found after reconcile`
      );
      inflightByKey.delete(k);
      return {
        allow_submit: true,
        reason: 'Previous submit timed out and broker has no position — new submit allowed',
        existing: o,
        broker_position: null,
      };
    }
  }

  return { allow_submit: true, reason: 'Clear to submit', broker_position: null };
}

export type SubmitOrderResult = {
  ok: boolean;
  order: ManagedOrder;
  duplicate_prevented: boolean;
  detail: string;
};

/**
 * Submit order with anti-dupe + timeout-safe reconcile.
 * On network timeout: reconcile; do NOT auto-resubmit.
 */
export async function submitManagedOrder(
  session: CapitalSession,
  order: ManagedOrder,
  opts?: {
    /** Injected create for tests */
    createFn?: typeof createCapitalPosition;
    /** Simulate hang/timeout without network */
    forceTimeout?: boolean;
  }
): Promise<SubmitOrderResult> {
  markRiskAccepted(order);

  const gate = await reconcileBeforeSubmit(session, order.account_id, order.epic);
  if (!gate.allow_submit) {
    if (gate.broker_position) {
      order.deal_id = gate.broker_position.deal_id;
      setState(order, 'POSITION_OPEN', DecisionCodes.DUPLICATE_PREVENTED, gate.reason);
    } else {
      setState(order, order.state, DecisionCodes.DUPLICATE_PREVENTED, gate.reason);
    }
    return {
      ok: false,
      order,
      duplicate_prevented: true,
      detail: gate.reason,
    };
  }

  const k = keyOf(order.account_id, order.epic);
  inflightByKey.set(k, order.client_order_id);
  order.submit_started_at = nowIso();
  setState(order, 'ORDER_SUBMITTING', DecisionCodes.ORDER_SUBMITTING, 'Submitting to Capital.com');

  if (opts?.forceTimeout) {
    setState(
      order,
      'ORDER_SUBMITTING',
      DecisionCodes.NETWORK_TIMEOUT,
      'Simulated submit timeout — reconcile required before retry'
    );
    return {
      ok: false,
      order,
      duplicate_prevented: false,
      detail: order.broker_detail || 'timeout',
    };
  }

  const createFn = opts?.createFn || createCapitalPosition;
  let result: Awaited<ReturnType<typeof createCapitalPosition>>;
  try {
    const timeoutMs = order.submit_timeout_ms;
    result = await Promise.race([
      createFn(session, {
        epic: order.epic,
        direction: order.direction,
        size: order.size,
        stopLevel: order.stop_level,
        stopDistance: order.stop_distance,
      }),
      new Promise<Awaited<ReturnType<typeof createCapitalPosition>>>((_, reject) =>
        setTimeout(() => reject(new Error(`NETWORK_TIMEOUT after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const parsed = parseCapitalBrokerError({ status: 0, detail: msg });
    setState(order, 'ORDER_SUBMITTING', parsed.code, msg);

    // Reconcile — never blind resubmit
    const listed = await listCapitalOpenPositions(session);
    if (listed.ok) {
      const pos = matchOpen(listed.positions, order.epic, order.direction);
      if (pos) {
        order.deal_id = pos.deal_id;
        setState(order, 'FILLED', DecisionCodes.FILLED, `Recovered after timeout: dealId=${pos.deal_id}`);
        setState(order, 'POSITION_OPEN', DecisionCodes.POSITION_OPEN, `dealId=${pos.deal_id}`);
        inflightByKey.delete(k);
        return { ok: true, order, duplicate_prevented: false, detail: order.broker_detail || '' };
      }
    }
    return {
      ok: false,
      order,
      duplicate_prevented: false,
      detail: `Submit timeout/error — no duplicate sent. ${msg}`,
    };
  }

  if (!result.ok) {
    const parsed = parseCapitalBrokerError({
      status: result.status,
      json: result.json,
      detail: result.detail,
    });
    order.broker_error_code =
      typeof result.json?.errorCode === 'string' ? result.json.errorCode : parsed.broker_code;
    setState(order, 'BROKER_REJECTED', DecisionCodes.BROKER_REJECTED, result.detail);
    inflightByKey.delete(k);
    return { ok: false, order, duplicate_prevented: false, detail: result.detail };
  }

  order.deal_reference = result.deal_reference || null;
  setState(order, 'BROKER_ACCEPTED', DecisionCodes.BROKER_ACCEPTED, result.detail);

  if (result.deal_reference) {
    const conf = await confirmCapitalDeal(session, result.deal_reference);
    if (conf.ok && conf.deal_id) {
      order.deal_id = conf.deal_id;
      setState(order, 'FILLED', DecisionCodes.FILLED, conf.detail);
      setState(order, 'POSITION_OPEN', DecisionCodes.POSITION_OPEN, conf.detail);
      inflightByKey.delete(k);
      return { ok: true, order, duplicate_prevented: false, detail: conf.detail };
    }
  }

  // Accepted but confirm pending — still protect against duplicate
  setState(order, 'BROKER_ACCEPTED', DecisionCodes.BROKER_ACCEPTED, result.detail);
  return { ok: true, order, duplicate_prevented: false, detail: result.detail };
}

export function markPositionClosed(clientOrderId: string, detail: string): ManagedOrder | undefined {
  const o = orders.get(clientOrderId);
  if (!o) return undefined;
  setState(o, 'POSITION_CLOSED', DecisionCodes.POSITION_CLOSED, detail);
  inflightByKey.delete(keyOf(o.account_id, o.epic));
  return o;
}

export function _resetOrderLifecycleForTests(): void {
  orders.clear();
  inflightByKey.clear();
}
