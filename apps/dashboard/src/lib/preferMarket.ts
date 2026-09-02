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

function normEpicToken(epic: string): string {
  return String(epic || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** ETFs / options / yield products that mention Nasdaq 100 but are NOT the index. */
export function isUs100Impostor(m: CatalogMarket): boolean {
  const t = marketText(m);
  return /etf|options?|0\s*dte|0dte|enhanced|income|defiance|leveraged|inverse|yield|covered\s*call|qqq\b/.test(
    t,
  );
}

/** Capital A–Z catalog starts with "$ Kimly" etc — never a real desk default. */
export function isJunkStockMarket(m: CatalogMarket): boolean {
  const t = marketText(m);
  if (t.includes('kimly')) return true;
  if (/^\s*\$/.test(m.display_name || '')) return true;
  if (isUs100Impostor(m)) return true;
  return false;
}

/**
 * Real Capital index only: US100 / NAS100 / USTEC / "US Tech 100".
 * Never Defiance Nasdaq 100 ETF or other products that merely mention Nasdaq 100.
 */
export function isUs100Market(m: CatalogMarket): boolean {
  if (isUs100Impostor(m)) return false;
  const epic = normEpicToken(marketKey(m));
  if (
    /^(US100|NAS100|USTEC|USTECH|NDX100|US100CASH)\b/.test(epic) ||
    epic === 'US100' ||
    epic === 'NAS100' ||
    epic === 'USTEC' ||
    epic === 'USTECH' ||
    epic === 'NDX100' ||
    epic === 'US100CASH' ||
    epic.startsWith('US100') ||
    epic.startsWith('NAS100') ||
    epic.startsWith('USTEC')
  ) {
    return true;
  }
  const t = marketText(m);
  // Short Capital index labels — not long ETF titles
  if (/us\s*tech\s*100/.test(t)) return true;
  if (/\bus100\b/.test(t) && t.length < 48) return true;
  if (/\bnas100\b|\bustec\b|\bustech\b/.test(t) && t.length < 48) return true;
  return false;
}

export function isGoldMarket(m: CatalogMarket): boolean {
  const t = marketText(m);
  if (/etf|miner|mining|royalty/.test(t)) return false;
  return t.includes('xau') || /\bgold\b/.test(t);
}

export function isEurUsdMarket(m: CatalogMarket): boolean {
  const t = marketText(m);
  return t.includes('eurusd') || /eur\s*\/\s*usd/.test(t);
}

/** Liquid desk markets first — never fall through to $ Kimly / Defiance ETF. */
export function preferScore(m: CatalogMarket): number {
  if (isJunkStockMarket(m)) return -100;
  if (isUs100Market(m)) {
    const epic = normEpicToken(marketKey(m));
    if (epic === 'US100' || epic.startsWith('US100')) return 110;
    if (/us\s*tech\s*100/.test(marketText(m))) return 108;
    return 100;
  }
  if (isGoldMarket(m)) return 90;
  if (isEurUsdMarket(m)) return 80;
  const t = marketText(m);
  if (/\bus30\b|\bus500\b|\buk100\b|\bger40\b/.test(t)) return 70;
  if (t.includes('usd') || t.includes('fx') || t.includes('/')) return 40;
  return 10;
}

/**
 * Capital catalog is A–Z; "$ Kimly" / Defiance ETF sort first.
 * Prefer real US100 → Gold → EUR/USD → any non-junk.
 */
export function pickSwitchTarget(
  markets: CatalogMarket[],
  currentEpic?: string | null,
): CatalogMarket | null {
  if (!markets.length) return null;
  const cur = String(currentEpic || '').trim().toLowerCase();
  const ranked = [...markets].sort((a, b) => preferScore(b) - preferScore(a));
  const notCurrent = (m: CatalogMarket) => marketKey(m).toLowerCase() !== cur;

  const preferredOther = ranked.find((m) => preferScore(m) >= 70 && notCurrent(m));
  if (preferredOther) return preferredOther;

  const nonJunkOther = ranked.find((m) => !isJunkStockMarket(m) && notCurrent(m));
  if (nonJunkOther) return nonJunkOther;

  const samePreferred = ranked.find((m) => preferScore(m) >= 70);
  if (samePreferred) return samePreferred;

  const nonJunk = ranked.find((m) => !isJunkStockMarket(m));
  if (nonJunk) return nonJunk;

  return ranked.find(notCurrent) || ranked[0];
}

export function pickUs100(markets: CatalogMarket[]): CatalogMarket | null {
  const hits = markets.filter(isUs100Market);
  if (!hits.length) return null;
  hits.sort((a, b) => preferScore(b) - preferScore(a));
  return hits[0] || null;
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
