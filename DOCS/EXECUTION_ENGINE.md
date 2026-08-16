# Execution engine

Location: `SERVER/core/execution/orderStateMachine.ts` + control-api order store.

States: CREATED → VALIDATING → RISK_APPROVED → SUBMITTING → SUBMITTED → ACKNOWLEDGED → PARTIALLY_FILLED → FILLED / REJECTED / CANCELLED / UNKNOWN / RECONCILIATION_REQUIRED.

Timeout ≠ failed. Unknown broker result ⇒ UNKNOWN + reconciliation — never blind resubmit.
