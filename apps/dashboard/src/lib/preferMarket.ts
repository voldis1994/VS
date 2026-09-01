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

export function isEurUsdMarket(m: CatalogMarket): boolean {
  const t = `${m.display_name} ${m.epic || ''} ${m.symbol}`.toLowerCase();
  return t.includes('eurusd') || /eur\s*\/\s*usd/.test(t);
}

/** Capital catalog is A–Z; "$ Kimly" sorts first. Never default SWITCH to that. */
export function pickSwitchTarget(
  markets: CatalogMarket[],
  currentEpic?: string | null,
): CatalogMarket | null {
  if (!markets.length) return null;
  const cur = String(currentEpic || '').trim().toLowerCase();
  const eur = markets.find(isEurUsdMarket);
  if (eur && marketKey(eur).toLowerCase() !== cur) return eur;
  if (eur) return eur;
  return markets.find((m) => marketKey(m).toLowerCase() !== cur) || markets[0];
}

export function lotForMarket(m: CatalogMarket | null | undefined, fallback = 0.1): number {
  const n = Number(m?.lot_size || m?.min_lot || fallback);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
