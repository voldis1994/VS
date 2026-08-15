/**
 * Deterministic order state machine.
 * No order may disappear between statuses without an incident.
 */

export const OrderStates = [
  'SIGNAL_CREATED',
  'RISK_ACCEPTED',
  'ORDER_CREATED',
  'SUBMITTING',
  'BROKER_ACCEPTED',
  'FILLED',
  'PARTIAL_FILL',
  'REJECTED',
  'CANCELLED',
  'POSITION_OPEN',
  'POSITION_CLOSED',
] as const;

export type OrderState = (typeof OrderStates)[number];

const ALLOWED: Record<OrderState, OrderState[]> = {
  SIGNAL_CREATED: ['RISK_ACCEPTED', 'REJECTED', 'CANCELLED'],
  RISK_ACCEPTED: ['ORDER_CREATED', 'REJECTED', 'CANCELLED'],
  ORDER_CREATED: ['SUBMITTING', 'CANCELLED', 'REJECTED'],
  SUBMITTING: ['BROKER_ACCEPTED', 'REJECTED', 'CANCELLED'],
  BROKER_ACCEPTED: ['FILLED', 'PARTIAL_FILL', 'CANCELLED', 'REJECTED'],
  FILLED: ['POSITION_OPEN'],
  PARTIAL_FILL: ['FILLED', 'CANCELLED', 'POSITION_OPEN'],
  REJECTED: [],
  CANCELLED: [],
  POSITION_OPEN: ['POSITION_CLOSED'],
  POSITION_CLOSED: [],
};

export type OrderRecord = {
  intent_id: string;
  client_order_id: string;
  client_id: number;
  account_id: number;
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  state: OrderState;
  strategy_version: string;
  config_version: string;
  market_snapshot_id: string | null;
  decision_id: string;
  broker_deal_reference: string | null;
  broker_deal_id: string | null;
  reject_reason: string | null;
  created_at: string;
  updated_at: string;
  history: Array<{ state: OrderState; at: string; detail?: string }>;
};

export class OrderStateMachineError extends Error {
  constructor(
    message: string,
    public readonly from: OrderState,
    public readonly to: OrderState
  ) {
    super(message);
    this.name = 'OrderStateMachineError';
  }
}

export function canTransition(from: OrderState, to: OrderState): boolean {
  return ALLOWED[from].includes(to);
}

export function transitionOrder(
  order: OrderRecord,
  to: OrderState,
  detail?: string
): OrderRecord {
  if (order.state === to) return order;
  if (!canTransition(order.state, to)) {
    throw new OrderStateMachineError(
      `Illegal order transition ${order.state} → ${to} (intent=${order.intent_id})`,
      order.state,
      to
    );
  }
  const at = new Date().toISOString();
  return {
    ...order,
    state: to,
    updated_at: at,
    history: [...order.history, { state: to, at, detail }],
  };
}

export function createOrderRecord(input: {
  intent_id: string;
  client_order_id: string;
  client_id: number;
  account_id: number;
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  strategy_version: string;
  config_version: string;
  market_snapshot_id?: string | null;
  decision_id: string;
}): OrderRecord {
  const at = new Date().toISOString();
  return {
    intent_id: input.intent_id,
    client_order_id: input.client_order_id,
    client_id: input.client_id,
    account_id: input.account_id,
    epic: input.epic,
    direction: input.direction,
    size: input.size,
    state: 'SIGNAL_CREATED',
    strategy_version: input.strategy_version,
    config_version: input.config_version,
    market_snapshot_id: input.market_snapshot_id ?? null,
    decision_id: input.decision_id,
    broker_deal_reference: null,
    broker_deal_id: null,
    reject_reason: null,
    created_at: at,
    updated_at: at,
    history: [{ state: 'SIGNAL_CREATED', at }],
  };
}

/** In-memory order store for CORE path (durable DB wiring in migration 010). */
export class OrderStore {
  private byIntent = new Map<string, OrderRecord>();
  private byClientOrder = new Map<string, OrderRecord>();

  put(order: OrderRecord): void {
    this.byIntent.set(order.intent_id, order);
    this.byClientOrder.set(order.client_order_id, order);
  }

  getByIntent(intentId: string): OrderRecord | undefined {
    return this.byIntent.get(intentId);
  }

  getByClientOrderId(id: string): OrderRecord | undefined {
    return this.byClientOrder.get(id);
  }

  listForClient(clientId: number): OrderRecord[] {
    return [...this.byIntent.values()].filter((o) => o.client_id === clientId);
  }

  /** Find open-ish orders for epic+account to prevent duplicates. */
  openIntents(accountId: number, epic: string): OrderRecord[] {
    const open: OrderState[] = [
      'SIGNAL_CREATED',
      'RISK_ACCEPTED',
      'ORDER_CREATED',
      'SUBMITTING',
      'BROKER_ACCEPTED',
      'FILLED',
      'PARTIAL_FILL',
      'POSITION_OPEN',
    ];
    return [...this.byIntent.values()].filter(
      (o) =>
        o.account_id === accountId &&
        o.epic === epic &&
        open.includes(o.state)
    );
  }
}
