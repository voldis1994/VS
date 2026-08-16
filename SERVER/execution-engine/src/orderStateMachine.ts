/**
 * Order state machine — HTTP success is never FILLED.
 */

export type OrderState =
  | 'CREATED'
  | 'VALIDATING'
  | 'RISK_APPROVED'
  | 'RISK_REJECTED'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCEL_PENDING'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN'
  | 'RECONCILIATION_REQUIRED';

const ALLOWED: Record<OrderState, OrderState[]> = {
  CREATED: ['VALIDATING', 'CANCELLED'],
  VALIDATING: ['RISK_APPROVED', 'RISK_REJECTED', 'CANCELLED'],
  RISK_APPROVED: ['SUBMITTING', 'CANCELLED'],
  RISK_REJECTED: [],
  SUBMITTING: ['SUBMITTED', 'REJECTED', 'UNKNOWN'],
  SUBMITTED: ['ACKNOWLEDGED', 'REJECTED', 'CANCEL_PENDING', 'UNKNOWN'],
  ACKNOWLEDGED: ['PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'EXPIRED', 'UNKNOWN'],
  PARTIALLY_FILLED: ['FILLED', 'CANCEL_PENDING', 'UNKNOWN'],
  FILLED: [],
  CANCEL_PENDING: ['CANCELLED', 'FILLED', 'UNKNOWN'],
  CANCELLED: [],
  REJECTED: [],
  EXPIRED: [],
  UNKNOWN: ['RECONCILIATION_REQUIRED', 'ACKNOWLEDGED', 'FILLED', 'CANCELLED', 'REJECTED'],
  RECONCILIATION_REQUIRED: ['ACKNOWLEDGED', 'FILLED', 'CANCELLED', 'REJECTED', 'UNKNOWN'],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return (ALLOWED[from] || []).includes(to);
}

export function transition(
  from: OrderState,
  to: OrderState
): { ok: true; state: OrderState } | { ok: false; reason: string } {
  if (!canTransition(from, to)) {
    return { ok: false, reason: `INVALID_TRANSITION_${from}_TO_${to}` };
  }
  return { ok: true, state: to };
}
