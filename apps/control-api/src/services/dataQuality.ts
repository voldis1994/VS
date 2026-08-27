/**
 * Quote / bar data quality — stale, duplicate, gap, timestamp validation.
 * Fetch time ≠ market source time.
 */

export type QuoteStamp = {
  mid: number;
  /** Market/source time when known */
  source_ms?: number | null;
  /** Local fetch/receive time */
  fetch_ms: number;
};

export type DataQualityVerdict = {
  ok: boolean;
  reason: string;
  stale: boolean;
  duplicate: boolean;
  gap: boolean;
  timestamp_invalid: boolean;
};

const DEFAULT_STALE_MS = 15_000;
const DEFAULT_GAP_MS = 35_000;

export function validateQuoteTiming(
  quote: QuoteStamp,
  opts?: { nowMs?: number; maxStaleMs?: number; maxSkewMs?: number }
): DataQualityVerdict {
  const now = opts?.nowMs ?? Date.now();
  const maxStale = opts?.maxStaleMs ?? DEFAULT_STALE_MS;
  const maxSkew = opts?.maxSkewMs ?? 60_000;

  if (!Number.isFinite(quote.mid) || quote.mid <= 0) {
    return {
      ok: false,
      reason: 'invalid mid',
      stale: false,
      duplicate: false,
      gap: false,
      timestamp_invalid: true,
    };
  }

  if (!Number.isFinite(quote.fetch_ms) || quote.fetch_ms <= 0) {
    return {
      ok: false,
      reason: 'invalid fetch time',
      stale: false,
      duplicate: false,
      gap: false,
      timestamp_invalid: true,
    };
  }

  const age = now - quote.fetch_ms;
  if (age > maxStale) {
    return {
      ok: false,
      reason: `STALE quote · fetch age ${Math.round(age / 1000)}s > ${Math.round(maxStale / 1000)}s`,
      stale: true,
      duplicate: false,
      gap: false,
      timestamp_invalid: false,
    };
  }

  if (quote.source_ms == null || !Number.isFinite(quote.source_ms)) {
    return {
      ok: false,
      reason: 'source timestamp UNKNOWN · NO ENTRY',
      stale: false,
      duplicate: false,
      gap: false,
      timestamp_invalid: true,
    };
  }

  if (quote.source_ms != null && Number.isFinite(quote.source_ms)) {
    if (quote.source_ms > now + 5_000) {
      return {
        ok: false,
        reason: 'source timestamp in future',
        stale: false,
        duplicate: false,
        gap: false,
        timestamp_invalid: true,
      };
    }
    const skew = Math.abs(quote.fetch_ms - quote.source_ms);
    if (skew > maxSkew) {
      return {
        ok: false,
        reason: `fetch≠source skew ${Math.round(skew / 1000)}s`,
        stale: true,
        duplicate: false,
        gap: false,
        timestamp_invalid: true,
      };
    }
    const sourceAge = now - quote.source_ms;
    if (sourceAge > maxStale) {
      return {
        ok: false,
        reason: `STALE source · age ${Math.round(sourceAge / 1000)}s`,
        stale: true,
        duplicate: false,
        gap: false,
        timestamp_invalid: false,
      };
    }
  }

  return {
    ok: true,
    reason: 'quote fresh',
    stale: false,
    duplicate: false,
    gap: false,
    timestamp_invalid: false,
  };
}

export function detectDuplicateBar(
  prev: { open_time_ms: number; open: number; high: number; low: number; close: number } | null | undefined,
  next: { open_time_ms: number; open: number; high: number; low: number; close: number }
): boolean {
  if (!prev) return false;
  return (
    prev.open_time_ms === next.open_time_ms &&
    prev.open === next.open &&
    prev.high === next.high &&
    prev.low === next.low &&
    prev.close === next.close
  );
}

export function detectBarGap(
  prev: { open_time_ms: number } | null | undefined,
  next: { open_time_ms: number },
  expectedStepMs: number,
  maxGapMs = DEFAULT_GAP_MS
): { gap: boolean; missing_ms: number } {
  if (!prev) return { gap: false, missing_ms: 0 };
  const delta = next.open_time_ms - prev.open_time_ms;
  if (delta <= 0) return { gap: false, missing_ms: 0 };
  const expected = Math.max(expectedStepMs, 1);
  const missing = delta - expected;
  if (missing > maxGapMs) return { gap: true, missing_ms: missing };
  return { gap: false, missing_ms: Math.max(0, missing) };
}

export type BarSeriesQuality = {
  ok: boolean;
  reason: string;
  duplicates: number;
  gaps: number;
};

export function assessBarSeries(
  bars: { open_time_ms: number; open: number; high: number; low: number; close: number }[],
  expectedStepMs: number
): BarSeriesQuality {
  if (!bars.length) {
    return { ok: false, reason: 'no bars', duplicates: 0, gaps: 0 };
  }
  let duplicates = 0;
  let gaps = 0;
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!;
    const cur = bars[i]!;
    if (detectDuplicateBar(prev, cur)) duplicates += 1;
    if (cur.open_time_ms < prev.open_time_ms) {
      return {
        ok: false,
        reason: 'timestamp not monotonic',
        duplicates,
        gaps,
      };
    }
    if (detectBarGap(prev, cur, expectedStepMs).gap) gaps += 1;
  }
  if (duplicates > bars.length * 0.5) {
    return { ok: false, reason: `too many duplicates (${duplicates})`, duplicates, gaps };
  }
  return { ok: true, reason: 'series ok', duplicates, gaps };
}

/** Hard gate before entry — stale/invalid must not open. */
export function allowEntryFromDataQuality(
  quote: QuoteStamp,
  opts?: { nowMs?: number; maxStaleMs?: number }
): { ok: boolean; reason: string } {
  const v = validateQuoteTiming(quote, opts);
  if (!v.ok) return { ok: false, reason: v.reason };
  return { ok: true, reason: v.reason };
}
