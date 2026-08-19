/**
 * Public internet price providers for multi-feed OHLC.
 * No API keys — used alongside Capital rows so regime/entry is not single-broker.
 */

export type PublicFeedKind =
  | 'yahoo_finance'
  | 'aurum_metals'
  | 'fx_live'
  | 'coinbase'
  | 'gold_api'
  | 'kraken'
  | 'kucoin'
  | 'binance_us'
  | 'coingecko'
  | 'bitstamp'
  | 'fx_reference';

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
const PUBLIC_TTL_MS = 8_000;

export const PUBLIC_SENDERS: Array<{
  sender_id: string;
  name: string;
  kind: PublicFeedKind;
}> = [
  { sender_id: 'yahoo-finance', name: 'Yahoo Finance (public)', kind: 'yahoo_finance' },
  { sender_id: 'aurum-metals', name: 'Aurum metals spot (public)', kind: 'aurum_metals' },
  { sender_id: 'gold-api', name: 'Gold-API spot (public)', kind: 'gold_api' },
  { sender_id: 'fx-live-fawaz', name: 'Fawaz FX / XAU (public)', kind: 'fx_live' },
  { sender_id: 'coinbase-spot', name: 'Coinbase spot (public)', kind: 'coinbase' },
  { sender_id: 'kraken-spot', name: 'Kraken spot (public)', kind: 'kraken' },
  { sender_id: 'kucoin-spot', name: 'KuCoin spot (public)', kind: 'kucoin' },
  { sender_id: 'binance-us', name: 'Binance.US (public)', kind: 'binance_us' },
  { sender_id: 'coingecko', name: 'CoinGecko (public)', kind: 'coingecko' },
  { sender_id: 'bitstamp', name: 'Bitstamp (public)', kind: 'bitstamp' },
];

function norm(epic: string): string {
  return String(epic || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Strict gold epic — avoids false positives like ASXAU (ASX Ltd stock). */
export function isGoldEpic(epic: string): boolean {
  const s = norm(epic);
  if (!s) return false;
  if (s === 'GOLD' || s.startsWith('GOLD')) return true;
  if (s === 'XAU' || /^XAU[A-Z]{3}$/.test(s)) return true;
  return false;
}

const YAHOO_EQUITY_CC: Record<string, string> = {
  AU: '.AX',
  UK: '.L',
  DE: '.DE',
  FR: '.PA',
  JP: '.T',
  HK: '.HK',
};

function isMajorMarketEpic(s: string): boolean {
  if (isGoldEpic(s)) return true;
  if (/(^|[^A-Z])XAG|SILVER/.test(s) || s.startsWith('SILVER')) return true;
  if (/PLATINUM|XPT|PALLADIUM|XPD/.test(s)) return true;
  if (/US500|US100|US30|US2000|GER40|DE40|UK100|JP225|AUS200|HK50/.test(s)) return true;
  if (/USOIL|UKOIL|BRENT|WTI|CRUDE|NATGAS|NGAS/.test(s)) return true;
  if (/BTC|ETH|BITCOIN|ETHEREUM/.test(s)) return true;
  const majors = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];
  for (const a of majors) {
    for (const b of majors) {
      if (a !== b && s.includes(a + b)) return true;
    }
  }
  return false;
}

/** Capital single-stock epics like ASX-AU → Yahoo ASX.AX */
export function epicToYahooEquity(epic: string): string | null {
  const s = norm(epic);
  if (!s || s.length < 3 || isMajorMarketEpic(s)) return null;

  for (const [cc, suf] of Object.entries(YAHOO_EQUITY_CC)) {
    if (s.endsWith(cc) && s.length > cc.length + 1) {
      const tick = s.slice(0, -cc.length);
      if (/^[A-Z]{1,6}$/.test(tick)) return `${tick}${suf}`;
    }
  }
  if (/^[A-Z]{1,5}US$/.test(s)) return s.slice(0, -2);
  if (/^[A-Z]{1,5}$/.test(s)) return s;
  return null;
}

/** Map Capital / VS epic to Yahoo chart symbol when possible. */
export function epicToYahooSymbol(epic: string): string | null {
  const s = norm(epic);
  if (!s) return null;

  if (isGoldEpic(epic)) return 'GC=F';
  if (/(^|[^A-Z])XAG|SILVER/.test(s) || s.startsWith('SILVER')) return 'SI=F';
  if (/PLATINUM|XPT/.test(s)) return 'PL=F';
  if (/PALLADIUM|XPD/.test(s)) return 'PA=F';
  if (/BRENT|UKOIL|OILBRENT/.test(s)) return 'BZ=F';
  if (/WTI|USOIL|CRUDE|OILWTI|OILCRUDE/.test(s)) return 'CL=F';
  if (/OIL\b/.test(s) && !/SILVER|GOLD/.test(s)) return 'CL=F';
  if (/NATGAS|NATURALGAS|NGAS/.test(s)) return 'NG=F';
  if (/BTC|BITCOIN/.test(s)) return 'BTC-USD';
  if (/ETH|ETHEREUM/.test(s)) return 'ETH-USD';
  if (/US500|SPX|SP500|SPY|SNP|SANDP/.test(s)) return '^GSPC';
  if (/US100|NDX|NAS100|USTECH|NASDAQ/.test(s)) return '^NDX';
  if (/US30|DJ30|DOW|DJI|WALLSTREET30/.test(s)) return '^DJI';
  if (/US2000|RUSSELL|RTY/.test(s)) return '^RUT';
  if (/GER40|DE40|DAX/.test(s)) return '^GDAXI';
  if (/FRA40|CAC/.test(s)) return '^FCHI';
  if (/UK100|FTSE/.test(s)) return '^FTSE';
  if (/EU50|STOXX|EUROSTOXX/.test(s)) return '^STOXX50E';
  if (/JP225|JPN225|NIKKEI/.test(s)) return '^N225';
  if (/HK50|HSI|HANGSENG/.test(s)) return '^HSI';
  if (/AUS200|ASX200/.test(s)) return '^AXJO';

  const majors = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];
  for (const a of majors) {
    for (const b of majors) {
      if (a === b) continue;
      if (s.includes(a + b)) return `${a}${b}=X`;
    }
  }
  return epicToYahooEquity(epic);
}

export function epicToMetalKey(epic: string): 'gold' | 'silver' | 'platinum' | 'palladium' | null {
  const s = norm(epic);
  if (isGoldEpic(epic)) return 'gold';
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
  if (isGoldEpic(epic)) return 'PAXG-USD';
  if (/(^|[^A-Z])XAG|SILVER/.test(s) || s.startsWith('SILVER')) return null;
  if (/BTC|BITCOIN/.test(s)) return 'BTC-USD';
  if (/ETH|ETHEREUM/.test(s)) return 'ETH-USD';
  return null;
}

export function epicToGoldApiSymbol(epic: string): string | null {
  const metal = epicToMetalKey(epic);
  if (metal === 'gold') return 'XAU';
  if (metal === 'silver') return 'XAG';
  if (metal === 'platinum') return 'XPT';
  if (metal === 'palladium') return 'XPD';
  return null;
}

export function epicToKrakenPair(epic: string): string | null {
  const s = norm(epic);
  if (isGoldEpic(epic)) return 'PAXGUSD';
  if (/BTC|BITCOIN/.test(s)) return 'XBTUSD';
  if (/ETH|ETHEREUM/.test(s)) return 'ETHUSD';
  const pair = epicToFxPair(epic);
  if (pair) return `${pair.from}${pair.to}`;
  return null;
}

export function epicToKucoinSymbol(epic: string): string | null {
  const s = norm(epic);
  if (isGoldEpic(epic)) return 'PAXG-USDT';
  if (/BTC|BITCOIN/.test(s)) return 'BTC-USDT';
  if (/ETH|ETHEREUM/.test(s)) return 'ETH-USDT';
  return null;
}

export function epicToBinanceUsSymbol(epic: string): string | null {
  const s = norm(epic);
  if (isGoldEpic(epic)) return 'PAXGUSDT';
  if (/BTC|BITCOIN/.test(s)) return 'BTCUSDT';
  if (/ETH|ETHEREUM/.test(s)) return 'ETHUSDT';
  return null;
}

export function epicToFawazMetal(epic: string): 'xau' | 'xag' | 'xpt' | 'xpd' | null {
  const metal = epicToMetalKey(epic);
  if (metal === 'gold') return 'xau';
  if (metal === 'silver') return 'xag';
  if (metal === 'platinum') return 'xpt';
  if (metal === 'palladium') return 'xpd';
  return null;
}

export function epicToCoinGeckoId(epic: string): string | null {
  const s = norm(epic);
  if (isGoldEpic(epic)) return 'pax-gold';
  if (/BTC|BITCOIN/.test(s)) return 'bitcoin';
  if (/ETH|ETHEREUM/.test(s)) return 'ethereum';
  return null;
}

const BITSTAMP_FX = new Set([
  'eurusd',
  'gbpusd',
  'usdchf',
  'usdjpy',
  'audusd',
  'usdcad',
  'nzdusd',
]);

export function epicToBitstampPair(epic: string): string | null {
  const s = norm(epic);
  if (isGoldEpic(epic)) return 'paxgusd';
  if (/BTC|BITCOIN/.test(s)) return 'btcusd';
  if (/ETH|ETHEREUM/.test(s)) return 'ethusd';
  const pair = epicToFxPair(epic);
  if (!pair) return null;
  const p = `${pair.from}${pair.to}`.toLowerCase();
  return BITSTAMP_FX.has(p) ? p : null;
}

/** N/A = this sender has no mapping for the focused epic (IDLE, not ERROR). */
export function publicFeedNotApplicable(detail?: string | null): boolean {
  const d = (detail || '').trim().toLowerCase();
  return d.startsWith('n/a');
}

/** Whether any public internet provider can price this epic. */
export function publicFeedsApplicable(epic: string): boolean {
  return !!(
    epicToYahooSymbol(epic) ||
    epicToMetalKey(epic) ||
    epicToFxPair(epic) ||
    epicToCoinbaseProduct(epic) ||
    epicToGoldApiSymbol(epic) ||
    epicToKrakenPair(epic) ||
    epicToKucoinSymbol(epic) ||
    epicToBinanceUsSymbol(epic) ||
    epicToCoinGeckoId(epic) ||
    epicToBitstampPair(epic)
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
    signal: init?.signal ?? AbortSignal.timeout(4500),
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; VS-MarketReader/1.0)',
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
      detail: 'N/A · no Yahoo mapping for this epic',
    };
  }

  const cacheKey = `${sender_id}:${symbol}`;
  const cached = fromCache(cacheKey);
  if (cached) return { ...cached, epic };

  try {
    const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
    let lastStatus = 0;
    for (const host of hosts) {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
      const { ok, status, json } = await fetchJson(url);
      lastStatus = status;
      const result = (json as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } })
        ?.chart?.result?.[0];
      const price = result?.meta?.regularMarketPrice;
      if (!ok || price == null || !Number.isFinite(price)) continue;
      const latency_ms = Date.now() - t0;
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
    }
    return {
      ...base,
      ok: false,
      mid: null,
      market_status: null,
      source_time: null,
      latency_ms: Date.now() - t0,
      detail: `Yahoo HTTP ${lastStatus} · ${symbol}`,
    };
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
      detail: 'N/A · Aurum only prices gold/silver/platinum/palladium',
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
  const name = 'Fawaz FX / XAU (public)';
  const t0 = Date.now();
  const pair = epicToFxPair(epic);
  const metal = epicToFawazMetal(epic);
  const base = {
    sender_id,
    name,
    kind: 'fx_live' as const,
    epic,
    bid: null as number | null,
    ask: null as number | null,
    spread: null as number | null,
  };
  if (!pair && !metal) {
    return {
      ...base,
      ok: false,
      mid: null,
      market_status: null,
      source_time: null,
      latency_ms: Date.now() - t0,
      detail: 'N/A · Fawaz has no mapping for this epic',
    };
  }

  const cacheKey = `${sender_id}:${metal || `${pair!.from}:${pair!.to}`}`;
  const cached = fromCache(cacheKey);
  if (cached) return { ...cached, epic };

  try {
    const baseCcy = (metal || pair!.from).toLowerCase();
    const quoteCcy = metal ? 'usd' : pair!.to.toLowerCase();
    const hosts = [
      `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${baseCcy}.json`,
      `https://latest.currency-api.pages.dev/v1/currencies/${baseCcy}.json`,
    ];
    let lastStatus = 0;
    for (const url of hosts) {
      const { ok, status, json } = await fetchJson(url);
      lastStatus = status;
      const bag = (json as Record<string, Record<string, number> | string>)?.[baseCcy] as
        | Record<string, number>
        | undefined;
      const rate = bag?.[quoteCcy];
      if (!ok || rate == null || !Number.isFinite(rate)) continue;
      const latency_ms = Date.now() - t0;
      const date = String((json as { date?: string }).date || new Date().toISOString());
      const label = metal ? `${metal.toUpperCase()}/USD` : `${pair!.from}/${pair!.to}`;
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
        detail: `Fawaz ${label}=${rate}`,
      };
      putCache(cacheKey, read);
      return read;
    }
    return {
      ...base,
      ok: false,
      mid: null,
      market_status: null,
      source_time: null,
      latency_ms: Date.now() - t0,
      detail: `Fawaz HTTP ${lastStatus}`,
    };
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
      detail: 'N/A · Coinbase has no mapping for this epic',
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

export async function readGoldApi(epic: string): Promise<PublicFeedRead> {
  const sender_id = 'gold-api';
  const name = 'Gold-API spot (public)';
  const t0 = Date.now();
  const symbol = epicToGoldApiSymbol(epic);
  const base = {
    sender_id,
    name,
    kind: 'gold_api' as const,
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
      detail: 'N/A · Gold-API only metals',
    };
  }
  const cacheKey = `${sender_id}:${symbol}`;
  const cached = fromCache(cacheKey);
  if (cached) return { ...cached, epic };
  try {
    const { ok, status, json } = await fetchJson(`https://api.gold-api.com/price/${symbol}`);
    const latency_ms = Date.now() - t0;
    const price = Number((json as { price?: number }).price);
    if (!ok || !Number.isFinite(price) || price <= 0) {
      return {
        ...base,
        ok: false,
        mid: null,
        market_status: null,
        source_time: null,
        latency_ms,
        detail: `Gold-API HTTP ${status}`,
      };
    }
    const source_time = String((json as { updatedAt?: string }).updatedAt || new Date().toISOString());
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
      detail: `Gold-API ${symbol}=${price}`,
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

export async function readKrakenSpot(epic: string): Promise<PublicFeedRead> {
  const sender_id = 'kraken-spot';
  const name = 'Kraken spot (public)';
  const t0 = Date.now();
  const pair = epicToKrakenPair(epic);
  const base = {
    sender_id,
    name,
    kind: 'kraken' as const,
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
      detail: 'N/A · Kraken has no mapping for this epic',
    };
  }
  const cacheKey = `${sender_id}:${pair}`;
  const cached = fromCache(cacheKey);
  if (cached) return { ...cached, epic };
  try {
    const { ok, status, json } = await fetchJson(
      `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pair)}`
    );
    const latency_ms = Date.now() - t0;
    const err = (json as { error?: string[] }).error;
    const result = (json as { result?: Record<string, { a?: string[]; b?: string[]; c?: string[] }> }).result;
    const row = result ? Object.values(result)[0] : undefined;
    const ask = Number(row?.a?.[0]);
    const bid = Number(row?.b?.[0]);
    const last = Number(row?.c?.[0]);
    const mid =
      Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : Number.isFinite(last) ? last : NaN;
    if (!ok || (Array.isArray(err) && err.length) || !Number.isFinite(mid) || mid <= 0) {
      return {
        ...base,
        ok: false,
        mid: null,
        market_status: null,
        source_time: null,
        latency_ms,
        detail: `Kraken HTTP ${status} ${Array.isArray(err) ? err.join(',') : ''}`,
      };
    }
    const read: PublicFeedRead = {
      ...base,
      ok: true,
      mid,
      bid: Number.isFinite(bid) ? bid : mid,
      ask: Number.isFinite(ask) ? ask : mid,
      spread: Number.isFinite(ask) && Number.isFinite(bid) ? ask - bid : 0,
      market_status: 'PUBLIC_LIVE',
      source_time: new Date().toISOString(),
      latency_ms,
      detail: `Kraken ${pair} mid=${mid}`,
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

export async function readKucoinSpot(epic: string): Promise<PublicFeedRead> {
  const sender_id = 'kucoin-spot';
  const name = 'KuCoin spot (public)';
  const t0 = Date.now();
  const symbol = epicToKucoinSymbol(epic);
  const base = {
    sender_id,
    name,
    kind: 'kucoin' as const,
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
      detail: 'N/A · KuCoin has no mapping for this epic',
    };
  }
  const cacheKey = `${sender_id}:${symbol}`;
  const cached = fromCache(cacheKey);
  if (cached) return { ...cached, epic };
  try {
    const { ok, status, json } = await fetchJson(
      `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${encodeURIComponent(symbol)}`
    );
    const latency_ms = Date.now() - t0;
    const data = (json as { data?: { price?: string; bestBid?: string; bestAsk?: string } }).data;
    const last = Number(data?.price);
    const bid = Number(data?.bestBid);
    const ask = Number(data?.bestAsk);
    const mid =
      Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : Number.isFinite(last) ? last : NaN;
    if (!ok || !Number.isFinite(mid) || mid <= 0) {
      return {
        ...base,
        ok: false,
        mid: null,
        market_status: null,
        source_time: null,
        latency_ms,
        detail: `KuCoin HTTP ${status}`,
      };
    }
    const read: PublicFeedRead = {
      ...base,
      ok: true,
      mid,
      bid: Number.isFinite(bid) ? bid : mid,
      ask: Number.isFinite(ask) ? ask : mid,
      spread: Number.isFinite(ask) && Number.isFinite(bid) ? ask - bid : 0,
      market_status: 'PUBLIC_LIVE',
      source_time: new Date().toISOString(),
      latency_ms,
      detail: `KuCoin ${symbol} mid=${mid}`,
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

export async function readBinanceUs(epic: string): Promise<PublicFeedRead> {
  const sender_id = 'binance-us';
  const name = 'Binance.US (public)';
  const t0 = Date.now();
  const symbol = epicToBinanceUsSymbol(epic);
  const base = {
    sender_id,
    name,
    kind: 'binance_us' as const,
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
      detail: 'N/A · Binance.US has no mapping for this epic',
    };
  }
  const cacheKey = `${sender_id}:${symbol}`;
  const cached = fromCache(cacheKey);
  if (cached) return { ...cached, epic };
  try {
    const { ok, status, json } = await fetchJson(
      `https://api.binance.us/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`
    );
    const latency_ms = Date.now() - t0;
    const price = Number((json as { price?: string }).price);
    if (!ok || !Number.isFinite(price) || price <= 0) {
      return {
        ...base,
        ok: false,
        mid: null,
        market_status: null,
        source_time: null,
        latency_ms,
        detail: `Binance.US HTTP ${status}`,
      };
    }
    const read: PublicFeedRead = {
      ...base,
      ok: true,
      mid: price,
      bid: price,
      ask: price,
      spread: 0,
      market_status: 'PUBLIC_LIVE',
      source_time: new Date().toISOString(),
      latency_ms,
      detail: `Binance.US ${symbol}=${price}`,
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

export async function readCoinGecko(epic: string): Promise<PublicFeedRead> {
  const sender_id = 'coingecko';
  const name = 'CoinGecko (public)';
  const t0 = Date.now();
  const id = epicToCoinGeckoId(epic);
  const base = {
    sender_id,
    name,
    kind: 'coingecko' as const,
    epic,
    bid: null as number | null,
    ask: null as number | null,
    spread: null as number | null,
  };
  if (!id) {
    return {
      ...base,
      ok: false,
      mid: null,
      market_status: null,
      source_time: null,
      latency_ms: Date.now() - t0,
      detail: 'N/A · CoinGecko has no mapping for this epic',
    };
  }
  const cacheKey = `${sender_id}:${id}`;
  const cached = fromCache(cacheKey);
  if (cached) return { ...cached, epic };
  try {
    const { ok, status, json } = await fetchJson(
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`
    );
    const latency_ms = Date.now() - t0;
    const price = Number((json as Record<string, { usd?: number }>)?.[id]?.usd);
    if (!ok || !Number.isFinite(price) || price <= 0) {
      return {
        ...base,
        ok: false,
        mid: null,
        market_status: null,
        source_time: null,
        latency_ms,
        detail: `CoinGecko HTTP ${status}`,
      };
    }
    const read: PublicFeedRead = {
      ...base,
      ok: true,
      mid: price,
      bid: price,
      ask: price,
      spread: 0,
      market_status: 'PUBLIC_LIVE',
      source_time: new Date().toISOString(),
      latency_ms,
      detail: `CoinGecko ${id}=${price}`,
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

export async function readBitstamp(epic: string): Promise<PublicFeedRead> {
  const sender_id = 'bitstamp';
  const name = 'Bitstamp (public)';
  const t0 = Date.now();
  const pair = epicToBitstampPair(epic);
  const base = {
    sender_id,
    name,
    kind: 'bitstamp' as const,
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
      detail: 'N/A · Bitstamp has no mapping for this epic',
    };
  }
  const cacheKey = `${sender_id}:${pair}`;
  const cached = fromCache(cacheKey);
  if (cached) return { ...cached, epic };
  try {
    const { ok, status, json } = await fetchJson(`https://www.bitstamp.net/api/v2/ticker/${pair}/`);
    const latency_ms = Date.now() - t0;
    const last = Number((json as { last?: string }).last);
    const bid = Number((json as { bid?: string }).bid);
    const ask = Number((json as { ask?: string }).ask);
    const mid =
      Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : Number.isFinite(last) ? last : NaN;
    if (!ok || !Number.isFinite(mid) || mid <= 0) {
      return {
        ...base,
        ok: false,
        mid: null,
        market_status: null,
        source_time: null,
        latency_ms,
        detail: `Bitstamp HTTP ${status}`,
      };
    }
    const ts = Number((json as { timestamp?: string }).timestamp);
    const source_time = Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : new Date().toISOString();
    const read: PublicFeedRead = {
      ...base,
      ok: true,
      mid,
      bid: Number.isFinite(bid) ? bid : mid,
      ask: Number.isFinite(ask) ? ask : mid,
      spread: Number.isFinite(ask) && Number.isFinite(bid) ? ask - bid : 0,
      market_status: 'PUBLIC_LIVE',
      source_time,
      latency_ms,
      detail: `Bitstamp ${pair} mid=${mid}`,
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
    readGoldApi(epic),
    readFawazFxLive(epic),
    readCoinbaseSpot(epic),
    readKrakenSpot(epic),
    readKucoinSpot(epic),
    readBinanceUs(epic),
    readCoinGecko(epic),
    readBitstamp(epic),
  ]);
}

/** Clear cache — tests only. */
export function clearPublicFeedCache() {
  cache.clear();
}
