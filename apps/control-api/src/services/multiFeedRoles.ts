/**
 * Multi-feed role separation:
 * EXECUTION = Capital bid/ask
 * CONFIRMATION = other live market feeds
 * REFERENCE = futures/index/public proxy (not executable zero-spread)
 */

export type FeedRole = 'EXECUTION' | 'CONFIRMATION' | 'REFERENCE';

export type RoleTaggedQuote = {
  role: FeedRole;
  label: string;
  bid?: number | null;
  ask?: number | null;
  mid: number;
  spread?: number | null;
};

export function tagExecutionQuote(input: {
  label?: string;
  bid?: number | null;
  ask?: number | null;
  mid: number;
}): RoleTaggedQuote {
  const spread =
    input.bid != null && input.ask != null && Number.isFinite(input.bid) && Number.isFinite(input.ask)
      ? Math.max(0, input.ask - input.bid)
      : null;
  return {
    role: 'EXECUTION',
    label: input.label || 'Capital',
    bid: input.bid,
    ask: input.ask,
    mid: input.mid,
    spread,
  };
}

export function tagConfirmationQuote(label: string, mid: number): RoleTaggedQuote {
  return { role: 'CONFIRMATION', label, mid, spread: null };
}

export function tagReferenceQuote(label: string, mid: number): RoleTaggedQuote {
  return { role: 'REFERENCE', label, mid, spread: null };
}

/** Reference must never look like executable zero-spread. */
export function isExecutableQuote(q: RoleTaggedQuote): boolean {
  if (q.role === 'REFERENCE') return false;
  if (q.role === 'EXECUTION') {
    return q.bid != null && q.ask != null && q.bid > 0 && q.ask > q.bid;
  }
  return false;
}

export function referenceAgreement(
  executionMid: number,
  refs: RoleTaggedQuote[],
  maxRel = 0.004
): { agreement: number; detail: string } {
  const usable = refs.filter(
    (r) =>
      (r.role === 'CONFIRMATION' || r.role === 'REFERENCE') &&
      Number.isFinite(r.mid) &&
      r.mid > 0
  );
  if (!usable.length || !Number.isFinite(executionMid) || executionMid <= 0) {
    return { agreement: 0.5, detail: 'no confirmation refs' };
  }
  let ok = 0;
  for (const r of usable) {
    const rel = Math.abs(r.mid - executionMid) / Math.abs(executionMid);
    if (rel <= maxRel) ok += 1;
  }
  const agreement = ok / usable.length;
  return {
    agreement,
    detail: `${ok}/${usable.length} refs within ${(maxRel * 100).toFixed(2)}%`,
  };
}
