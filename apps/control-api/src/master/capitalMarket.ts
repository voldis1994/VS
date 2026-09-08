/** Capital.com marketStatus gating for MASTER LIVE entries. */
export function capitalMarketAllowsTrading(status: string | null | undefined): boolean {
  const s = String(status || '')
    .trim()
    .toUpperCase();
  // Fail closed: unknown/missing ≠ TRADEABLE (CLOSED can omit status briefly).
  if (!s) return false;
  return s === 'TRADEABLE' || s === 'OPEN';
}
