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

const DEFAULT_MIN_REL = 0.0012; // 0.12% ≈ ~5pts on Gold 4350 (screenshot was ~8pts)
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
 * BUY if ≥2 near feeds are already above Capital; SELL if already below.
 * Distant venue basis is ignored (same band as the adverse guard).
 */
export function detectCapitalLagLead(
  capitalMid: number | null | undefined,
  refs: PriceRef[],
  opts?: { minRel?: number; maxBasisRel?: number; minFeeds?: number }
): CapitalLagLead {
  const minRel = opts?.minRel ?? DEFAULT_MIN_REL;
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

  const above = vote.filter((r) => relMove(capitalMid, r.mid) >= minRel);
  const below = vote.filter((r) => relMove(capitalMid, r.mid) <= -minRel);
  if (above.length >= minFeeds && above.length > below.length) {
    const leadMid = median(above.map((r) => r.mid));
    const rel = relMove(capitalMid, leadMid);
    return {
      hit: true,
      direction: 'BUY',
      reason: `LAG CAPITAL · BUY · ${above.length} feeds already ${leadMid.toFixed(2)} vs Capital ${capitalMid.toFixed(2)} (+${(rel * 100).toFixed(3)}%)`,
      capital_mid: capitalMid,
      lead_mid: leadMid,
      lead_count: above.length,
      rel,
    };
  }
  if (below.length >= minFeeds && below.length > above.length) {
    const leadMid = median(below.map((r) => r.mid));
    const rel = relMove(capitalMid, leadMid);
    return {
      hit: true,
      direction: 'SELL',
      reason: `LAG CAPITAL · SELL · ${below.length} feeds already ${leadMid.toFixed(2)} vs Capital ${capitalMid.toFixed(2)} (−${(Math.abs(rel) * 100).toFixed(3)}%)`,
      capital_mid: capitalMid,
      lead_mid: leadMid,
      lead_count: below.length,
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
  const minRel = opts?.minRel ?? DEFAULT_MIN_REL;
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
