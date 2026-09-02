export type CatalogMarket = {
  epic?: string;
  symbol: string;
  display_name: string;
  lot_size?: number;
  min_lot?: number;
};

export function marketKey(m: CatalogMarket): string {
  return (m.epic || m.symbol || '').trim();
}

function marketText(m: CatalogMarket): string {
  return `${m.display_name} ${m.epic || ''} ${m.symbol}`.toLowerCase();
}

/** Capital A–Z catalog starts with "$ Kimly" etc — never a real desk default. */
export function isJunkStockMarket(m: CatalogMarket): boolean {
  const t = marketText(m);
  if (t.includes('kimly')) return true;
  // Dollar-prefixed equity names from Capital ("$ Kimly", "$ Foo")
  if (/^\s*\$/.test(m.display_name || '')) return true;
  return false;
}

export function isUs100Market(m: CatalogMarket): boolean {
  const t = marketText(m);
  return (
    t.includes('us100') ||
    t.includes('nas100') ||
    t.includes('ustec') ||
    t.includes('ndx') ||
    /nasdaq\s*100/.test(t) ||
    /us\s*tech\s*100/.test(t)
  );
}

export function isGoldMarket(m: CatalogMarket): boolean {
  const t = marketText(m);
  return t.includes('xau') || /\bgold\b/.test(t);
}

export function isEurUsdMarket(m: CatalogMarket): boolean {
  const t = marketText(m);
  return t.includes('eurusd') || /eur\s*\/\s*usd/.test(t);
}

/** Liquid desk markets first — never fall through to $ Kimly. */
export function preferScore(m: CatalogMarket): number {
  if (isUs100Market(m)) return 100;
  if (isGoldMarket(m)) return 90;
  if (isEurUsdMarket(m)) return 80;
  if (isJunkStockMarket(m)) return -100;
  const t = marketText(m);
  if (/\bus30\b|\bus500\b|\buk100\b|\bger40\b/.test(t)) return 70;
  if (t.includes('usd') || t.includes('fx') || t.includes('/')) return 40;
  return 10;
}

/**
 * Capital catalog is A–Z; "$ Kimly" sorts first.
 * Prefer US100 → Gold → EUR/USD → any non-junk. Never default to Kimly.
 */
export function pickSwitchTarget(
  markets: CatalogMarket[],
  currentEpic?: string | null,
): CatalogMarket | null {
  if (!markets.length) return null;
  const cur = String(currentEpic || '').trim().toLowerCase();
  const ranked = [...markets].sort((a, b) => preferScore(b) - preferScore(a));
  const notCurrent = (m: CatalogMarket) => marketKey(m).toLowerCase() !== cur;

  // Switch away from current: best liquid market that is not current
  const preferredOther = ranked.find((m) => preferScore(m) >= 70 && notCurrent(m));
  if (preferredOther) return preferredOther;

  // No other liquid — any non-junk that is not current (leave Kimly last)
  const nonJunkOther = ranked.find((m) => !isJunkStockMarket(m) && notCurrent(m));
  if (nonJunkOther) return nonJunkOther;

  // Stay on current liquid if nothing else real exists
  const samePreferred = ranked.find((m) => preferScore(m) >= 70);
  if (samePreferred) return samePreferred;

  const nonJunk = ranked.find((m) => !isJunkStockMarket(m));
  if (nonJunk) return nonJunk;

  return ranked.find(notCurrent) || ranked[0];
}

export function pickUs100(markets: CatalogMarket[]): CatalogMarket | null {
  return markets.find(isUs100Market) || null;
}

export function lotForMarket(m: CatalogMarket | null | undefined, fallback = 0.1): number {
  const n = Number(m?.lot_size || m?.min_lot || fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Next +DEPLOY target: a client who is not already live. Never steal the focused card. */
export function pickDeployAccount<T extends { account_id: number }>(
  accounts: T[],
  liveAccountIds: number[],
): T | null {
  if (!accounts.length) return null;
  const live = new Set(liveAccountIds);
  return accounts.find((a) => !live.has(a.account_id)) || accounts[0];
}
