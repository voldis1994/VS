/**
 * Detect tradable asset class from Capital epic + display name.
 * Shared by public feed mapping and cross-market influence.
 */

import { isGoldEpic } from './publicInternetFeeds.js';
import {
  resolveCapitalInstrument,
  crossMarketNeedlesResolved,
  epicAliasesForCanonical,
  type CanonicalInstrument,
} from './capitalInstrumentRegistry.js';

export type MarketAssetClass =
  | 'gold'
  | 'silver'
  | 'platinum'
  | 'palladium'
  | 'oil_wti'
  | 'oil_brent'
  | 'natgas'
  | 'fx'
  | 'index_us'
  | 'index_eu'
  | 'index_asia'
  | 'crypto'
  | 'equity'
  | 'unknown';

function blob(epic: string, displayName = ''): string {
  return `${epic} ${displayName}`.toUpperCase();
}

export function detectMarketClass(epic: string, displayName = ''): MarketAssetClass {
  const resolved = resolveCapitalInstrument(epic, displayName);
  if (resolved.canonical) return resolved.asset_class;

  const b = blob(epic, displayName);

  if (isGoldEpic(epic) || /\bGOLD\b/.test(b)) return 'gold';
  if (/(^|[^A-Z])XAG|SILVER/.test(b) || /\bSILVER\b/.test(b)) return 'silver';
  if (/PLATINUM|XPT/.test(b)) return 'platinum';
  if (/PALLADIUM|XPD/.test(b)) return 'palladium';

  if (/NATGAS|NATURALGAS|NGAS|HEATINGOIL/.test(b)) return 'natgas';
  if (/BRENT|UKOIL|OIL_BRENT|OILBRENT/.test(b)) return 'oil_brent';
  if (/WTI|USOIL|CRUDE|OIL_WTI|OILCRUDE|OIL\b/.test(b)) return 'oil_wti';

  if (/BTC|BITCOIN|ETH|ETHEREUM|CRYPTO/.test(b)) return 'crypto';

  if (/US500|SPX|SP500|S&P|SNP|WALLSTREET500/.test(b)) return 'index_us';
  if (/US100|NAS100|USTECH|NASDAQ|NDX/.test(b)) return 'index_us';
  if (/US30|DJ30|DOW|DJI|WALLSTREET30/.test(b)) return 'index_us';
  if (/RUSSELL|US2000|RTY/.test(b)) return 'index_us';

  if (/GER40|DE40|DAX|FRA40|CAC|EU50|STOXX|EUROSTOXX/.test(b)) return 'index_eu';
  if (/UK100|FTSE/.test(b)) return 'index_eu';

  if (/JP225|JPN225|NIKKEI|HK50|HSI|AUS200|ASX200|CN50|CHINA/.test(b)) return 'index_asia';

  const majors = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];
  for (const a of majors) {
    for (const b2 of majors) {
      if (a !== b2 && b.includes(a + b2)) return 'fx';
    }
  }
  if (/DXY|DOLLAR INDEX/.test(b)) return 'fx';

  if (/LIMITED|PLC|INC|CORP|LTD|SHARES|STOCK/.test(b)) return 'equity';
  const s = normEpic(epic);
  if (s.endsWith('AU') && s.length >= 4 && s.length <= 8 && !isGoldEpic(epic)) return 'equity';

  return 'unknown';
}

function normEpic(epic: string): string {
  return String(epic || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Capital catalog ILIKE needles for cross-market related instruments. */
export function crossMarketNeedlesForClass(cls: MarketAssetClass): string[] {
  switch (cls) {
    case 'gold':
      return ['XAG', 'SILVER', 'OIL', 'BRENT', 'WTI', 'US500', 'NAS', 'US100', 'DOLLAR', 'DXY', 'EURUSD', 'USDJPY'];
    case 'silver':
      return ['XAU', 'GOLD', 'OIL', 'BRENT', 'EURUSD', 'US500', 'DXY', 'USDJPY'];
    case 'platinum':
    case 'palladium':
      return ['XAU', 'GOLD', 'XAG', 'SILVER', 'OIL', 'EURUSD', 'US500'];
    case 'oil_wti':
    case 'oil_brent':
      return ['XAU', 'GOLD', 'US500', 'NAS', 'US100', 'EURUSD', 'DXY', 'NATGAS', 'BRENT', 'WTI', 'OIL'];
    case 'natgas':
      return ['OIL', 'WTI', 'BRENT', 'US500', 'EURUSD', 'XAU'];
    case 'fx':
      return ['EURUSD', 'DXY', 'USDJPY', 'GBPUSD', 'US500', 'NAS', 'US100', 'XAU', 'GOLD', 'OIL', 'BRENT'];
    case 'index_us':
      return ['US500', 'NAS', 'US100', 'US30', 'DOW', 'XAU', 'GOLD', 'OIL', 'EURUSD', 'USDJPY', 'DXY'];
    case 'index_eu':
      return ['GER40', 'DAX', 'UK100', 'FTSE', 'US500', 'EURUSD', 'XAU', 'OIL'];
    case 'index_asia':
      return ['JP225', 'NIKKEI', 'HK50', 'US500', 'USDJPY', 'XAU', 'OIL'];
    case 'crypto':
      return ['BTC', 'ETH', 'US500', 'NAS', 'US100', 'XAU', 'EURUSD', 'DXY', 'USDJPY'];
    case 'equity':
      return ['US500', 'NAS', 'AUS200', 'EURUSD', 'USDJPY', 'XAU', 'GOLD'];
    default:
      return ['US500', 'EURUSD', 'XAU', 'GOLD', 'OIL', 'BTC'];
  }
}

export function crossMarketNeedles(epic: string, displayName = ''): string[] {
  return crossMarketNeedlesResolved(epic, displayName);
}

const CANONICAL_CROSS_EPICS: Partial<Record<CanonicalInstrument, string[]>> = {
  GOLD: ['XAGUSD', 'USOIL', 'US500', 'US100', 'EURUSD', 'USDJPY'],
  SILVER: ['GOLD', 'XAUUSD', 'USOIL', 'US500', 'EURUSD'],
  US500: ['US100', 'NAS100', 'USTEC', 'US30', 'EURUSD', 'GOLD', 'USOIL'],
  US100: ['US500', 'NAS100', 'USTEC', 'US30', 'EURUSD', 'GOLD', 'USOIL', 'BTCUSD'],
  US30: ['US500', 'US100', 'EURUSD', 'GOLD'],
  GER40: ['UK100', 'US500', 'EURUSD', 'GOLD'],
  UK100: ['GER40', 'US500', 'EURUSD', 'GOLD'],
  JP225: ['US500', 'US100', 'USDJPY', 'GOLD'],
  AUS200: ['US500', 'US100', 'USDJPY', 'GOLD'],
  ASXLTD: ['US500', 'US100', 'NAS100', 'AUS200', 'EURUSD', 'GOLD'],
  EURUSD: ['US500', 'US100', 'GOLD', 'USOIL', 'GBPUSD'],
  GBPUSD: ['EURUSD', 'US500', 'US100', 'GOLD'],
  USDJPY: ['EURUSD', 'US500', 'US100', 'GOLD'],
  USOIL: ['UKOIL', 'US500', 'US100', 'EURUSD', 'GOLD'],
  UKOIL: ['USOIL', 'US500', 'US100', 'EURUSD', 'GOLD'],
  NATGAS: ['USOIL', 'UKOIL', 'US500', 'EURUSD', 'GOLD'],
  BTCUSD: ['ETHUSD', 'US500', 'US100', 'GOLD', 'EURUSD'],
  ETHUSD: ['BTCUSD', 'US500', 'US100', 'GOLD', 'EURUSD'],
};

/** Concrete Capital epics for public-feed cross-market when catalog is empty. */
export function canonicalRelatedEpics(epic: string, displayName = ''): string[] {
  const resolved = resolveCapitalInstrument(epic, displayName);
  const self = normEpic(epic);
  const pool =
    (resolved.canonical && CANONICAL_CROSS_EPICS[resolved.canonical]) ||
    ['US500', 'US100', 'EURUSD', 'GOLD', 'USOIL'];
  return pool.filter((s) => {
    const n = normEpic(s);
    return n && n !== self && !self.includes(n) && !n.includes(self);
  });
}

export { resolveCapitalInstrument, epicAliasesForCanonical } from './capitalInstrumentRegistry.js';
