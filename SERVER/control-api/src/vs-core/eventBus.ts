/**
 * Structured VS CORE event bus — components communicate via typed events, not ad-hoc wiring.
 */

import { randomUUID } from 'crypto';

export type VsEventType =
  | 'MarketTickReceived'
  | 'MarketStateUpdated'
  | 'SetupDetected'
  | 'DecisionCreated'
  | 'RiskAccepted'
  | 'RiskRejected'
  | 'OrderSubmitted'
  | 'BrokerAccepted'
  | 'OrderFilled'
  | 'PositionOpened'
  | 'PositionClosed'
  | 'ComponentFailed'
  | 'IncidentRaised'
  | 'IncidentResolved'
  | 'ClientAuthenticated'
  | 'ClientTradingStarted'
  | 'ClientTradingStopped'
  | 'ReconcileCompleted'
  | 'ReconcileMismatch'
  | 'SystemReady'
  | 'SystemDegraded'
  | 'SystemNotReady';

export type VsEvent = {
  id: string;
  type: VsEventType;
  timestamp: string;
  source: string;
  correlation_id: string;
  client_id?: number | null;
  account_id?: number | null;
  payload: Record<string, unknown>;
};

export type VsEventHandler = (event: VsEvent) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<VsEventType | '*', Set<VsEventHandler>>();
  private history: VsEvent[] = [];
  private readonly maxHistory: number;

  constructor(maxHistory = 2000) {
    this.maxHistory = maxHistory;
  }

  on(type: VsEventType | '*', handler: VsEventHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  async emit(
    type: VsEventType,
    input: {
      source: string;
      payload?: Record<string, unknown>;
      correlation_id?: string;
      client_id?: number | null;
      account_id?: number | null;
    }
  ): Promise<VsEvent> {
    const event: VsEvent = {
      id: randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      source: input.source,
      correlation_id: input.correlation_id || randomUUID(),
      client_id: input.client_id ?? null,
      account_id: input.account_id ?? null,
      payload: input.payload || {},
    };
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
    const specific = this.handlers.get(type);
    const all = this.handlers.get('*');
    const list = [...(specific || []), ...(all || [])];
    for (const h of list) {
      await h(event);
    }
    return event;
  }

  recent(limit = 50): VsEvent[] {
    return this.history.slice(-limit);
  }

  clear(): void {
    this.history = [];
  }
}

let sharedBus: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!sharedBus) sharedBus = new EventBus();
  return sharedBus;
}

export function resetEventBusForTests(): void {
  sharedBus = new EventBus();
}
