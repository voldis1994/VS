/**
 * Public internet price providers for multi-feed OHLC.
 * No API keys — used alongside Capital rows so regime/entry is not single-broker.
 */

export type PublicFeedKind = 'yahoo_finance' | 'aurum_metals' | 'fx_live' | 'coinbase' | 'fx_reference';

export type PublicFeedRead = {
  sender_id: string;
  name: string;
  kind: PublicFeedKind;
  epic: string;
  ok: boolean;
  mid: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  market_status: string | null;
  source_time: string | null;
  latency_ms: number;
  detail?: string;
};

type CacheEntry = { at: number; read: PublicFeedRead };
const cache = new Map<string, CacheEntry>();
/** 10s scalp — public lead must be fresher than Capital lag, not 20s stale. */
const PUBLIC_TTL_MS = 2_500;

export const PUBLIC_SENDERS: Array<{
  sender_id: string;
  name: string;
  kind: PublicFeedKind;
}> = [
  { sender_id: 'yahoo-finance', name: 'Yahoo Finance (public)', kind: 'yahoo_finance' },
  { sender_id: 'aurum-metals', name: 'Aurum metals spot (public)', kind: 'aurum_metals' },
  { sender_id: 'fx-live-fawaz', name: 'Fawaz FX live (public)', kind: 'fx_live' },
  { sender_id: 'coinbase-spot', name: 'Coinbase spot (public)', kind: 'coinbase' },
];

function norm(epic: string): string {
  return String(epic || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Map Capital / VS epic to Yahoo chart symbol when possible. */
export function epicToYahooSymbol(epic: string): string | null {
  const s = norm(epic);
  if (!s) return null;

  if (/(^|[^A-Z])XAU|GOLD/.test(s) || s === 'GOLD' || s.startsWith('GOLD')) return 'GC=F';
  if (/(^|[^A-Z])XAG|SILVER/.test(s) || s.startsWith('SILVER')) return 'SI=F';
  if (/PLATINUM|XPT/.test(s)) return 'PL=F';
  if (/PALLADIUM|XPD/.test(s)) return 'PA=F';
  if (/BRENT|UKOIL|OIL_BRENT/.test(s)) return 'BZ=F';
  if (/WTI|USOIL|CRUDE|OIL/.test(s)) return 'CL=F';
  if (/BTC/.test(s)) return 'BTC-USD';
  if (/ETH/.test(s)) return 'ETH-USD';
  if (/US500|SPX|SP500|SPY/.test(s)) return '^GSPC';
  if (/US100|NDX|NAS100|USTECH/.test(s)) return '^NDX';
  if (/US30|DJ30|DOW|DJI/.test(s)) return '^DJI';
  if (/DE40|DAX/.test(s)) return '^GDAXI';
  if (/UK100|FTSE/.test(s)) return '^FTSE';

  const majors = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];
  for (const a of majors) {
    for (const b of majors) {
      if (a === b) continue;
      if (s.includes(a + b)) return `${a}${b}=X`;
    }
  }
  return null;
}

export function epicToMetalKey(epic: string): 'gold' | 'silver' | 'platinum' | 'palladium' | null {
  const s = norm(epic);
  if (/(^|[^A-Z])XAU|GOLD/.test(s) || s.startsWith('GOLD')) return 'gold';
  if (/(^|[^A-Z])XAG|SILVER/.test(s) || s.startsWith('SILVER')) return 'silver';
  if (/PLATINUM|XPT/.test(s)) return 'platinum';
  if (/PALLADIUM|XPD/.test(s)) return 'palladium';
  return null;
}

export function epicToFxPair(epic: string): { from: string; to: string } | null {
  const s = norm(epic);
  const majors = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];
  for (const a of majors) {
    for (const b of majors) {
      if (a === b) continue;
      if (s.includes(a + b)) return { from: a, to: b };
    }
  }
  return null;
}

export function epicToCoinbaseProduct(epic: string): string | null {
  const s = norm(epic);
  if (/BTC/.test(s) && /USD|USDT|USDC/.test(s)) return 'BTC-USD';
  if (/ETH/.test(s) && /USD|USDT|USDC/.test(s)) return 'ETH-USD';
  if (s === 'BTC' || s === 'BTCUSD') return 'BTC-USD';
  if (s === 'ETH' || s === 'ETHUSD') return 'ETH-USD';
  return null;
}

/** Whether any public internet provider can price this epic. */
export function publicFeedsApplicable(epic: string): boolean {
  return !!(
    epicToYahooSymbol(epic) ||
    epicToMetalKey(epic) ||
    epicToFxPair(epic) ||
    epicToCoinbaseProduct(epic)
  );
}

/**
 * Robust mid fusion: drop outliers far from median, then re-median.
 * Wider divergent band when mixing public + broker (spot vs CFD).
 */
export function fusePriceMids(
  mids: number[],
  opts?: { mixedPublic?: boolean }
): {
  mid: number | null;
  contributing: number;
  agreement: 'STRONG' | 'OK' | 'DIVERGENT' | 'INSUFFICIENT' | 'NONE';
  inliers: number[];
  span: number;
} {
  const finite = mids.filter((m) => Number.isFinite(m));
  if (finite.length === 0) {
    return { mid: null, contributing: 0, agreement: 'NONE', inliers: [], span: 0 };
  }

  const sorted = [...finite].sort((a, b) => a - b);
  const medianOf = (arr: number[]) => {
    const i = Math.floor(arr.length / 2);
    return arr.length % 2 === 1 ? arr[i]! : (arr[i - 1]! + arr[i]!) / 2;
  };
  const rawMed = medianOf(sorted);
  const outlierPct = opts?.mixedPublic ? 0.02 : 0.012;
  let inliers = sorted.filter((m) => Math.abs(m - rawMed) / Math.max(Math.abs(rawMed), 1e-9) <= outlierPct);
  if (inliers.length === 0) inliers = sorted;

  const mid = medianOf(inliers);
  const span = inliers[inliers.length - 1]! - inliers[0]!;
  const rel = Math.abs(mid) > 0 ? span / Math.abs(mid) : span;
  const divergeAt = opts?.mixedPublic ? 0.015 : 0.005;

  let agreement: 'STRONG' | 'OK' | 'DIVERGENT' | 'INSUFFICIENT' | 'NONE' = 'OK';
  if (inliers.length === 1) agreement = 'INSUFFICIENT';
  else if (rel < 0.0005) agreement = 'STRONG';
  else if (rel > divergeAt) agreement = 'DIVERGENT';

  return { mid, contributing: inliers.length, agreement, inliers, span };
}

function fromCache(key: string): PublicFeedRead | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PUBLIC_TTL_MS) return null;
  return { ...hit.read, detail: `${hit.read.detail || ''} · cached`.trim() };
}

function putCache(key: string, read: PublicFeedRead) {
  cache.set(key, { at: Date.now(), read });
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'VS-MarketReader/1.0 (+public-feed)',
      ...(init?.headers || {}),
    },
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

export async function readYahooFinance(epic: string): Promise<PublicFeedRead> {
  const sender_id = 'yahoo-finance';
  const name = 'Yahoo Finance (public)';
  const t0 = Date.now();
  const symbol = epicToYahooSymbol(epic);
  const base = {
    sender_id,
    name,
    kind: 'yahoo_finance' as const,
    epic,
    bid: null as number | null,
    ask: null as number | null,
    spread: null as number | null,
  };
  if (!symbol) {
    return {
      ...base,
      ok: false,
      mid: null,
      market_status: null,
      source_time: null,
      latency_ms: Date.now() - t0,
      detail: 'No Yahoo mapping for this epic',
    };
  }

  const cacheKey = `${sender_id}:${symbol}`;
  const cached = fromCache(cacheKey);
  if (cached) return { ...cached, epic };

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?interval=1m&range=1d`;
    const { ok, status, json } = await fetchJson(url);
    const latency_ms = Date.now() - t0;
    const result = (json as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } })
      ?.chart?.result?.[0];
    const price = result?.meta?.regularMarketPrice;
    if (!ok || price == null || !Number.isFinite(price)) {
      const read: PublicFeedRead = {
        ...base,
        ok: false,
        mid: null,
        market_status: null,
        source_time: null,
        latency_ms,
        detail: `Yahoo HTTP ${status} · ${symbol}`,
      };
      return read;
    }
    const now = new Date().toISOString();
    const read: PublicFeedRead = {
      ...base,
      ok: true,
      mid: price,
      bid: price,
      ask: price,
      spread: 0,
      market_status: 'PUBLIC_LIVE',
      source_time: now,
      latency_ms,
      detail: `Yahoo ${symbol} mid=${price}`,
    };
    putCache(cacheKey, read);
    return read;
  } catch (err) {
    return {
      ...base,
      ok: false,
      mid: null,
      market_status: null,
      source_time: null,
      latency_ms: Date.now() - t0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function readAurumMetals(epic: string): Promise<PublicFeedRead> {
  const sender_id = 'aurum-metals';
  const name = 'Aurum metals spot (public)';
  const t0 = Date.now();
  const metal = epicToMetalKey(epic);
  const base = {
    sender_id,
    name,
    kind: 'aurum_metals' as const,
    epic,
    bid: null as number | null,
    ask: null as number | null,
    spread: null as number | null,
  };
  if (!metal) {
    return {
      ...base,
      ok: false,
      mid: null,
      market_status: null,
      source_time: null,
      latency_ms: Date.now() - t0,
      detail: 'Aurum only prices gold/silver/platinum/palladium',
    };
  }

  const cacheKey = `${sender_id}:${metal}`;
  const cached = fromCache(cacheKey);
  if (cached) return { ...cached, epic };

  try {
    const { ok, status, json } = await fetchJson('https://aurumrates.com/api/v1/spot');
    const latency_ms = Date.now() - t0;
    const data = (json as { data?: Record<string, { price?: number; timestamp?: number }> })?.data;
    const row = data?.[metal];
    const price = row?.price;
    if (!ok || price == null || !Number.isFinite(price)) {
      return {
        ...base,
        ok: false,
        mid: null,
        market_status: null,
        source_time: null,
        latency_ms,
        detail: `Aurum HTTP ${status}`,
      };
    }
    const source_time = row?.timestamp
      ? new Date(row.timestamp * 1000).toISOString()
      : new Date().toISOString();
    const read: PublicFeedRead = {
      ...base,
      ok: true,
      mid: price,
      bid: price,
      ask: price,
      spread: 0,
      market_status: 'PUBLIC_LIVE',
      source_time,
      latency_ms,
      detail: `Aurum ${metal} mid=${price}`,
    };
    putCache(cacheKey, read);
    return read;
  } catch (err) {
    return {
      ...base,
      ok: false,
      mid: null,
      market_status: null,
      source_time: null,
      latency_ms: Date.now() - t0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function readFawazFxLive(epic: string): Promise<PublicFeedRead> {
  const sender_id = 'fx-live-fawaz';
  const name = 'Fawaz FX live (public)';
  const t0 = Date.now();
  const pair = epicToFxPair(epic);
  const base = {
    sender_id,
    name,
    kind: 'fx_live' as const,
    epic,
    bid: null as number | null,
    ask: null as number | null,
    spread: null as number | null,
  };
  if (!pair) {
    return {
      ...base,
      ok: false,
      mid: null,
      market_status: null,
      source_time: null,
      latency_ms: Date.now() - t0,
      detail: 'FX live only for major currency pairs',
    };
  }

  const cacheKey = `${sender_id}:${pair.from}:${pair.to}`;
  const cached = fromCache(cacheKey);
  if (cached) return { ...cached, epic };

  try {
    const baseCcy = pair.from.toLowerCase();
    const quoteCcy = pair.to.toLowerCase();
    const url = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${baseCcy}.json`;
    const { ok, status, json } = await fetchJson(url);
    const latency_ms = Date.now() - t0;
    const bag = (json as Record<string, Record<string, number> | string>)?.[baseCcy] as
      | Record<string, number>
      | undefined;
    const rate = bag?.[quoteCcy];
    if (!ok || rate == null || !Number.isFinite(rate)) {
      return {
        ...base,
        ok: false,
        mid: null,
        market_status: null,
        source_time: null,
        latency_ms,
        detail: `Fawaz FX HTTP ${status}`,
      };
    }
    const date = String((json as { date?: string }).date || new Date().toISOString());
    const read: PublicFeedRead = {
      ...base,
      ok: true,
      mid: rate,
      bid: rate,
      ask: rate,
      spread: 0,
      market_status: 'PUBLIC_LIVE',
      source_time: date,
      latency_ms,
      detail: `Fawaz ${pair.from}/${pair.to}=${rate}`,
    };
    putCache(cacheKey, read);
    return read;
  } catch (err) {
    return {
      ...base,
      ok: false,
      mid: null,
      market_status: null,
      source_time: null,
      latency_ms: Date.now() - t0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function readCoinbaseSpot(epic: string): Promise<PublicFeedRead> {
  const sender_id = 'coinbase-spot';
  const name = 'Coinbase spot (public)';
  const t0 = Date.now();
  const product = epicToCoinbaseProduct(epic);
  const base = {
    sender_id,
    name,
    kind: 'coinbase' as const,
    epic,
    bid: null as number | null,
    ask: null as number | null,
    spread: null as number | null,
  };
  if (!product) {
    return {
      ...base,
      ok: false,
      mid: null,
      market_status: null,
      source_time: null,
      latency_ms: Date.now() - t0,
      detail: 'Coinbase only for BTC/ETH USD',
    };
  }

  const cacheKey = `${sender_id}:${product}`;
  const cached = fromCache(cacheKey);
  if (cached) return { ...cached, epic };

  try {
    const url = `https://api.coinbase.com/v2/prices/${product}/spot`;
    const { ok, status, json } = await fetchJson(url);
    const latency_ms = Date.now() - t0;
    const amount = Number((json as { data?: { amount?: string } })?.data?.amount);
    if (!ok || !Number.isFinite(amount)) {
      return {
        ...base,
        ok: false,
        mid: null,
        market_status: null,
        source_time: null,
        latency_ms,
        detail: `Coinbase HTTP ${status}`,
      };
    }
    const now = new Date().toISOString();
    const read: PublicFeedRead = {
      ...base,
      ok: true,
      mid: amount,
      bid: amount,
      ask: amount,
      spread: 0,
      market_status: 'PUBLIC_LIVE',
      source_time: now,
      latency_ms,
      detail: `Coinbase ${product}=${amount}`,
    };
    putCache(cacheKey, read);
    return read;
  } catch (err) {
    return {
      ...base,
      ok: false,
      mid: null,
      market_status: null,
      source_time: null,
      latency_ms: Date.now() - t0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Read all applicable public internet providers for one epic (parallel, cached). */
export async function readAllPublicFeeds(epic: string): Promise<PublicFeedRead[]> {
  return Promise.all([
    readYahooFinance(epic),
    readAurumMetals(epic),
    readFawazFxLive(epic),
    readCoinbaseSpot(epic),
  ]);
}

/** Clear cache — tests only. */
export function clearPublicFeedCache() {
  cache.clear();
}
