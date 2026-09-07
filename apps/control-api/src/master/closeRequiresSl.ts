/**
 * VS-System close-requires-SL — never app-close a trade with no stop.
 * - brokerFound=false → deal already gone (SL hit / external) → allow sync close
 * - brokerFound=true → require visible broker stopLoss
 * - brokerFound=null → broker unread → require local/DB stopLoss
 */
export function closeAllowedByStopLoss(input: {
  brokerFound: boolean | null;
  brokerStopLoss?: number | string | null;
  dbStopLoss?: number | string | null;
}): boolean {
  if (input.brokerFound === false) return true;
  const has = (v: unknown) => {
    if (v == null) return false;
    if (typeof v === 'number') return Number.isFinite(v);
    return String(v).trim().length > 0;
  };
  if (input.brokerFound === true) return has(input.brokerStopLoss);
  return has(input.dbStopLoss);
}
