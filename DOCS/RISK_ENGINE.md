# Risk engine

Locations: `SERVER/core/risk/` + `SERVER/control-api/src/vs-core/riskCore.ts` (money path).

Mandatory between signal and execution. Kill switch ACTIVE ⇒ deny new positions.

Returns APPROVED/REJECTED with machine-readable codes. UI cannot bypass.

LIVE trading requires `LIVE_TRADING_ENABLED=true` (default false).
