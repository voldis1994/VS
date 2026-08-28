/**
 * Temporary kill-switch for native 10-second OHLC + everything that depends on it
 * (early micro entry, 10s tape/regime from mid buckets, SECOND→10s aggregate).
 *
 * Default OFF (user request). Re-enable with env:
 *   TEN_SEC_OHLC_ENABLED=1
 */
function envEnabled(): boolean {
  const v = String(process.env.TEN_SEC_OHLC_ENABLED || '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Live desk / fanout: native 10s OHLC pipeline. */
export const TEN_SEC_OHLC_ENABLED = envEnabled();

export function tenSecOhlcStatusLine(): string {
  return TEN_SEC_OHLC_ENABLED
    ? '10s OHLC ON'
    : '10s OHLC OFF · 1m MOVE LIVE mid-candle (not waiting 5m/tape)';
}
