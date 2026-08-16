/** Reconciliation — never silently repair financially meaningful differences. */

export type ReconciliationIssue = {
  kind:
    | 'MISSING_LOCAL_ORDER'
    | 'MISSING_BROKER_ORDER'
    | 'SIZE_MISMATCH'
    | 'STATE_MISMATCH'
    | 'UNKNOWN_EXECUTION'
    | 'ORPHAN_POSITION';
  localRef: string | null;
  brokerRef: string | null;
  detail: string;
};

export type ReconciliationResult = {
  status: 'CLEAN' | 'PENDING' | 'ISSUES';
  issues: ReconciliationIssue[];
  tradingBlocked: boolean;
};

export function compareSets(input: {
  localOrderIds: string[];
  brokerOrderIds: string[];
}): ReconciliationResult {
  const issues: ReconciliationIssue[] = [];
  for (const id of input.localOrderIds) {
    if (!input.brokerOrderIds.includes(id)) {
      issues.push({
        kind: 'MISSING_BROKER_ORDER',
        localRef: id,
        brokerRef: null,
        detail: 'local order absent at broker',
      });
    }
  }
  for (const id of input.brokerOrderIds) {
    if (!input.localOrderIds.includes(id)) {
      issues.push({
        kind: 'MISSING_LOCAL_ORDER',
        localRef: null,
        brokerRef: id,
        detail: 'broker order absent locally',
      });
    }
  }
  return {
    status: issues.length ? 'ISSUES' : 'CLEAN',
    issues,
    tradingBlocked: issues.length > 0,
  };
}
