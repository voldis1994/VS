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
 * quote has not caught up, block the entry.
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

  // Freshest adverse extreme vs Capital
  if (direction === 'BUY') {
    // Lowest fresher mid — if already well below Capital, market dropped / Capital lagging high
    let worst = usable[0]!;
    for (const r of usable) {
      if (r.mid < worst.mid) worst = r;
    }
    const rel = relMove(capitalMid, worst.mid); // negative when ref below capital
    if (rel <= -minRel) {
      return {
        block: true,
        reason: `STALE CAPITAL · BUY blocked — ${worst.label} already ${worst.mid.toFixed(2)} while Capital ${capitalMid.toFixed(2)} (drop ${(Math.abs(rel) * 100).toFixed(3)}%)`,
        capital_mid: capitalMid,
        lead_mid: worst.mid,
        lead_label: worst.label,
        rel,
      };
    }
  } else {
    // Highest fresher mid — if already well above Capital, market rallied / Capital lagging low
    let worst = usable[0]!;
    for (const r of usable) {
      if (r.mid > worst.mid) worst = r;
    }
    const rel = relMove(capitalMid, worst.mid); // positive when ref above capital
    if (rel >= minRel) {
      return {
        block: true,
        reason: `STALE CAPITAL · SELL blocked — ${worst.label} already ${worst.mid.toFixed(2)} while Capital ${capitalMid.toFixed(2)} (rally ${(Math.abs(rel) * 100).toFixed(3)}%)`,
        capital_mid: capitalMid,
        lead_mid: worst.mid,
        lead_label: worst.label,
        rel,
      };
    }
  }

  return {
    block: false,
    reason: 'capital quote aligned with fresher refs',
    capital_mid: capitalMid,
    lead_mid: usable[0]!.mid,
    lead_label: usable[0]!.label,
    rel: relMove(capitalMid, usable[0]!.mid),
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
