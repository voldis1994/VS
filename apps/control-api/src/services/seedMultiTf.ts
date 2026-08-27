/**
 * Seed multi-TF books from Capital historical candles.
 * Backoff on failure (#22). Prefer valid fallback over insufficient native (#24).
 */
import type { CapitalSession } from './capitalCom.js';
import { fetchCapitalPrices, type CapitalPriceCandle } from './capitalCom.js';
import {
  TF_MS,
  TF_MIN_CLOSED,
  TF_REFRESH_MS,
  TF_RESOLUTION,
  TF_SEED_MAX,
  aggregateAligned,
  emptyMultiTfState,
  evaluateMultiTfReady,
  evaluateTfBook,
  mergeUniqueBars,
  seedBackoffMs,
  type MultiTfState,
  type TfBar,
  type TfBook,
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
    if (t == null || !Number.isFinite(t) || t <= 0) continue;
    if (t > nowMs + 5_000) continue;
    const open_time_ms = Math.floor(t / step) * step;
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

function pickBestBook(
  tf: Exclude<TfKey, '10s'>,
  nativeBars: TfBar[],
  aggBars: TfBar[],
  nowMs: number,
  nativeDetail: string
): { book: TfBook; detail: string } {
  const nativeEval = evaluateTfBook(
    tf,
    nativeBars,
    nativeBars.length ? 'CAPITAL_NATIVE' : 'EMPTY',
    nowMs
  );
  const aggEval = evaluateTfBook(
    tf,
    aggBars,
    aggBars.length ? 'AGGREGATED_FALLBACK' : 'EMPTY',
    nowMs
  );

  // #24: insufficient native must not block valid fallback
  if (nativeEval.ready) {
    return { book: nativeEval, detail: `native ${nativeDetail}` };
  }
  if (aggEval.ready) {
    return {
      book: aggEval,
      detail: `fallback preferred · native not ready (${nativeEval.detail})`,
    };
  }
  // Prefer whichever has more closed bars / ATR
  if ((aggEval.bars.length || 0) > (nativeEval.bars.length || 0)) {
    return { book: aggEval, detail: `partial fallback · ${aggEval.detail}` };
  }
  return { book: nativeEval, detail: nativeEval.detail };
}

async function fetchNativeBars(
  session: CapitalSession,
  epic: string,
  tf: Exclude<TfKey, '10s'>,
  nowMs: number
): Promise<{ bars: TfBar[]; detail: string; rejected: number }> {
  const got = await fetchCapitalPrices(session, epic, TF_RESOLUTION[tf], TF_SEED_MAX[tf]);
  const bars = capitalCandlesToTfBars(got.candles, tf, nowMs);
  return {
    bars,
    detail: got.detail,
    rejected: got.rejected_no_timestamp ?? 0,
  };
}

/** Load 1m→5m→15m→1H→4H with backoff. */
export async function seedMultiTfHistory(
  session: CapitalSession,
  epic: string,
  prior?: MultiTfState | null,
  nowMs = Date.now()
): Promise<MultiTfState> {
  const state = prior ? { ...prior, books: { ...prior.books } } : emptyMultiTfState();

  // #22 backoff — do not hammer Capital every 2s
  if ((state.seed_next_allowed_ms ?? 0) > nowMs && !state.ready) {
    return {
      ...state,
      ready: false,
      detail: `seed backoff · next in ${Math.ceil(((state.seed_next_allowed_ms ?? 0) - nowMs) / 1000)}s · ${state.detail}`,
    };
  }

  try {
    const m1n = await fetchNativeBars(session, epic, '1m', nowMs);
    const m1 = pickBestBook('1m', m1n.bars, [], nowMs, m1n.detail);
    state.books['1m'] = evaluateTfBook(
      '1m',
      mergeUniqueBars(state.books['1m'].bars, m1.book.bars),
      m1.book.source,
      nowMs
    );

    const m5n = await fetchNativeBars(session, epic, '5m', nowMs);
    const m5agg = aggregateAligned(state.books['1m'].bars, '1m', '5m', nowMs);
    const m5 = pickBestBook('5m', m5n.bars, m5agg, nowMs, m5n.detail);
    state.books['5m'] = evaluateTfBook(
      '5m',
      mergeUniqueBars(state.books['5m'].bars, m5.book.bars),
      m5.book.source,
      nowMs
    );

    const m15n = await fetchNativeBars(session, epic, '15m', nowMs);
    const m15agg = aggregateAligned(state.books['5m'].bars, '5m', '15m', nowMs);
    const m15 = pickBestBook('15m', m15n.bars, m15agg, nowMs, m15n.detail);
    state.books['15m'] = evaluateTfBook(
      '15m',
      mergeUniqueBars(state.books['15m'].bars, m15.book.bars),
      m15.book.source,
      nowMs
    );

    const h1n = await fetchNativeBars(session, epic, '1H', nowMs);
    const h1agg = aggregateAligned(state.books['15m'].bars, '15m', '1H', nowMs);
    const h1 = pickBestBook('1H', h1n.bars, h1agg, nowMs, h1n.detail);
    state.books['1H'] = evaluateTfBook(
      '1H',
      mergeUniqueBars(state.books['1H'].bars, h1.book.bars),
      h1.book.source,
      nowMs
    );

    const h4n = await fetchNativeBars(session, epic, '4H', nowMs);
    const h4agg = aggregateAligned(state.books['1H'].bars, '1H', '4H', nowMs);
    const h4 = pickBestBook('4H', h4n.bars, h4agg, nowMs, h4n.detail);
    state.books['4H'] = evaluateTfBook(
      '4H',
      mergeUniqueBars(state.books['4H'].bars, h4.book.bars),
      h4.book.source,
      nowMs
    );

    state.seeded_at_ms = nowMs;
    const ready = evaluateMultiTfReady(state);
    if (ready.ready) {
      ready.seed_fail_count = 0;
      ready.seed_next_allowed_ms = 0;
      ready.last_refresh_ms = {
        '1m': nowMs,
        '5m': nowMs,
        '15m': nowMs,
        '1H': nowMs,
        '4H': nowMs,
      };
      return ready;
    }

    const fails = (state.seed_fail_count ?? 0) + 1;
    const backoff = seedBackoffMs(fails);
    return {
      ...ready,
      seed_fail_count: fails,
      seed_next_allowed_ms: nowMs + backoff,
      detail: `${ready.detail} · backoff ${Math.round(backoff / 1000)}s`,
    };
  } catch (err) {
    const fails = (state.seed_fail_count ?? 0) + 1;
    const backoff = seedBackoffMs(fails);
    return {
      ...state,
      ready: false,
      seed_fail_count: fails,
      seed_next_allowed_ms: nowMs + backoff,
      detail: `TF seed fail · ${err instanceof Error ? err.message : String(err)} · backoff ${Math.round(backoff / 1000)}s`,
    };
  }
}

/** Refresh TFs that are due by their own cadence (#23). */
export async function refreshDueTfBooks(
  session: CapitalSession,
  epic: string,
  state: MultiTfState,
  nowMs = Date.now()
): Promise<MultiTfState> {
  let next = { ...state, books: { ...state.books }, last_refresh_ms: { ...(state.last_refresh_ms || {}) } };
  const order: Array<Exclude<TfKey, '10s'>> = ['1m', '5m', '15m', '1H', '4H'];
  for (const tf of order) {
    const last = next.last_refresh_ms?.[tf] ?? 0;
    if (nowMs - last < TF_REFRESH_MS[tf]) continue;
    const refreshed = await refreshTfBook(session, epic, next, tf, nowMs);
    next = {
      ...refreshed,
      last_refresh_ms: { ...(refreshed.last_refresh_ms || next.last_refresh_ms || {}), [tf]: nowMs },
    };
  }
  return next;
}

export async function refreshTfBook(
  session: CapitalSession,
  epic: string,
  state: MultiTfState,
  tf: Exclude<TfKey, '10s'>,
  nowMs = Date.now()
): Promise<MultiTfState> {
  const next = { ...state, books: { ...state.books } };
  const lowerBars =
    tf === '5m'
      ? next.books['1m'].bars
      : tf === '15m'
        ? next.books['5m'].bars
        : tf === '1H'
          ? next.books['15m'].bars
          : tf === '4H'
            ? next.books['1H'].bars
            : [];
  const lowerTf =
    tf === '5m' ? '1m' : tf === '15m' ? '5m' : tf === '1H' ? '15m' : tf === '4H' ? '1H' : null;

  const native = await fetchNativeBars(session, epic, tf, nowMs);
  const agg =
    lowerTf != null ? aggregateAligned(lowerBars, lowerTf, tf, nowMs) : [];
  const picked = pickBestBook(tf, native.bars, agg, nowMs, native.detail);
  next.books[tf] = evaluateTfBook(
    tf,
    mergeUniqueBars(next.books[tf].bars, picked.book.bars),
    picked.book.source === 'EMPTY' ? next.books[tf].source : picked.book.source,
    nowMs
  );
  return evaluateMultiTfReady(next);
}

export { TF_REFRESH_MS, seedBackoffMs };
