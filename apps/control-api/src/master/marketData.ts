/**
 * MARKET DATA → VALIDATION → NORMALIZATION
 * First stages of the MASTER pipeline — reject garbage before analysis.
 */
import type { Bar, Quote } from './types.js';
import { fusePriceMids } from '../services/publicInternetFeeds.js';

export type MarketValidation = {
  ok: boolean;
  quality: number; // 0..1
  reasons: string[];
  bars: Bar[];
  quote: Quote | null;
};

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * READER-style multi-feed agreement — broker/public mids must not diverge
 * enough to trade on a single lying source.
 */
export function assessFeedDivergence(
  brokerMid: number,
  referenceMids: number[],
  opts?: { mixedPublic?: boolean }
): {
  agreement: 'STRONG' | 'OK' | 'DIVERGENT' | 'INSUFFICIENT' | 'NONE';
  span: number;
  contributing: number;
} {
  const refs = referenceMids.filter(finite);
  if (!finite(brokerMid) || refs.length === 0) {
    return { agreement: 'NONE', span: 0, contributing: 0 };
  }
  const fused = fusePriceMids([brokerMid, ...refs], {
    mixedPublic: opts?.mixedPublic !== false,
  });
  return {
    agreement: fused.agreement,
    span: fused.span,
    contributing: fused.contributing,
  };
}

/** Round price to broker Digits (Reader / Check- parity). */
export function roundToDigits(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const d = Math.max(0, Math.min(12, Math.floor(digits)));
  const f = 10 ** d;
  return Math.round(value * f) / f;
}

/** Normalize OHLC: ensure high/low envelope open/close; drop non-finite rows. */
export function normalizeBars(
  raw: Bar[],
  opts?: { digits?: number | null }
): Bar[] {
  const digits =
    opts?.digits != null && Number.isFinite(opts.digits) && opts.digits >= 0
      ? Math.floor(Number(opts.digits))
      : null;
  const out: Bar[] = [];
  for (const b of raw) {
    if (!finite(b.open) || !finite(b.high) || !finite(b.low) || !finite(b.close)) continue;
    if (b.open <= 0 || b.close <= 0) continue;
    let open = b.open;
    let high = b.high;
    let low = b.low;
    let close = b.close;
    if (digits != null) {
      open = roundToDigits(open, digits);
      high = roundToDigits(high, digits);
      low = roundToDigits(low, digits);
      close = roundToDigits(close, digits);
    }
    high = Math.max(high, open, close, low);
    low = Math.min(low, open, close, high);
    if (!(high >= low)) continue;
    out.push({
      open,
      high,
      low,
      close,
      bid: finite(b.bid) ? b.bid : undefined,
      ask: finite(b.ask) ? b.ask : undefined,
      ts_ms: finite(b.ts_ms) ? b.ts_ms : undefined,
    });
  }
  // Causal order by ts when present
  out.sort((a, b) => (a.ts_ms ?? 0) - (b.ts_ms ?? 0));
  return out;
}

export function normalizeQuote(q: Quote): Quote | null {
  if (!finite(q.bid) || !finite(q.ask) || !finite(q.mid)) return null;
  if (q.ask < q.bid) return null;
  if (q.mid <= 0) return null;
  const spread = q.ask - q.bid;
  const digits =
    q.digits != null && Number.isFinite(q.digits) && q.digits >= 0
      ? Math.floor(Number(q.digits))
      : null;
  const point =
    q.point != null && Number.isFinite(q.point) && q.point > 0
      ? Number(q.point)
      : null;
  let bid = q.bid;
  let ask = q.ask;
  let mid = q.mid;
  if (digits != null) {
    bid = roundToDigits(bid, digits);
    ask = roundToDigits(ask, digits);
    mid = roundToDigits(mid, digits);
  }
  return {
    bid,
    ask,
    mid,
    spread: finite(q.spread) ? q.spread : ask - bid,
    ts_ms: finite(q.ts_ms) ? q.ts_ms : Date.now(),
    epic: q.epic,
    min_stop_distance: q.min_stop_distance,
    digits,
    point,
  };
}

/**
 * Validate market input for one cycle.
 * quality reflects completeness / freshness / sanity — feeds analysis.data_quality.
 */
export function validateMarket(
  rawBars: Bar[],
  rawQuote: Quote,
  opts?: {
    min_bars?: number;
    stale_ms?: number;
    max_spread_abs?: number;
    now_ms?: number;
    /** Public / secondary mids for READER-style divergence gate */
    reference_mids?: number[] | null;
  }
): MarketValidation {
  const reasons: string[] = [];
  const min_bars = opts?.min_bars ?? 5;
  const stale_ms = opts?.stale_ms ?? 15_000;
  const max_spread = opts?.max_spread_abs ?? 5;
  const now = opts?.now_ms ?? Date.now();

  const bars = normalizeBars(rawBars, { digits: rawQuote.digits });
  const quote = normalizeQuote(rawQuote);

  if (bars.length < min_bars) reasons.push('insufficient_bars');
  if (!quote) reasons.push('invalid_quote');

  if (quote) {
    if (now - quote.ts_ms > stale_ms) reasons.push('stale_quote');
    if (quote.spread > max_spread) reasons.push('spread_insane');
    if (quote.spread < 0) reasons.push('negative_spread');
    const last = bars.at(-1);
    if (last) {
      const drift = Math.abs(last.close - quote.mid) / Math.max(quote.mid, 1e-9);
      if (drift > 0.05) reasons.push('quote_bar_desync');
    }
    // Multi-source honesty (Orbit/READER) — block entries when feeds disagree
    const feed = assessFeedDivergence(quote.mid, opts?.reference_mids || [], {
      mixedPublic: true,
    });
    if (feed.agreement === 'DIVERGENT' && feed.contributing >= 2) {
      reasons.push('feed_divergent');
    }
  }

  // Duplicate / flat tape detection
  if (bars.length >= 8) {
    const closes = bars.slice(-8).map((b) => b.close);
    const unique = new Set(closes.map((c) => c.toFixed(5)));
    if (unique.size === 1) reasons.push('flat_tape');
  }

  let quality = 1;
  if (reasons.includes('insufficient_bars')) quality -= 0.5;
  if (reasons.includes('invalid_quote')) quality -= 0.5;
  if (reasons.includes('stale_quote')) quality -= 0.25;
  if (reasons.includes('spread_insane')) quality -= 0.2;
  if (reasons.includes('quote_bar_desync')) quality -= 0.15;
  if (reasons.includes('flat_tape')) quality -= 0.35;
  if (reasons.includes('feed_divergent')) quality -= 0.45;
  quality = Math.max(0, Math.min(1, quality));

  // Flat public tape must not trade — soft −0.1 still left entries open on dead mids
  // Stale quote must hard-fail so Stage·validate matches DATA_STALE / Quote card
  // Divergent multi-feed must hard-fail (READER Orbit honesty)
  const hardFail =
    reasons.includes('insufficient_bars') ||
    reasons.includes('invalid_quote') ||
    reasons.includes('spread_insane') ||
    reasons.includes('flat_tape') ||
    reasons.includes('stale_quote') ||
    reasons.includes('feed_divergent');

  return {
    ok: !hardFail && quality >= 0.35,
    quality,
    reasons,
    bars,
    quote,
  };
}
