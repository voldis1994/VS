/**
 * Guard against Capital quote lag vs fresher price truth (#136 speaker).
 * Classic fail: public/10s already dropped, Capital still high → BUY into dump.
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

const DEFAULT_MIN_REL = 0.0012; // 0.12% ≈ ~5pts on Gold 4350

function relMove(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return 0;
  return (to - from) / Math.abs(from);
}

/** Block when fresher refs already moved against the intended side. */
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

  if (direction === 'BUY') {
    let worst = usable[0]!;
    for (const r of usable) {
      if (r.mid < worst.mid) worst = r;
    }
    const rel = relMove(capitalMid, worst.mid);
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
    let worst = usable[0]!;
    for (const r of usable) {
      if (r.mid > worst.mid) worst = r;
    }
    const rel = relMove(capitalMid, worst.mid);
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

/**
 * Capital fake extreme vs public-near (#136).
 * BUY blocked: Capital alone below public (fake dip).
 * SELL blocked: Capital alone above public (fake rally).
 * No public → allow (do not miss Capital-only moves).
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

  if (direction === 'BUY' && rel <= -minRel) {
    return {
      block: true,
      reason: `CAPITAL FAKE DIP · BUY blocked — Capital ${capitalMid.toFixed(2)} below public ${publicMed.toFixed(2)} (${(Math.abs(rel) * 100).toFixed(3)}%)`,
      capital_mid: capitalMid,
      lead_mid: publicMed,
      lead_label: 'public-near median',
      rel,
    };
  }
  if (direction === 'SELL' && rel >= minRel) {
    return {
      block: true,
      reason: `CAPITAL FAKE SPIKE · SELL blocked — Capital ${capitalMid.toFixed(2)} above public ${publicMed.toFixed(2)} (${(Math.abs(rel) * 100).toFixed(3)}%)`,
      capital_mid: capitalMid,
      lead_mid: publicMed,
      lead_label: 'public-near median',
      rel,
    };
  }
  return {
    block: false,
    reason: 'Capital aligned with public-near',
    capital_mid: capitalMid,
    lead_mid: publicMed,
    lead_label: 'public-near median',
    rel,
  };
}

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
