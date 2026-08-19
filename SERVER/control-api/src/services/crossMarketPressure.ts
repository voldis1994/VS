/**
 * Cross-market pressure on the selected EPIC.
 * Example: trading gold → USD / oil / silver / index moves count as influence,
 * not only extra gold feeds (Yahoo vs Capital vs Aurum).
 */

import {
  crossMarketNeedles,
  detectMarketClass,
  type MarketAssetClass,
} from './marketAssetClass.js';

export type RelatedQuote = {
  epic: string;
  display_name?: string;
  mid: number;
  change: number | null;
};

export type CrossMarketPressure = {
  target: string;
  side: 'BUY' | 'SELL' | null;
  pressure: number;
  against: boolean;
  detail: string;
  refs: string[];
  asset_class?: MarketAssetClass;
};

const lastMid = new Map<string, number>();

export function noteMarketMid(epic: string, mid: number): number | null {
  const key = String(epic || '').trim().toUpperCase();
  if (!key || !Number.isFinite(mid) || mid <= 0) return null;
  const prev = lastMid.get(key);
  lastMid.set(key, mid);
  if (prev == null || prev <= 0) return null;
  return mid - prev;
}

export function resetCrossMarketForTests(): void {
  lastMid.clear();
}

/** Capital catalog ILIKE needles for related instruments. */
export function relatedSearchNeedles(epic: string, displayName = ''): string[] {
  return crossMarketNeedles(epic, displayName);
}

function relBlob(s: string): string {
  return s.toUpperCase();
}

function weightForRelated(targetClass: MarketAssetClass, targetBlob: string, relatedBlob: string): number {
  const t = relBlob(targetBlob);
  const r = relBlob(relatedBlob);

  if (targetClass === 'gold' && /XAU|GOLD/.test(r)) return 0;
  if (targetClass === 'silver' && /XAG|SILVER/.test(r)) return 0;
  if (targetClass === 'crypto' && /BTC/.test(t) && /BTC/.test(r)) return 0;
  if (targetClass === 'crypto' && /ETH/.test(t) && /ETH/.test(r)) return 0;

  switch (targetClass) {
    case 'gold':
      if (/XAG|SILVER/.test(r)) return 0.35;
      if (/OIL|BRENT|WTI/.test(r)) return 0.2;
      if (/US500|NAS|US100|US30/.test(r)) return 0.15;
      if (/EURUSD|GBPUSD|AUDUSD|NZDUSD/.test(r)) return 0.25;
      if (/DXY|DOLLAR|USDJPY|USDCHF/.test(r)) return -0.3;
      break;
    case 'silver':
      if (/XAU|GOLD/.test(r)) return 0.4;
      if (/OIL|BRENT|WTI/.test(r)) return 0.15;
      if (/US500|NAS/.test(r)) return 0.12;
      if (/EURUSD/.test(r)) return 0.2;
      if (/DXY|USDJPY/.test(r)) return -0.25;
      break;
    case 'platinum':
    case 'palladium':
      if (/XAU|GOLD/.test(r)) return 0.35;
      if (/XAG|SILVER/.test(r)) return 0.25;
      if (/OIL/.test(r)) return 0.15;
      if (/EURUSD/.test(r)) return 0.15;
      break;
    case 'oil_wti':
    case 'oil_brent':
      if (/US500|NAS|US100/.test(r)) return 0.25;
      if (/XAU|GOLD/.test(r)) return 0.15;
      if (/EURUSD|DXY/.test(r)) return 0.2;
      if (/NATGAS|NGAS/.test(r)) return 0.15;
      if (targetClass === 'oil_wti' && /BRENT|UKOIL/.test(r)) return 0.3;
      if (targetClass === 'oil_brent' && /WTI|USOIL/.test(r)) return 0.3;
      break;
    case 'natgas':
      if (/OIL|WTI|BRENT/.test(r)) return 0.3;
      if (/US500|NAS/.test(r)) return 0.15;
      if (/EURUSD/.test(r)) return 0.15;
      break;
    case 'fx':
      if (/DXY|DOLLAR/.test(r)) return 0.35;
      if (/EURUSD|GBPUSD|USDJPY|USDCHF|AUDUSD/.test(r)) return 0.25;
      if (/US500|NAS|US100/.test(r)) return 0.2;
      if (/XAU|GOLD/.test(r)) return 0.15;
      if (/OIL|BRENT|WTI/.test(r)) return 0.1;
      break;
    case 'index_us':
      if (/US500|NAS|US100|US30|DOW|SPX/.test(r)) return 0.3;
      if (/XAU|GOLD/.test(r)) return -0.1;
      if (/OIL|BRENT|WTI/.test(r)) return 0.15;
      if (/EURUSD|USDJPY/.test(r)) return 0.15;
      if (/BTC|ETH/.test(r)) return 0.12;
      break;
    case 'index_eu':
      if (/GER40|DAX|UK100|FTSE|EU50|STOXX/.test(r)) return 0.3;
      if (/US500|NAS/.test(r)) return 0.25;
      if (/EURUSD/.test(r)) return 0.2;
      if (/XAU|GOLD/.test(r)) return -0.08;
      break;
    case 'index_asia':
      if (/JP225|NIKKEI|HK50|HSI|AUS200/.test(r)) return 0.3;
      if (/US500|NAS/.test(r)) return 0.2;
      if (/USDJPY/.test(r)) return 0.25;
      if (/XAU|GOLD/.test(r)) return -0.08;
      break;
    case 'crypto':
      if (/BTC/.test(r) && !/BTC/.test(t)) return 0.35;
      if (/ETH/.test(r) && !/ETH/.test(t)) return 0.35;
      if (/US500|NAS|US100/.test(r)) return 0.2;
      if (/XAU|GOLD/.test(r)) return 0.1;
      if (/EURUSD|DXY/.test(r)) return 0.12;
      break;
    default:
      if (/US500|NAS/.test(r)) return 0.15;
      if (/EURUSD|XAU|GOLD|OIL/.test(r)) return 0.1;
      break;
  }
  return 0.08;
}

export function computeCrossMarketPressure(input: {
  targetEpic: string;
  targetName?: string;
  side: 'BUY' | 'SELL' | null;
  related: RelatedQuote[];
}): CrossMarketPressure {
  const target = String(input.targetEpic || '').trim();
  const blob = `${target} ${input.targetName || ''}`;
  const assetClass = detectMarketClass(target, input.targetName);
  const refs: string[] = [];
  let num = 0;
  let den = 0;
  for (const q of input.related) {
    if (!q || q.mid == null || !Number.isFinite(q.mid) || q.mid <= 0) continue;
    const relBlob = `${q.epic} ${q.display_name || ''}`;
    if (String(q.epic).toUpperCase() === target.toUpperCase()) continue;
    const w = weightForRelated(assetClass, blob, relBlob);
    if (w === 0) continue;
    const ch = q.change;
    if (ch == null || !Number.isFinite(ch) || q.mid <= 0) continue;
    const ret = ch / q.mid;
    num += w * ret;
    den += Math.abs(w);
    refs.push(`${q.epic} ${ret >= 0 ? '+' : ''}${(ret * 10000).toFixed(1)}bp`);
  }
  const raw = den > 0 ? num / den : 0;
  const pressure = Math.max(-1, Math.min(1, raw * 8000));
  const against =
    input.side === 'BUY'
      ? pressure < -0.25
      : input.side === 'SELL'
        ? pressure > 0.25
        : false;
  const clsLabel = assetClass !== 'unknown' ? `${assetClass} · ` : '';
  const detail =
    refs.length === 0
      ? `NO CROSS-MARKET DATA · ${clsLabel}pull Capital markets for related instruments`
      : `${clsLabel}pressure ${pressure.toFixed(2)} · ${against ? 'AGAINST' : 'ALIGNED'} ${input.side || 'FLAT'} · ${refs.slice(0, 6).join(', ')}`;
  return { target, side: input.side, pressure, against, detail, refs, asset_class: assetClass };
}
