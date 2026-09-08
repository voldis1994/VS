/** Capital.com marketStatus gating — desk parity (robotDesk.marketAllowsTrading). */
export function capitalMarketAllowsTrading(status: string | null | undefined): boolean {
  const s = String(status || '')
    .trim()
    .toUpperCase();
  // Missing status → do not park (Capital sometimes omits it; streaming marks lack it)
  if (!s) return true;
  return s === 'TRADEABLE' || s === 'OPEN';
}
