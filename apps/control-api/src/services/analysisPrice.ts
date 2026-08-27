/**
 * Analysis price domain = MID.
 * Bid/ask reserved for execution / realizable PnL.
 * Critical UNKNOWN = BLOCK — never invent MID from one side.
 */

export type QuoteLike = {
  bid?: number | null;
  ask?: number | null;
  mid?: number | null;
};

/**
 * Prefer explicit mid only when it is a true mid (not a one-sided invent).
 * Else require BOTH bid and ask. Otherwise null → NO TRADE.
 */
export function analysisMid(q: QuoteLike | null | undefined): number | null {
  if (!q) return null;
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
  // Explicit mid alone is accepted only when both sides unavailable AND mid marked —
  // still require bid+ask for LIVE analysis; broker mid without sides is UNKNOWN.
  return null;
}

/** Mid of two sides — BOTH required. One-sided → null (BLOCK). */
export function midOfSides(bid: number | null, ask: number | null): number | null {
  if (
    bid != null &&
    ask != null &&
    Number.isFinite(bid) &&
    Number.isFinite(ask) &&
    bid > 0 &&
    ask > 0
  ) {
    return (bid + ask) / 2;
  }
  return null;
}
