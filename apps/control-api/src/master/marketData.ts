/**
 * MARKET DATA → VALIDATION → NORMALIZATION
 * First stages of the MASTER pipeline — reject garbage before analysis.
 */
import type { Bar, Quote } from './types.js';

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

/** Normalize OHLC: ensure high/low envelope open/close; drop non-finite rows. */
export function normalizeBars(raw: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (const b of raw) {
    if (!finite(b.open) || !finite(b.high) || !finite(b.low) || !finite(b.close)) continue;
    if (b.open <= 0 || b.close <= 0) continue;
    const high = Math.max(b.high, b.open, b.close, b.low);
    const low = Math.min(b.low, b.open, b.close, b.high);
    if (!(high >= low)) continue;
    out.push({
      open: b.open,
      high,
      low,
      close: b.close,
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
  return {
    bid: q.bid,
    ask: q.ask,
    mid: q.mid,
    spread: finite(q.spread) ? q.spread : spread,
    ts_ms: finite(q.ts_ms) ? q.ts_ms : Date.now(),
  };
}

/**
 * Validate market input for one cycle.
 * quality reflects completeness / freshness / sanity — feeds analysis.data_quality.
 */
export function validateMarket(
  rawBars: Bar[],
  rawQuote: Quote,
  opts?: { min_bars?: number; stale_ms?: number; max_spread_abs?: number; now_ms?: number }
): MarketValidation {
  const reasons: string[] = [];
  const min_bars = opts?.min_bars ?? 5;
  const stale_ms = opts?.stale_ms ?? 15_000;
  const max_spread = opts?.max_spread_abs ?? 5;
  const now = opts?.now_ms ?? Date.now();

  const bars = normalizeBars(rawBars);
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
  if (reasons.includes('flat_tape')) quality -= 0.1;
  quality = Math.max(0, Math.min(1, quality));

  const hardFail =
    reasons.includes('insufficient_bars') ||
    reasons.includes('invalid_quote') ||
    reasons.includes('spread_insane');

  return {
    ok: !hardFail && quality >= 0.35,
    quality,
    reasons,
    bars,
    quote,
  };
}
