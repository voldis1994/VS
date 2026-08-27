/**
 * Seed multi-TF books from Capital historical candles.
 * Critical UNKNOWN timestamps → skip candle (never invent) → NOT_READY if short.
 */
import type { CapitalSession } from './capitalCom.js';
import { fetchCapitalPrices, type CapitalPriceCandle } from './capitalCom.js';
import {
  TF_MS,
  TF_MIN_CLOSED,
  TF_RESOLUTION,
  TF_SEED_MAX,
  aggregateAligned,
  emptyMultiTfState,
  evaluateMultiTfReady,
  evaluateTfBook,
  mergeUniqueBars,
  type MultiTfState,
  type TfBar,
  type TfKey,
} from './timeframeBooks.js';

export function capitalCandlesToTfBars(
  candles: CapitalPriceCandle[],
  tf: Exclude<TfKey, '10s'>,
  nowMs = Date.now()
): TfBar[] {
  const step = TF_MS[tf];
  const out: TfBar[] = [];
  for (const c of candles) {
    const t = c.open_time_ms;
    // CRITICAL: never invent missing timestamps
    if (t == null || !Number.isFinite(t) || t <= 0) continue;
    if (t > nowMs + 5_000) continue;
    const open_time_ms = Math.floor(t / step) * step;
    // Only accept if source already on-grid or within same bucket of a real ts
    // (floor aligns broker sub-second noise; does not invent missing bars)
    const forming = open_time_ms + step > nowMs;
    out.push({
      open_time_ms,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      ticks: 1,
      provenance: 'REAL',
      forming,
      source_tf: tf,
    });
  }
  return out.sort((a, b) => a.open_time_ms - b.open_time_ms);
}

async function fetchNativeOrFallback(
  session: CapitalSession,
  epic: string,
  tf: Exclude<TfKey, '10s'>,
  lower?: { tf: Exclude<TfKey, '10s'>; bars: TfBar[] },
  nowMs = Date.now()
): Promise<{
  bars: TfBar[];
  source: 'CAPITAL_NATIVE' | 'AGGREGATED_FALLBACK' | 'EMPTY';
  detail: string;
}> {
  const res = TF_RESOLUTION[tf];
  const max = TF_SEED_MAX[tf];
  const got = await fetchCapitalPrices(session, epic, res, max);
  const nativeBars = capitalCandlesToTfBars(got.candles, tf, nowMs);
  const rejected = got.rejected_no_timestamp ?? 0;

  if (got.ok && nativeBars.length >= Math.min(TF_MIN_CLOSED[tf], 10)) {
    return {
      bars: nativeBars,
      source: 'CAPITAL_NATIVE',
      detail:
        rejected > 0
          ? `${got.detail} · dropped_no_ts=${rejected}`
          : got.detail,
    };
  }

  // Fallback aggregation from lower TF with clock boundaries (gaps not compressed)
  if (lower && lower.bars.length >= 8) {
    const agg = aggregateAligned(lower.bars, lower.tf, tf, nowMs);
    if (agg.length >= Math.min(8, Math.floor(TF_MIN_CLOSED[tf] / 2))) {
      return {
        bars: agg,
        source: 'AGGREGATED_FALLBACK',
        detail: `fallback ${lower.tf}→${tf} · ${agg.length} bars (native: ${got.detail})`,
      };
    }
  }

  if (nativeBars.length === 0) {
    return {
      bars: [],
      source: 'EMPTY',
      detail: `EMPTY ${tf} · ${got.detail}${rejected ? ` · rejected_no_ts=${rejected}` : ''}`,
    };
  }

  // Partial native — keep bars but source marks not fully ready via evaluateTfBook
  return {
    bars: nativeBars,
    source: got.ok ? 'CAPITAL_NATIVE' : 'EMPTY',
    detail: got.detail,
  };
}

/** Load 1m→5m→15m→1H→4H; block trading until evaluateMultiTfReady.ok. */
export async function seedMultiTfHistory(
  session: CapitalSession,
  epic: string,
  prior?: MultiTfState | null,
  nowMs = Date.now()
): Promise<MultiTfState> {
  const state = prior ? { ...prior, books: { ...prior.books } } : emptyMultiTfState();

  const m1 = await fetchNativeOrFallback(session, epic, '1m', undefined, nowMs);
  state.books['1m'] = evaluateTfBook(
    '1m',
    mergeUniqueBars(state.books['1m'].bars, m1.bars),
    m1.source,
    nowMs
  );

  const m5 = await fetchNativeOrFallback(
    session,
    epic,
    '5m',
    { tf: '1m', bars: state.books['1m'].bars },
    nowMs
  );
  state.books['5m'] = evaluateTfBook(
    '5m',
    mergeUniqueBars(state.books['5m'].bars, m5.bars),
    m5.source,
    nowMs
  );

  const m15 = await fetchNativeOrFallback(
    session,
    epic,
    '15m',
    { tf: '5m', bars: state.books['5m'].bars },
    nowMs
  );
  state.books['15m'] = evaluateTfBook(
    '15m',
    mergeUniqueBars(state.books['15m'].bars, m15.bars),
    m15.source,
    nowMs
  );

  const h1 = await fetchNativeOrFallback(
    session,
    epic,
    '1H',
    { tf: '15m', bars: state.books['15m'].bars },
    nowMs
  );
  state.books['1H'] = evaluateTfBook(
    '1H',
    mergeUniqueBars(state.books['1H'].bars, h1.bars),
    h1.source,
    nowMs
  );

  const h4 = await fetchNativeOrFallback(
    session,
    epic,
    '4H',
    { tf: '1H', bars: state.books['1H'].bars },
    nowMs
  );
  state.books['4H'] = evaluateTfBook(
    '4H',
    mergeUniqueBars(state.books['4H'].bars, h4.bars),
    h4.source,
    nowMs
  );

  state.seeded_at_ms = nowMs;
  return evaluateMultiTfReady(state);
}

/** Refresh one TF periodically (closed bars only). */
export async function refreshTfBook(
  session: CapitalSession,
  epic: string,
  state: MultiTfState,
  tf: Exclude<TfKey, '10s'>,
  nowMs = Date.now()
): Promise<MultiTfState> {
  const next = { ...state, books: { ...state.books } };
  const lower =
    tf === '5m'
      ? { tf: '1m' as const, bars: next.books['1m'].bars }
      : tf === '15m'
        ? { tf: '5m' as const, bars: next.books['5m'].bars }
        : tf === '1H'
          ? { tf: '15m' as const, bars: next.books['15m'].bars }
          : tf === '4H'
            ? { tf: '1H' as const, bars: next.books['1H'].bars }
            : undefined;
  const got = await fetchNativeOrFallback(session, epic, tf, lower, nowMs);
  next.books[tf] = evaluateTfBook(
    tf,
    mergeUniqueBars(next.books[tf].bars, got.bars),
    got.source === 'EMPTY' ? next.books[tf].source : got.source,
    nowMs
  );
  return evaluateMultiTfReady(next);
}
