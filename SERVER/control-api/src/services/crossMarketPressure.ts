/**
 * Cross-market pressure on the selected EPIC.
 * Example: trading gold → USD / oil / silver / index moves count as influence,
 * not only extra gold feeds (Yahoo vs Capital vs Aurum).
 */

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

export function relatedSearchNeedles(epic: string, displayName = ''): string[] {
  const blob = `${epic} ${displayName}`.toUpperCase();
  if (/XAU|GOLD/.test(blob)) {
    // Other instruments only — extra gold EPICs would crowd out DXY/oil/silver.
    return ['XAG', 'SILVER', 'OIL', 'BRENT', 'WTI', 'US500', 'NAS', 'US100', 'DOLLAR', 'DXY', 'EURUSD'];
  }
  if (/XAG|SILVER/.test(blob)) {
    return ['XAU', 'GOLD', 'OIL', 'EURUSD', 'US500', 'DXY'];
  }
  if (/OIL|BRENT|WTI|CRUDE/.test(blob)) {
    return ['XAU', 'GOLD', 'US500', 'EURUSD', 'DXY'];
  }
  if (/EURUSD|GBPUSD|USDJPY|DOLLAR|DXY/.test(blob)) {
    return ['EURUSD', 'DXY', 'USDJPY', 'US500', 'XAU', 'GOLD'];
  }
  if (/US500|US100|NAS|SPX|DAX|GER/.test(blob)) {
    return ['US500', 'NAS', 'US100', 'XAU', 'OIL', 'EURUSD'];
  }
  return [];
}

function weightForRelated(targetBlob: string, relatedBlob: string): number {
  const t = targetBlob.toUpperCase();
  const r = relatedBlob.toUpperCase();
  if (/XAU|GOLD/.test(t)) {
    if (/XAG|SILVER/.test(r)) return 0.35;
    if (/OIL|BRENT|WTI/.test(r)) return 0.2;
    if (/US500|NAS|US100/.test(r)) return 0.15;
    if (/EURUSD/.test(r)) return 0.25;
    if (/DXY|DOLLAR|USDJPY/.test(r)) return -0.3;
    if (/XAU|GOLD/.test(r)) return 0;
  }
  if (/XAG|SILVER/.test(t) && /XAU|GOLD/.test(r)) return 0.4;
  if (/OIL|BRENT|WTI/.test(t) && /US500|XAU/.test(r)) return 0.2;
  return 0.1;
}

export function computeCrossMarketPressure(input: {
  targetEpic: string;
  targetName?: string;
  side: 'BUY' | 'SELL' | null;
  related: RelatedQuote[];
}): CrossMarketPressure {
  const target = String(input.targetEpic || '').trim();
  const blob = `${target} ${input.targetName || ''}`;
  const refs: string[] = [];
  let num = 0;
  let den = 0;
  for (const q of input.related) {
    if (!q || q.mid == null || !Number.isFinite(q.mid) || q.mid <= 0) continue;
    const relBlob = `${q.epic} ${q.display_name || ''}`;
    if (String(q.epic).toUpperCase() === target.toUpperCase()) continue;
    const w = weightForRelated(blob, relBlob);
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
  const detail =
    refs.length === 0
      ? 'NO CROSS-MARKET DATA'
      : `pressure ${pressure.toFixed(2)} · ${against ? 'AGAINST' : 'ALIGNED'} ${input.side || 'FLAT'} · ${refs.slice(0, 6).join(', ')}`;
  return { target, side: input.side, pressure, against, detail, refs };
}
