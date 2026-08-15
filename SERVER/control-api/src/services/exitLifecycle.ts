/**
 * Exit close lifecycle — pure rules for broker-confirmed POSITION_CLOSED.
 * POSITION_CLOSED requires broker evidence that the position is flat.
 * HTTP close OK alone is not enough (mirrors entry: HTTP OK ≠ POSITION_OPEN).
 */

export type CloseIssueDecision =
  | { issue: false; reason: 'NO_POSITION' | 'ALREADY_CLOSING' | 'CLOSE_PENDING' }
  | { issue: true; reason: 'ISSUE_CLOSE' };

export type CloseFinalizeDecision =
  | { action: 'KEEP_OPEN'; reason: string }
  | { action: 'CLOSE_PENDING'; reason: string }
  | { action: 'FINALIZE_CLOSED'; reason: string };

/** Whether a manage cycle may submit a new broker close. */
export function canIssueClose(state: {
  open_side: string | null | undefined;
  close_in_flight?: boolean;
  close_pending?: boolean;
}): CloseIssueDecision {
  if (!state.open_side) return { issue: false, reason: 'NO_POSITION' };
  if (state.close_in_flight) return { issue: false, reason: 'ALREADY_CLOSING' };
  if (state.close_pending) return { issue: false, reason: 'CLOSE_PENDING' };
  return { issue: true, reason: 'ISSUE_CLOSE' };
}

/**
 * After a close attempt: only FINALIZE_CLOSED when broker list confirms flat.
 * Broker rejection → KEEP_OPEN (never optimistic POSITION_CLOSED).
 * HTTP OK but still listed open / list unknown → CLOSE_PENDING (retry verify, no double-claim).
 */
export function decideCloseFinalize(input: {
  closeHttpOk: boolean;
  closeDetail?: string;
  brokerListOk: boolean | null;
  stillOpenOnBroker: boolean | null;
}): CloseFinalizeDecision {
  if (!input.closeHttpOk) {
    return {
      action: 'KEEP_OPEN',
      reason: input.closeDetail || 'broker close rejected',
    };
  }
  if (input.brokerListOk === false || input.brokerListOk == null) {
    return {
      action: 'CLOSE_PENDING',
      reason: 'close submitted — awaiting broker flat confirmation (list unavailable)',
    };
  }
  if (input.stillOpenOnBroker === true) {
    return {
      action: 'CLOSE_PENDING',
      reason: 'close submitted — position still open at broker',
    };
  }
  if (input.stillOpenOnBroker === false) {
    return {
      action: 'FINALIZE_CLOSED',
      reason: 'broker confirmed flat after close',
    };
  }
  return {
    action: 'CLOSE_PENDING',
    reason: 'close submitted — flat status unknown',
  };
}

/** External/broker-flat sync while local thought open. */
export function decideExternalFlatClear(input: {
  localOpen: boolean;
  brokerListOk: boolean;
  brokerHasPosition: boolean;
}): 'CLEAR_LOCAL' | 'ADOPT' | 'HOLD' {
  if (!input.brokerListOk) return 'HOLD';
  if (input.brokerHasPosition) return input.localOpen ? 'HOLD' : 'ADOPT';
  if (input.localOpen) return 'CLEAR_LOCAL';
  return 'HOLD';
}
