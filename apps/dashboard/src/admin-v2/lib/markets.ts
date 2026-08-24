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

/** Rank so GOLD / XAU float above "Lingbao Gold Group Co Ltd" style noise. */
function rankMarket(m: MarketOption, q: string): number {
  const epic = marketKey(m).toLowerCase();
  const sym = (m.symbol || '').toLowerCase();
  const name = (m.display_name || '').toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);

  let score = 0;

  if (epic === q || sym === q) score += 10_000;
  if (name === q) score += 9_000;

  if (epic.startsWith(q) || sym.startsWith(q)) score += 5_000;
  if (name.startsWith(q)) score += 4_000;

  // Single-token epic like GOLD beats long equity names that merely contain "gold"
  if (epic === 'gold' || epic === 'xauusd' || epic === 'xau' || sym === 'gold') {
    if (tokens.some((t) => 'gold'.startsWith(t) || t.startsWith('gold') || t === 'xau')) {
      score += 8_000;
    }
  }

  for (const t of tokens) {
    if (epic.includes(t) || sym.includes(t)) score += 800;
    if (name.includes(t)) score += 200;
  }

  // Prefer short broker epics (CFDs) over long equity tickers/names
  score += Math.max(0, 40 - epic.length);
  score -= Math.min(name.length, 80);

  return score;
}

export function filterMarkets(markets: MarketOption[], query: string, limit = 80): MarketOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return markets.slice(0, limit);

  return markets
    .filter(
      (m) =>
        m.display_name.toLowerCase().includes(q) ||
        marketKey(m).toLowerCase().includes(q) ||
        m.symbol.toLowerCase().includes(q) ||
        q.split(/\s+/).every(
          (t) =>
            !t ||
            m.display_name.toLowerCase().includes(t) ||
            marketKey(m).toLowerCase().includes(t) ||
            m.symbol.toLowerCase().includes(t),
        ),
    )
    .map((m) => ({ m, score: rankMarket(m, q) }))
    .sort((a, b) => b.score - a.score || a.m.display_name.localeCompare(b.m.display_name))
    .slice(0, limit)
    .map((x) => x.m);
}
