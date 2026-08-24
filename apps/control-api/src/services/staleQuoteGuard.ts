/**
 * Guard against Capital quote lag vs fresher price truth.
 *
 * Classic fail: chart / public / 10s OHLC already dropped, but Capital BUY
 * button still shows the pre-drop ask — robot would open BUY into the dump.
 */

export type PriceRef = { label: string; mid: number };

export type StaleQuoteVerdict = {
  block: boolean;
  reason: string;
  capital_mid: number;
  lead_mid: number | null;
  lead_label: string | null;
  rel: number;
};

const DEFAULT_MIN_REL = 0.0012; // 0.12% ≈ ~5pts on Gold 4350 (screenshot was ~8pts)

function relMove(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return 0;
  return (to - from) / Math.abs(from);
}

/**
 * If fresher refs have already moved against the intended side while Capital
 * quote has not caught up — advisory only; never block entry.
 */
export function detectStaleQuoteAdverse(
  direction: 'BUY' | 'SELL',
  capitalMid: number | null | undefined,
  refs: PriceRef[],
  opts?: { minRel?: number }
): StaleQuoteVerdict {
  const minRel = opts?.minRel ?? DEFAULT_MIN_REL;
  if (capitalMid == null || !Number.isFinite(capitalMid)) {
    return {
      block: false,
      reason: 'no capital mid',
      capital_mid: NaN,
      lead_mid: null,
      lead_label: null,
      rel: 0,
    };
  }

  const usable = refs.filter((r) => r.mid != null && Number.isFinite(r.mid));
  if (usable.length === 0) {
    return {
      block: false,
      reason: 'no fresher refs',
      capital_mid: capitalMid,
      lead_mid: null,
      lead_label: null,
      rel: 0,
    };
  }

  let worst = usable[0]!;
  let rel = 0;
  if (direction === 'BUY') {
    for (const r of usable) {
      if (r.mid < worst.mid) worst = r;
    }
    rel = relMove(capitalMid, worst.mid);
  } else {
    for (const r of usable) {
      if (r.mid > worst.mid) worst = r;
    }
    rel = relMove(capitalMid, worst.mid);
  }

  // Never block — note only
  void minRel;
  return {
    block: false,
    reason:
      Math.abs(rel) >= minRel
        ? `STALE NOTE · Capital ${capitalMid.toFixed(2)} vs ${worst.label} ${worst.mid.toFixed(2)} (allow)`
        : 'capital quote aligned with fresher refs',
    capital_mid: capitalMid,
    lead_mid: worst.mid,
    lead_label: worst.label,
    rel,
  };
}

/**
 * Capital vs public extreme — advisory only; never block entry.
 */
export function detectCapitalIsolatedExtreme(
  direction: 'BUY' | 'SELL',
  capitalMid: number | null | undefined,
  publicNearMids: number[],
  opts?: { minRel?: number }
): StaleQuoteVerdict {
  const minRel = opts?.minRel ?? 0.0008;
  if (capitalMid == null || !Number.isFinite(capitalMid)) {
    return {
      block: false,
      reason: 'no capital mid',
      capital_mid: NaN,
      lead_mid: null,
      lead_label: null,
      rel: 0,
    };
  }
  const pubs = publicNearMids.filter((m) => Number.isFinite(m));
  if (pubs.length === 0) {
    return {
      block: false,
      reason: 'no public-near feeds — Capital-only OK',
      capital_mid: capitalMid,
      lead_mid: null,
      lead_label: null,
      rel: 0,
    };
  }
  const sorted = [...pubs].sort((a, b) => a - b);
  const midIdx = Math.floor(sorted.length / 2);
  const publicMed =
    sorted.length % 2 === 1
      ? sorted[midIdx]!
      : (sorted[midIdx - 1]! + sorted[midIdx]!) / 2;
  const rel = relMove(publicMed, capitalMid);
  void direction;
  void minRel;
  return {
    block: false,
    reason: 'Capital advisory vs public-near (never block)',
    capital_mid: capitalMid,
    lead_mid: publicMed,
    lead_label: 'public-near median',
    rel,
  };
}

/** Build refs from multi-feed near legs + 10s OHLC closes. */
export function buildFresherRefs(input: {
  publicNearMids?: Array<{ name: string; mid: number }>;
  ohlcClose?: number | null;
  formingClose?: number | null;
}): PriceRef[] {
  const refs: PriceRef[] = [];
  for (const p of input.publicNearMids || []) {
    if (Number.isFinite(p.mid)) refs.push({ label: p.name, mid: p.mid });
  }
  if (input.ohlcClose != null && Number.isFinite(input.ohlcClose)) {
    refs.push({ label: '10s OHLC close', mid: input.ohlcClose });
  }
  if (input.formingClose != null && Number.isFinite(input.formingClose)) {
    refs.push({ label: '10s forming', mid: input.formingClose });
  }
  return refs;
}
