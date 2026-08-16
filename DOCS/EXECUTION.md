# Execution

Location: `SERVER/core/execution/`

States: CREATED → VALIDATING → RISK_APPROVED → SUBMITTING → SUBMITTED → ACKNOWLEDGED → PARTIALLY_FILLED → FILLED / CANCELLED / REJECTED / UNKNOWN / RECONCILIATION_REQUIRED.

Timeout ≠ failed. Unknown → reconciliation, never blind resubmit.
