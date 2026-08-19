/**
 * Capital quote lag vs fresher price truth.
 *
 * Adverse: chart / public / 10s OHLC already dropped, but Capital BUY button
 * still shows the pre-drop ask — do not open BUY into the dump.
 *
 * Lead (operator): if other near feeds already moved while Capital lags,
 * place the matching order on Capital — BUY when feeds are already higher
 * (Capital still cheap), SELL when feeds are already lower (Capital still dear).
 *
 * Public spot (Yahoo/Aurum) can sit 0.5–1.5% away from Capital CFD on Gold —
 * that is basis, not lag. Only refs near Capital are used.
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

const STALE_ADVERSE_MIN_REL = 0.0012; // 0.12% ≈ ~5pts — only veto on a real cluster move
/** Fill SCAN when the near-feed cluster already printed ~2pts vs Capital. */
export const LAG_SCAN_MIN_REL = 0.0005;
/** Ignore venue-basis noise (Yahoo/Aurum vs Capital CFD often 0.5–1.5% on Gold). */
const DEFAULT_MAX_BASIS_REL = 0.0035; // 0.35%
const DEFAULT_MIN_LEAD_FEEDS = 2;

function relMove(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return 0;
  return (to - from) / Math.abs(from);
}

function isCapitalLabel(label: string): boolean {
  return /capital\.com|capital_com|\bcapital\b/i.test(label);
}

function isOhlcLabel(label: string): boolean {
  return /10s|ohlc|forming/i.test(label);
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Drop 1 high + 1 low when ≥4 feeds so CoinGecko/Binance.US round numbers cannot veto. */
function trimmedMedianMid(mids: number[]): number | null {
  const xs = mids.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length >= 4) return median(xs.slice(1, -1));
  return median(xs);
}

function usableNearRefs(
  capitalMid: number,
  refs: PriceRef[],
  maxBasis: number
): PriceRef[] {
  return refs.filter((r) => {
    if (r.mid == null || !Number.isFinite(r.mid)) return false;
    if (isCapitalLabel(r.label)) return false;
    return Math.abs(relMove(capitalMid, r.mid)) <= maxBasis;
  });
}

export type CapitalLagLead = {
  hit: boolean;
  direction: 'BUY' | 'SELL' | null;
  reason: string;
  capital_mid: number;
  lead_mid: number | null;
  lead_count: number;
  rel: number;
};

/**
 * Other feeds already printed a move Capital has not caught — enter WITH the lead.
 * Uses the trimmed median of near public feeds (not one outlier, not Yahoo basis).
 */
export function detectCapitalLagLead(
  capitalMid: number | null | undefined,
  refs: PriceRef[],
  opts?: { minRel?: number; maxBasisRel?: number; minFeeds?: number }
): CapitalLagLead {
  const minRel = opts?.minRel ?? LAG_SCAN_MIN_REL;
  const maxBasis = opts?.maxBasisRel ?? DEFAULT_MAX_BASIS_REL;
  const minFeeds = opts?.minFeeds ?? DEFAULT_MIN_LEAD_FEEDS;
  const empty = (reason: string): CapitalLagLead => ({
    hit: false,
    direction: null,
    reason,
    capital_mid: capitalMid != null && Number.isFinite(capitalMid) ? capitalMid : NaN,
    lead_mid: null,
    lead_count: 0,
    rel: 0,
  });
  if (capitalMid == null || !Number.isFinite(capitalMid)) return empty('no capital mid');

  const near = usableNearRefs(capitalMid, refs, maxBasis);
  const publicNear = near.filter((r) => !isOhlcLabel(r.label));
  const vote = publicNear.length >= minFeeds ? publicNear : near;
  if (vote.length < minFeeds) return empty('need ≥2 near feeds besides Capital');

  const leadMid = trimmedMedianMid(vote.map((r) => r.mid));
  if (leadMid == null) return empty('no cluster mid');
  const rel = relMove(capitalMid, leadMid);
  if (rel >= minRel) {
    return {
      hit: true,
      direction: 'BUY',
      reason: `LAG CAPITAL · BUY · ${vote.length} feeds already ${leadMid.toFixed(2)} vs Capital ${capitalMid.toFixed(2)} (+${(rel * 100).toFixed(3)}%)`,
      capital_mid: capitalMid,
      lead_mid: leadMid,
      lead_count: vote.length,
      rel,
    };
  }
  if (rel <= -minRel) {
    return {
      hit: true,
      direction: 'SELL',
      reason: `LAG CAPITAL · SELL · ${vote.length} feeds already ${leadMid.toFixed(2)} vs Capital ${capitalMid.toFixed(2)} (−${(Math.abs(rel) * 100).toFixed(3)}%)`,
      capital_mid: capitalMid,
      lead_mid: leadMid,
      lead_count: vote.length,
      rel,
    };
  }
  return empty('feeds aligned with Capital (no lag lead)');
}

/**
 * If fresher refs have already moved against the intended side while Capital
 * quote has not caught up, block the entry.
 */
export function detectStaleQuoteAdverse(
  direction: 'BUY' | 'SELL',
  capitalMid: number | null | undefined,
  refs: PriceRef[],
  opts?: { minRel?: number; maxBasisRel?: number }
): StaleQuoteVerdict {
  const minRel = opts?.minRel ?? STALE_ADVERSE_MIN_REL;
  const maxBasis = opts?.maxBasisRel ?? DEFAULT_MAX_BASIS_REL;
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

  const usable = usableNearRefs(capitalMid, refs, maxBasis);
  if (usable.length === 0) {
    return {
      block: false,
      reason: 'no near-Capital fresher refs (distant public basis ignored)',
      capital_mid: capitalMid,
      lead_mid: null,
      lead_label: null,
      rel: 0,
    };
  }

  const clusterMid = trimmedMedianMid(usable.map((r) => r.mid));
  if (clusterMid == null) {
    return {
      block: false,
      reason: 'no cluster mid',
      capital_mid: capitalMid,
      lead_mid: null,
      lead_label: null,
      rel: 0,
    };
  }
  const rel = relMove(capitalMid, clusterMid);
  if (direction === 'BUY' && rel <= -minRel) {
    return {
      block: true,
      reason: `STALE CAPITAL · BUY blocked — near feeds already ${clusterMid.toFixed(2)} while Capital ${capitalMid.toFixed(2)} (drop ${(Math.abs(rel) * 100).toFixed(3)}%)`,
      capital_mid: capitalMid,
      lead_mid: clusterMid,
      lead_label: 'near-feed cluster',
      rel,
    };
  }
  if (direction === 'SELL' && rel >= minRel) {
    return {
      block: true,
      reason: `STALE CAPITAL · SELL blocked — near feeds already ${clusterMid.toFixed(2)} while Capital ${capitalMid.toFixed(2)} (rally ${(Math.abs(rel) * 100).toFixed(3)}%)`,
      capital_mid: capitalMid,
      lead_mid: clusterMid,
      lead_label: 'near-feed cluster',
      rel,
    };
  }

  return {
    block: false,
    reason: 'capital quote aligned with fresher refs',
    capital_mid: capitalMid,
    lead_mid: clusterMid,
    lead_label: 'near-feed cluster',
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
