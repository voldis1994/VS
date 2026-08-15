/**
 * Execution Core — accepts only Risk-approved TradeIntents.
 * On network timeout: RECONCILE WITH BROKER — never blind retry.
 */

import { randomUUID } from 'crypto';
import {
  createOrderRecord,
  transitionOrder,
  type OrderRecord,
  type OrderStore,
} from './orderStateMachine.js';
import { evaluateRisk, type RiskContext, type RiskDecision } from './riskCore.js';
import { CONFIG_VERSION, STRATEGY_VERSION } from './versions.js';

export type TradeIntent = {
  intent_id: string;
  decision_id: string;
  client_id: number;
  account_id: number;
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  stop_distance?: number | null;
  stop_level?: number | null;
  market_snapshot_id?: string | null;
  strategy_version?: string;
  config_version?: string;
};

export type BrokerSubmitResult = {
  ok: boolean;
  timed_out?: boolean;
  deal_reference?: string | null;
  deal_id?: string | null;
  detail: string;
  status?: number;
};

export type BrokerReconcileResult = {
  found: boolean;
  deal_reference?: string | null;
  deal_id?: string | null;
  direction?: 'BUY' | 'SELL' | null;
  detail: string;
};

export type ExecutionDeps = {
  submit: (intent: TradeIntent, clientOrderId: string) => Promise<BrokerSubmitResult>;
  reconcile: (intent: TradeIntent, clientOrderId: string) => Promise<BrokerReconcileResult>;
  orderStore: OrderStore;
};

export type ExecutionResult =
  | {
      ok: true;
      order: OrderRecord;
      code: 'FILLED' | 'BROKER_ACCEPTED' | 'POSITION_OPEN';
    }
  | {
      ok: false;
      order?: OrderRecord;
      code: string;
      reason: string;
      risk?: RiskDecision;
    };

/**
 * Full chain: Decision → TradeIntent → Risk → Execution → Broker → confirm.
 * Timeout path: reconcile first; only then decide next action.
 */
export async function executeTradeIntent(
  intent: TradeIntent,
  riskCtx: RiskContext,
  deps: ExecutionDeps
): Promise<ExecutionResult> {
  const clientOrderId = `vs_${intent.intent_id}`;
  let order = createOrderRecord({
    intent_id: intent.intent_id,
    client_order_id: clientOrderId,
    client_id: intent.client_id,
    account_id: intent.account_id,
    epic: intent.epic,
    direction: intent.direction,
    size: intent.size,
    strategy_version: intent.strategy_version || STRATEGY_VERSION,
    config_version: intent.config_version || CONFIG_VERSION,
    market_snapshot_id: intent.market_snapshot_id,
    decision_id: intent.decision_id,
  });
  deps.orderStore.put(order);

  const risk = evaluateRisk(riskCtx);
  if (!risk.ok) {
    order = transitionOrder(order, 'REJECTED', risk.reason);
    order = { ...order, reject_reason: risk.reason };
    deps.orderStore.put(order);
    return { ok: false, order, code: risk.code, reason: risk.reason, risk };
  }

  order = transitionOrder(order, 'RISK_ACCEPTED');
  order = transitionOrder(order, 'ORDER_CREATED');
  order = transitionOrder(order, 'SUBMITTING');
  deps.orderStore.put(order);

  const submitted = await deps.submit(intent, clientOrderId);

  if (submitted.timed_out) {
    // Ambiguous broker result — NOT Strategy UNKNOWN. Stop duplicate submit; reconcile.
    order = transitionOrder(
      order,
      'BROKER_RESULT_UNRESOLVED',
      'Submit timeout — broker result unresolved'
    );
    deps.orderStore.put(order);

    const recon = await deps.reconcile(intent, clientOrderId);
    if (recon.found) {
      order = transitionOrder(order, 'BROKER_ACCEPTED', recon.detail);
      order = {
        ...order,
        broker_deal_reference: recon.deal_reference || null,
        broker_deal_id: recon.deal_id || null,
      };
      order = transitionOrder(order, 'FILLED', 'Reconciled after unresolved — no blind retry');
      order = transitionOrder(order, 'POSITION_OPEN');
      deps.orderStore.put(order);
      return { ok: true, order, code: 'POSITION_OPEN' };
    }
    order = transitionOrder(
      order,
      'REJECTED',
      `BROKER_RESULT_UNRESOLVED + not found at broker: ${recon.detail}`
    );
    order = { ...order, reject_reason: recon.detail };
    deps.orderStore.put(order);
    return {
      ok: false,
      order,
      code: 'BROKER_RESULT_UNRESOLVED',
      reason: `Submit timeout — reconciled, order not at broker (${recon.detail})`,
    };
  }

  if (!submitted.ok) {
    order = transitionOrder(order, 'REJECTED', submitted.detail);
    order = { ...order, reject_reason: submitted.detail };
    deps.orderStore.put(order);
    return { ok: false, order, code: 'BROKER_REJECTED', reason: submitted.detail };
  }

  order = transitionOrder(order, 'BROKER_ACCEPTED', submitted.detail);
  order = {
    ...order,
    broker_deal_reference: submitted.deal_reference || null,
    broker_deal_id: submitted.deal_id || null,
  };
  order = transitionOrder(order, 'FILLED');
  order = transitionOrder(order, 'POSITION_OPEN');
  deps.orderStore.put(order);
  return { ok: true, order, code: 'POSITION_OPEN' };
}

export function newIntentId(): string {
  return randomUUID();
}

export function newDecisionId(): string {
  return randomUUID();
}
