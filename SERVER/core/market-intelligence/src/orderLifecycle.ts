/**
 * Spec order lifecycle state machine (section 16).
 * Separate from legacy vs-core OSM — map at integration boundary.
 */

import type { OrderLifecycleState } from './types.js';

const EDGES: Record<OrderLifecycleState, OrderLifecycleState[]> = {
  SETUP: ['ENTRY_PENDING', 'CANCELLED', 'ERROR'],
  ENTRY_PENDING: ['SUBMITTED', 'REJECTED', 'CANCELLED', 'ERROR'],
  SUBMITTED: ['ACKNOWLEDGED', 'REJECTED', 'CANCELLED', 'ERROR'],
  ACKNOWLEDGED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'ERROR'],
  PARTIALLY_FILLED: ['FILLED', 'CANCELLED', 'ERROR'],
  FILLED: ['PROTECTED', 'EXIT_PENDING', 'ERROR'],
  PROTECTED: ['MANAGING', 'EXIT_PENDING', 'ERROR'],
  MANAGING: ['EXIT_PENDING', 'PROTECTED', 'ERROR'],
  EXIT_PENDING: ['CLOSED', 'ERROR'],
  CLOSED: [],
  REJECTED: [],
  CANCELLED: [],
  ERROR: [],
};

export function canTransitionOrder(
  from: OrderLifecycleState,
  to: OrderLifecycleState
): boolean {
  return (EDGES[from] || []).includes(to);
}

export function transitionOrder(input: {
  from: OrderLifecycleState;
  to: OrderLifecycleState;
  reason: string;
  timestamp?: string;
  broker_response?: unknown;
}):
  | {
      ok: true;
      state: OrderLifecycleState;
      timestamp: string;
      reason: string;
      broker_response: unknown;
    }
  | { ok: false; reason: string } {
  if (!canTransitionOrder(input.from, input.to)) {
    return { ok: false, reason: `INVALID_TRANSITION ${input.from}→${input.to}` };
  }
  return {
    ok: true,
    state: input.to,
    timestamp: input.timestamp || new Date().toISOString(),
    reason: input.reason,
    broker_response: input.broker_response ?? null,
  };
}
