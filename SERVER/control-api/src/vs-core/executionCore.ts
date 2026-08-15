/**
 * Execution Core — Risk-approved intents only.
 * HTTP OK ≠ FILLED. Confirm before POSITION_OPEN. Timeout → BROKER_RESULT_UNRESOLVED (no blind retry).
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
import type { DurableOrderStore } from './durableOrderStore.js';

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
  setup_id?: string;
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

export type BrokerConfirmResult = {
  ok: boolean;
  status: 'ACCEPTED' | 'REJECTED' | 'PENDING' | 'UNKNOWN';
  deal_id?: string | null;
  deal_reference?: string | null;
  detail: string;
};

export type ExecutionDeps = {
  submit: (intent: TradeIntent, clientOrderId: string) => Promise<BrokerSubmitResult>;
  reconcile: (intent: TradeIntent, clientOrderId: string) => Promise<BrokerReconcileResult>;
  /** Required for money path — HTTP accept is not a fill. */
  confirm?: (intent: TradeIntent, clientOrderId: string, dealReference: string | null) => Promise<BrokerConfirmResult>;
  orderStore: OrderStore | DurableOrderStore;
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

function asDurable(store: OrderStore | DurableOrderStore): DurableOrderStore | null {
  return 'beginSubmission' in store ? (store as DurableOrderStore) : null;
}

/**
 * Full chain: Intent → Risk → SUBMITTING → broker → confirm → FILLED → POSITION_OPEN.
 * Timeout: BROKER_RESULT_UNRESOLVED → reconcile → never blind resubmit.
 */
export async function executeTradeIntent(
  intent: TradeIntent,
  riskCtx: RiskContext,
  deps: ExecutionDeps
): Promise<ExecutionResult> {
  const durable = asDurable(deps.orderStore);
  const clientOrderId = `vs_${intent.intent_id}`;
  const setupId = intent.setup_id || intent.decision_id;

  if (durable?.hasUnresolvedSubmission(intent.account_id, intent.epic)) {
    return {
      ok: false,
      code: 'RISK_REJECTED_DUPLICATE_INTENT',
      reason: 'Unresolved prior submission on epic — reconcile before new order',
    };
  }

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

  durable?.beginSubmission({
    client_order_id: clientOrderId,
    intent_id: intent.intent_id,
    setup_id: setupId,
    client_id: intent.client_id,
    account_id: intent.account_id,
    epic: intent.epic,
    direction: intent.direction,
    size: intent.size,
    state: 'SUBMITTING',
    deal_reference: null,
    deal_id: null,
  });

  const submitted = await deps.submit(intent, clientOrderId);

  if (submitted.timed_out) {
    order = transitionOrder(
      order,
      'BROKER_RESULT_UNRESOLVED',
      'Submit timeout — broker result unresolved'
    );
    deps.orderStore.put(order);
    durable?.updateLedger(clientOrderId, { state: 'BROKER_RESULT_UNRESOLVED' });

    const recon = await deps.reconcile(intent, clientOrderId);
    if (recon.found) {
      order = transitionOrder(order, 'BROKER_ACCEPTED', recon.detail);
      order = {
        ...order,
        broker_deal_reference: recon.deal_reference || null,
        broker_deal_id: recon.deal_id || null,
      };
      durable?.updateLedger(clientOrderId, {
        state: 'BROKER_ACCEPTED',
        deal_reference: recon.deal_reference || null,
        deal_id: recon.deal_id || null,
      });
      // Still require confirm evidence when available
      if (deps.confirm) {
        const conf = await deps.confirm(
          intent,
          clientOrderId,
          recon.deal_reference || null
        );
        if (conf.status === 'REJECTED') {
          order = transitionOrder(order, 'REJECTED', conf.detail);
          order = { ...order, reject_reason: conf.detail };
          deps.orderStore.put(order);
          durable?.updateLedger(clientOrderId, { state: 'REJECTED' });
          return { ok: false, order, code: 'BROKER_REJECTED', reason: conf.detail };
        }
        if (conf.status === 'ACCEPTED' || conf.deal_id) {
          order = {
            ...order,
            broker_deal_id: conf.deal_id || order.broker_deal_id,
          };
          order = transitionOrder(order, 'FILLED', conf.detail);
          order = transitionOrder(order, 'POSITION_OPEN');
          deps.orderStore.put(order);
          durable?.updateLedger(clientOrderId, {
            state: 'POSITION_OPEN',
            deal_id: order.broker_deal_id,
          });
          return { ok: true, order, code: 'POSITION_OPEN' };
        }
      }
      // Reconcile found open position = broker evidence of fill
      order = transitionOrder(order, 'FILLED', 'Reconciled open position — no blind retry');
      order = transitionOrder(order, 'POSITION_OPEN');
      deps.orderStore.put(order);
      durable?.updateLedger(clientOrderId, {
        state: 'POSITION_OPEN',
        deal_id: recon.deal_id || null,
      });
      return { ok: true, order, code: 'POSITION_OPEN' };
    }
    order = transitionOrder(
      order,
      'REJECTED',
      `BROKER_RESULT_UNRESOLVED + not found at broker: ${recon.detail}`
    );
    order = { ...order, reject_reason: recon.detail };
    deps.orderStore.put(order);
    durable?.updateLedger(clientOrderId, { state: 'REJECTED' });
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
    durable?.updateLedger(clientOrderId, { state: 'REJECTED' });
    return { ok: false, order, code: 'BROKER_REJECTED', reason: submitted.detail };
  }

  order = transitionOrder(order, 'BROKER_ACCEPTED', submitted.detail);
  order = {
    ...order,
    broker_deal_reference: submitted.deal_reference || null,
    broker_deal_id: submitted.deal_id || null,
  };
  deps.orderStore.put(order);
  durable?.updateLedger(clientOrderId, {
    state: 'BROKER_ACCEPTED',
    deal_reference: submitted.deal_reference || null,
    deal_id: submitted.deal_id || null,
  });

  // HTTP OK is NOT a fill — confirm required when confirm fn provided
  if (deps.confirm) {
    const conf = await deps.confirm(
      intent,
      clientOrderId,
      submitted.deal_reference || null
    );
    if (conf.status === 'REJECTED') {
      order = transitionOrder(order, 'REJECTED', conf.detail);
      order = { ...order, reject_reason: conf.detail };
      deps.orderStore.put(order);
      durable?.updateLedger(clientOrderId, { state: 'REJECTED' });
      return { ok: false, order, code: 'BROKER_REJECTED', reason: conf.detail };
    }
    if (conf.status === 'PENDING' || conf.status === 'UNKNOWN') {
      // Stay BROKER_ACCEPTED — not POSITION_OPEN
      return { ok: true, order, code: 'BROKER_ACCEPTED' };
    }
    order = {
      ...order,
      broker_deal_id: conf.deal_id || order.broker_deal_id,
      broker_deal_reference: conf.deal_reference || order.broker_deal_reference,
    };
    order = transitionOrder(order, 'FILLED', conf.detail);
    order = transitionOrder(order, 'POSITION_OPEN');
    deps.orderStore.put(order);
    durable?.updateLedger(clientOrderId, {
      state: 'POSITION_OPEN',
      deal_id: order.broker_deal_id,
    });
    return { ok: true, order, code: 'POSITION_OPEN' };
  }

  // Legacy test path without confirm — still do not skip to POSITION_OPEN from HTTP alone.
  // Require deal_id evidence from submit.
  if (submitted.deal_id) {
    order = transitionOrder(order, 'FILLED', 'deal_id present on submit');
    order = transitionOrder(order, 'POSITION_OPEN');
    deps.orderStore.put(order);
    durable?.updateLedger(clientOrderId, {
      state: 'POSITION_OPEN',
      deal_id: submitted.deal_id,
    });
    return { ok: true, order, code: 'POSITION_OPEN' };
  }

  return { ok: true, order, code: 'BROKER_ACCEPTED' };
}

export function newIntentId(): string {
  return randomUUID();
}

export function newDecisionId(): string {
  return randomUUID();
}
