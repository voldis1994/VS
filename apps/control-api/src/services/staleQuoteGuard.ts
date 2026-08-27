/**
 * Capital LIVE is primary / source of truth for STALE GUARD.
 * Cross-feed refs are optional confirmation/evidence — missing or stale
 * public refs must NOT block entry when Capital bid+ask mid is valid.
 * Adverse move vs fresher refs may still flag Capital lag when refs exist.
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

/** Relative move threshold — volatility-aware when ATR known. */
export function staleRelThreshold(
  capitalMid: number,
  atr?: number | null,
  fallbackRel = 0.0012
): number {
  if (atr != null && atr > 0 && Number.isFinite(capitalMid) && capitalMid !== 0) {
    return Math.max(atr / Math.abs(capitalMid) * 0.35, fallbackRel * 0.5);
  }
  return fallbackRel;
}

function relMove(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return 0;
  return (to - from) / Math.abs(from);
}

/**
 * Detect Capital lag vs optional fresher confirmation feeds.
 * - Capital mid UNKNOWN → BLOCK
 * - No fresher refs → ALLOW (Capital primary; cross-feed not mandatory)
 * - Adverse fresher refs → BLOCK (evidence Capital quote already moved against)
 */
export function detectStaleQuoteAdverse(
  direction: 'BUY' | 'SELL',
  capitalMid: number | null | undefined,
  refs: PriceRef[],
  opts?: { minRel?: number; atr?: number | null; requireRefs?: boolean }
): StaleQuoteVerdict {
  // Capital-primary: cross-feed confirmation is optional unless explicitly required.
  const requireRefs = opts?.requireRefs === true;
  if (capitalMid == null || !Number.isFinite(capitalMid)) {
    return {
      block: true,
      reason: 'STALE GUARD · capital mid UNKNOWN · NO ENTRY',
      capital_mid: NaN,
      lead_mid: null,
      lead_label: null,
      rel: 0,
    };
  }

  const minRel = opts?.minRel ?? staleRelThreshold(capitalMid, opts?.atr);
  const usable = refs.filter((r) => r.mid != null && Number.isFinite(r.mid));
  if (usable.length === 0) {
    return {
      block: requireRefs,
      reason: requireRefs
        ? 'STALE GUARD · cross-feed confirmation required · no fresher refs · NO ENTRY'
        : 'STALE GUARD · Capital primary · no fresher refs · continue',
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

export function detectCapitalIsolatedExtreme(
  direction: 'BUY' | 'SELL',
  capitalMid: number | null | undefined,
  publicNearMids: number[],
  opts?: { minRel?: number; atr?: number | null; requirePublic?: boolean }
): StaleQuoteVerdict {
  const requirePublic = opts?.requirePublic === true;
  if (capitalMid == null || !Number.isFinite(capitalMid)) {
    return {
      block: true,
      reason: 'capital mid UNKNOWN',
      capital_mid: NaN,
      lead_mid: null,
      lead_label: null,
      rel: 0,
    };
  }
  const minRel = opts?.minRel ?? staleRelThreshold(capitalMid, opts?.atr, 0.0008);
  const pubs = publicNearMids.filter((m) => Number.isFinite(m));
  if (pubs.length === 0) {
    return {
      block: requirePublic,
      reason: requirePublic
        ? 'public-near confirmation required · NONE · NO ENTRY'
        : 'no public-near feeds · Capital-only allowed',
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
