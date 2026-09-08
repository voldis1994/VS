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
    if (typeof v === 'number') return Number.isFinite(v) && v > 0;
    const s = String(v).trim();
    if (!s.length) return false;
    const n = Number(s);
    // Numeric string "0" is naked MT4 — not a protective stop
    if (Number.isFinite(n)) return n > 0;
    return true;
  };
  if (input.brokerFound === true) return has(input.brokerStopLoss);
  return has(input.dbStopLoss);
}
