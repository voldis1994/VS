/**
 * Analysis price domain = MID.
 * Bid/ask reserved for execution / realizable PnL.
 */

export type QuoteLike = {
  bid?: number | null;
  ask?: number | null;
  mid?: number | null;
};

/** Prefer explicit mid; else (bid+ask)/2; else null (UNKNOWN — do not guess). */
export function analysisMid(q: QuoteLike | null | undefined): number | null {
  if (!q) return null;
  if (q.mid != null && Number.isFinite(q.mid) && q.mid > 0) return q.mid;
  if (
    q.bid != null &&
    q.ask != null &&
    Number.isFinite(q.bid) &&
    Number.isFinite(q.ask) &&
    q.bid > 0 &&
    q.ask > 0
  ) {
    return (q.bid + q.ask) / 2;
  }
  return null;
}

/** Mid of two sides when Capital returns bid/ask OHLC legs. */
export function midOfSides(bid: number | null, ask: number | null): number | null {
  if (bid != null && ask != null && Number.isFinite(bid) && Number.isFinite(ask)) {
    return (bid + ask) / 2;
  }
  if (bid != null && Number.isFinite(bid)) return bid;
  if (ask != null && Number.isFinite(ask)) return ask;
  return null;
}
