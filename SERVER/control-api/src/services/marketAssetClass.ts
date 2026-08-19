/**
 * Detect tradable asset class from Capital epic + display name.
 * Shared by public feed mapping and cross-market influence.
 */

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
  | 'unknown';

function blob(epic: string, displayName = ''): string {
  return `${epic} ${displayName}`.toUpperCase();
}

export function detectMarketClass(epic: string, displayName = ''): MarketAssetClass {
  const b = blob(epic, displayName);

  if (/(^|[^A-Z])XAU|GOLD/.test(b) || /\bGOLD\b/.test(b)) return 'gold';
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

  if (/JP225|JPN225|NIKKEI|HK50|HSI|AUS200|ASX|CN50|CHINA/.test(b)) return 'index_asia';

  const majors = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];
  for (const a of majors) {
    for (const b2 of majors) {
      if (a !== b2 && b.includes(a + b2)) return 'fx';
    }
  }
  if (/DXY|DOLLAR INDEX/.test(b)) return 'fx';

  return 'unknown';
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
    default:
      return ['US500', 'EURUSD', 'XAU', 'GOLD', 'OIL', 'BTC'];
  }
}

export function crossMarketNeedles(epic: string, displayName = ''): string[] {
  const cls = detectMarketClass(epic, displayName);
  const needles = crossMarketNeedlesForClass(cls);
  const self = epic.toUpperCase();
  return needles.filter((n) => !self.includes(n));
}
