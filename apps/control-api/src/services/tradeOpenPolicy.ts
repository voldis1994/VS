/**
 * Ultimate open start — no soft entry blocks at boot.
 * Auto-calibrate demotes losers after closes; lot size untouched.
 *
 * Still kept (not soft blocks): SAFETY SL, one-trade-per-epic, stale-quote fail-closed.
 */
export const TRADE_EVERYTHING_AT_START = true;

let testOverride: boolean | null = null;

export function tradeOpenAtStart(): boolean {
  if (testOverride != null) return testOverride;
  return TRADE_EVERYTHING_AT_START;
}

/** Test-only — pass null to clear override. */
export function _setTradeOpenAtStartForTests(value: boolean | null): void {
  testOverride = value;
}
