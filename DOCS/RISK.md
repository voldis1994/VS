# Risk

Locations: `SERVER/core/risk/` + `SERVER/control-api/src/vs-core/riskCore.ts` + kill switch.

Mandatory between signal and execution. Kill switch ACTIVE → deny new entries.

Reason codes include stale feed, spread, reconcile dirty, client stopped, LIVE disabled, kill switch.
