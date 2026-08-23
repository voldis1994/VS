export type MarketOption = {
  instrument_id?: number;
  epic?: string;
  symbol: string;
  display_name: string;
  lot_size?: number;
  min_lot?: number;
};

export function marketKey(m: MarketOption): string {
  return m.epic || m.symbol;
}

export function filterMarkets(markets: MarketOption[], query: string, limit = 80): MarketOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return markets.slice(0, limit);
  return markets
    .filter(
      (m) =>
        m.display_name.toLowerCase().includes(q) ||
        marketKey(m).toLowerCase().includes(q) ||
        m.symbol.toLowerCase().includes(q),
    )
    .slice(0, limit);
}
