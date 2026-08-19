/**
 * Capital.com epic ↔ canonical instrument ↔ Yahoo ↔ display name.
 * Single source of truth so US100/NAS100/USTEC and ASX Limited/AUS200 never mix.
 */

import type { MarketAssetClass } from './marketAssetClass.js';

export type CanonicalInstrument =
  | 'GOLD'
  | 'SILVER'
  | 'XAUUSD'
  | 'XAGUSD'
  | 'EURUSD'
  | 'GBPUSD'
  | 'USDJPY'
  | 'USDCHF'
  | 'AUDUSD'
  | 'USDCAD'
  | 'NZDUSD'
  | 'US500'
  | 'US100'
  | 'US30'
  | 'GER40'
  | 'UK100'
  | 'JP225'
  | 'AUS200'
  | 'USOIL'
  | 'UKOIL'
  | 'NATGAS'
  | 'BTCUSD'
  | 'ETHUSD'
  | 'ASXLTD';

export type ResolvedInstrument = {
  canonical: CanonicalInstrument | null;
  asset_class: MarketAssetClass;
  yahoo_symbol: string | null;
  /** Preferred Capital.com display label */
  label: string;
  /** Epic is consistent with display_name (false = warn in logs/UI) */
  identity_ok: boolean;
  identity_note?: string;
};

type RegistryRow = {
  canonical: CanonicalInstrument;
  asset_class: MarketAssetClass;
  label: string;
  yahoo: string | null;
  /** Normalized epic tokens Capital uses for this instrument */
  epics: string[];
  /** Display-name substrings (uppercase) that identify this instrument */
  display_needles: string[];
};

function normEpic(epic: string): string {
  return String(epic || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function normBlob(epic: string, displayName = ''): string {
  return `${epic} ${displayName}`.toUpperCase();
}

/** Capital.com major markets — epics + display names aligned. */
export const CAPITAL_INSTRUMENT_REGISTRY: RegistryRow[] = [
  {
    canonical: 'GOLD',
    asset_class: 'gold',
    label: 'Gold',
    yahoo: 'GC=F',
    epics: ['GOLD', 'XAUUSD', 'XAUAUD', 'XAUEUR', 'XAU'],
    display_needles: ['GOLD', 'XAU/USD', 'XAU USD'],
  },
  {
    canonical: 'SILVER',
    asset_class: 'silver',
    label: 'Silver',
    yahoo: 'SI=F',
    epics: ['SILVER', 'XAGUSD', 'XAGAUD', 'XAG'],
    display_needles: ['SILVER', 'XAG'],
  },
  {
    canonical: 'US500',
    asset_class: 'index_us',
    label: 'US 500 / S&P 500',
    yahoo: '^GSPC',
    epics: ['US500', 'SPX500', 'SP500', 'US500CASH', 'WALLSTREET500'],
    display_needles: ['US 500', 'US500', 'S&P', 'SP 500', 'S&P 500', 'WALL STREET 500'],
  },
  {
    canonical: 'US100',
    asset_class: 'index_us',
    label: 'US Tech 100 / Nasdaq 100',
    yahoo: '^NDX',
    epics: ['US100', 'NAS100', 'USTEC', 'USTECH', 'NDX100', 'US100CASH'],
    display_needles: [
      'US TECH 100',
      'US100',
      'NAS100',
      'USTEC',
      'NASDAQ 100',
      'NASDAQ100',
      'NAS 100',
    ],
  },
  {
    canonical: 'US30',
    asset_class: 'index_us',
    label: 'US Wall Street 30 / Dow Jones',
    yahoo: '^DJI',
    epics: ['US30', 'DJ30', 'WALLSTREET30', 'US30CASH'],
    display_needles: ['US 30', 'US30', 'DOW JONES', 'WALL STREET 30', 'DJIA'],
  },
  {
    canonical: 'GER40',
    asset_class: 'index_eu',
    label: 'Germany 40 / DAX',
    yahoo: '^GDAXI',
    epics: ['GER40', 'DE40', 'DAX40', 'GERMANY40'],
    display_needles: ['GER40', 'GERMANY 40', 'DAX'],
  },
  {
    canonical: 'UK100',
    asset_class: 'index_eu',
    label: 'UK 100 / FTSE',
    yahoo: '^FTSE',
    epics: ['UK100', 'FTSE100'],
    display_needles: ['UK 100', 'UK100', 'FTSE 100', 'FTSE100'],
  },
  {
    canonical: 'JP225',
    asset_class: 'index_asia',
    label: 'Japan 225 / Nikkei',
    yahoo: '^N225',
    epics: ['JP225', 'JPN225', 'NIKKEI225'],
    display_needles: ['JP225', 'JAPAN 225', 'NIKKEI 225', 'NIKKEI225'],
  },
  {
    canonical: 'AUS200',
    asset_class: 'index_asia',
    label: 'Australia 200 / ASX 200',
    yahoo: '^AXJO',
    epics: ['AUS200', 'ASX200', 'AU200'],
    display_needles: ['AUS200', 'ASX 200', 'ASX200', 'AUSTRALIA 200'],
  },
  {
    canonical: 'ASXLTD',
    asset_class: 'equity',
    label: 'ASX Limited (share)',
    yahoo: 'ASX.AX',
    epics: ['ASXAU', 'ASX-AU', 'ASXLTD'],
    display_needles: ['ASX LIMITED', 'ASX LTD'],
  },
  {
    canonical: 'EURUSD',
    asset_class: 'fx',
    label: 'EUR/USD',
    yahoo: 'EURUSD=X',
    epics: ['EURUSD'],
    display_needles: ['EUR/USD', 'EURUSD'],
  },
  {
    canonical: 'GBPUSD',
    asset_class: 'fx',
    label: 'GBP/USD',
    yahoo: 'GBPUSD=X',
    epics: ['GBPUSD'],
    display_needles: ['GBP/USD', 'GBPUSD'],
  },
  {
    canonical: 'USDJPY',
    asset_class: 'fx',
    label: 'USD/JPY',
    yahoo: 'USDJPY=X',
    epics: ['USDJPY'],
    display_needles: ['USD/JPY', 'USDJPY'],
  },
  {
    canonical: 'USOIL',
    asset_class: 'oil_wti',
    label: 'US Oil / WTI',
    yahoo: 'CL=F',
    epics: ['USOIL', 'OILCRUDE', 'WTI', 'CRUDEOIL'],
    display_needles: ['US OIL', 'USOIL', 'WTI', 'CRUDE OIL', 'CRUDE'],
  },
  {
    canonical: 'UKOIL',
    asset_class: 'oil_brent',
    label: 'UK Oil / Brent',
    yahoo: 'BZ=F',
    epics: ['UKOIL', 'OILBRENT', 'BRENT'],
    display_needles: ['UK OIL', 'UKOIL', 'BRENT'],
  },
  {
    canonical: 'NATGAS',
    asset_class: 'natgas',
    label: 'Natural Gas',
    yahoo: 'NG=F',
    epics: ['NATGAS', 'NATURALGAS', 'NGAS'],
    display_needles: ['NATURAL GAS', 'NATGAS', 'NGAS'],
  },
  {
    canonical: 'BTCUSD',
    asset_class: 'crypto',
    label: 'Bitcoin / BTC',
    yahoo: 'BTC-USD',
    epics: ['BTCUSD', 'BITCOIN', 'BTC'],
    display_needles: ['BITCOIN', 'BTC/USD', 'BTCUSD'],
  },
  {
    canonical: 'ETHUSD',
    asset_class: 'crypto',
    label: 'Ethereum / ETH',
    yahoo: 'ETH-USD',
    epics: ['ETHUSD', 'ETHEREUM', 'ETH'],
    display_needles: ['ETHEREUM', 'ETH/USD', 'ETHUSD'],
  },
];

const epicIndex = new Map<string, RegistryRow>();
for (const row of CAPITAL_INSTRUMENT_REGISTRY) {
  for (const e of row.epics) {
    epicIndex.set(normEpic(e), row);
  }
}

export function registryRowForEpic(epic: string): RegistryRow | null {
  return epicIndex.get(normEpic(epic)) ?? null;
}

export function registryRowForDisplay(displayName: string): RegistryRow | null {
  const b = displayName.toUpperCase();
  for (const row of CAPITAL_INSTRUMENT_REGISTRY) {
    if (row.display_needles.some((n) => b.includes(n))) return row;
  }
  return null;
}

/**
 * Resolve Capital epic + display name to canonical instrument.
 * Epic wins on conflict except ASX Limited share (ASXAU ≠ US100 ≠ AUS200).
 */
export function resolveCapitalInstrument(
  epic: string,
  displayName = '',
  category = ''
): ResolvedInstrument {
  const byEpic = registryRowForEpic(epic);
  const byDisplay = registryRowForDisplay(displayName);
  const cat = category.toLowerCase();

  // Epic is authoritative on Capital.com (US100 ≠ ASX Limited even if mislabeled in UI)
  if (byEpic) {
    const identity_ok =
      !byDisplay ||
      byDisplay.canonical === byEpic.canonical ||
      cat === 'indices' ||
      cat === 'shares';
    return {
      canonical: byEpic.canonical,
      asset_class: byEpic.asset_class,
      yahoo_symbol: byEpic.yahoo,
      label: byEpic.label,
      identity_ok,
      identity_note: !identity_ok
        ? `epic ${epic}=${byEpic.label} but display "${displayName}" looks like ${byDisplay!.label}`
        : undefined,
    };
  }

  if (byDisplay) {
    return {
      canonical: byDisplay.canonical,
      asset_class: byDisplay.asset_class,
      yahoo_symbol: byDisplay.yahoo,
      label: byDisplay.label,
      identity_ok: true,
    };
  }

  return {
    canonical: null,
    asset_class: 'unknown',
    yahoo_symbol: null,
    label: displayName || epic,
    identity_ok: true,
  };
}

/** All Capital epic aliases that map to the same canonical instrument (e.g. US100 = NAS100 = USTEC). */
export function epicAliasesForCanonical(canonical: CanonicalInstrument): string[] {
  const row = CAPITAL_INSTRUMENT_REGISTRY.find((r) => r.canonical === canonical);
  return row ? [...row.epics] : [];
}

/** Cross-market catalog search needles — epic tokens only, avoids "ASX" matching ASX Ltd when trading US100. */
export function crossMarketNeedlesForCanonical(canonical: CanonicalInstrument | null): string[] {
  switch (canonical) {
    case 'GOLD':
      return ['XAG', 'SILVER', 'OIL', 'USOIL', 'UKOIL', 'US500', 'US100', 'NAS100', 'EURUSD', 'USDJPY'];
    case 'SILVER':
      return ['GOLD', 'XAU', 'OIL', 'US500', 'US100', 'EURUSD'];
    case 'US500':
      return ['US100', 'NAS100', 'USTEC', 'US30', 'EURUSD', 'USDJPY', 'GOLD', 'USOIL'];
    case 'US100':
      return ['US500', 'NAS100', 'USTEC', 'US30', 'EURUSD', 'USDJPY', 'GOLD', 'USOIL', 'BTC'];
    case 'US30':
      return ['US500', 'US100', 'NAS100', 'EURUSD', 'GOLD'];
    case 'GER40':
    case 'UK100':
      return ['US500', 'US100', 'EURUSD', 'GOLD', 'USOIL'];
    case 'JP225':
    case 'AUS200':
      return ['US500', 'US100', 'USDJPY', 'GOLD', 'USOIL'];
    case 'ASXLTD':
      return ['US500', 'US100', 'NAS100', 'AUS200', 'EURUSD', 'AUDUSD', 'GOLD'];
    case 'EURUSD':
    case 'GBPUSD':
    case 'USDJPY':
      return ['US500', 'US100', 'NAS100', 'GOLD', 'USOIL', 'DXY'];
    case 'USOIL':
    case 'UKOIL':
      return ['US500', 'US100', 'GOLD', 'EURUSD', 'NATGAS'];
    case 'NATGAS':
      return ['USOIL', 'UKOIL', 'US500', 'EURUSD', 'GOLD'];
    case 'BTCUSD':
    case 'ETHUSD':
      return ['US500', 'US100', 'NAS100', 'GOLD', 'EURUSD'];
    default:
      return ['US500', 'US100', 'EURUSD', 'GOLD', 'USOIL'];
  }
}

export function crossMarketNeedlesResolved(epic: string, displayName = ''): string[] {
  const resolved = resolveCapitalInstrument(epic, displayName);
  const needles = crossMarketNeedlesForCanonical(resolved.canonical);
  const self = normEpic(epic);
  return needles.filter((n) => !self.includes(normEpic(n)));
}
