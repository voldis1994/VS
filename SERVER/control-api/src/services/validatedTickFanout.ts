/**
 * Event-driven fan-out: every FeedManager LIVE accepted quote → TickMicro + desk OHLC.
 * Single validated-tick source for both. Not tied to robotDesk ~2s cadence.
 */

import type { FeedManager, FeedQuote } from '../vs-core/feedManager.js';
import {
  getTickMicroBook,
  ingestValidatedTick,
  type ValidatedTick,
} from './tickMicroEngine.js';
import { ingestValidatedTickToDeskOhlc } from './ohlcCanonicalAdapter.js';
import {
  emptyTenSecState,
  publicOhlc10s,
  type TenSecBar,
  type TenSecState,
} from './tenSecondOhlc.js';

export type EpicTickBook = {
  epic: string;
  ohlcState: TenSecState;
  closedBars: TenSecBar[];
  last_accepted: FeedQuote | null;
  accepted_count: number;
  last_closed: TenSecBar | null;
};

const books = new Map<string, EpicTickBook>();
const attached = new WeakSet<FeedManager>();
const MAX_CLOSED = 120;

function ensureBook(epic: string): EpicTickBook {
  const key = String(epic || '').toUpperCase();
  let b = books.get(key);
  if (!b) {
    b = {
      epic: key,
      ohlcState: emptyTenSecState(),
      closedBars: [],
      last_accepted: null,
      accepted_count: 0,
      last_closed: null,
    };
    books.set(key, b);
  }
  return b;
}

export function feedQuoteToValidatedTick(q: FeedQuote): ValidatedTick | null {
  if (q.status !== 'LIVE') return null;
  if (q.mid == null || !Number.isFinite(q.mid) || q.mid <= 0) return null;
  const ts =
    q.source_timestamp && Number.isFinite(Date.parse(q.source_timestamp))
      ? Date.parse(q.source_timestamp)
      : Date.parse(q.receive_timestamp);
  if (!Number.isFinite(ts)) return null;
  return {
    ts_ms: ts,
    mid: q.mid,
    bid: q.bid,
    ask: q.ask,
    spread: q.spread,
    quality: 'OK',
    provider: q.source || 'capital',
  };
}

/**
 * Apply one accepted FeedManager quote to TickMicro + 10s OHLC (same tick).
 */
export function applyAcceptedFeedQuote(q: FeedQuote): {
  tick: ValidatedTick | null;
  closed: TenSecBar | null;
  book: EpicTickBook;
} {
  const book = ensureBook(q.epic);
  const tick = feedQuoteToValidatedTick(q);
  if (!tick) return { tick: null, closed: null, book };

  ingestValidatedTick(getTickMicroBook(q.epic), tick);
  const adapted = ingestValidatedTickToDeskOhlc(book.ohlcState, tick);
  book.ohlcState = adapted.state;
  book.last_accepted = q;
  book.accepted_count += 1;

  let closed: TenSecBar | null = null;
  if (adapted.closed) {
    closed = adapted.closed;
    book.last_closed = closed;
    const last = book.closedBars[book.closedBars.length - 1];
    const same =
      last &&
      Math.abs(last.open - closed.open) < 1e-9 &&
      Math.abs(last.close - closed.close) < 1e-9;
    if (!same) {
      book.closedBars.push(closed);
      if (book.closedBars.length > MAX_CLOSED) {
        book.closedBars.splice(0, book.closedBars.length - MAX_CLOSED);
      }
    }
  }
  return { tick, closed, book };
}

/** Attach fan-out to a FeedManager — every LIVE accept notifies TickMicro+OHLC. */
export function attachValidatedTickFanout(fm: FeedManager): () => void {
  if (attached.has(fm)) return () => {};
  attached.add(fm);
  return fm.onAccepted((q) => {
    applyAcceptedFeedQuote(q);
  });
}

export function getEpicTickBook(epic: string): EpicTickBook | null {
  return books.get(String(epic || '').toUpperCase()) || null;
}

export function publicOhlcFromEpic(epic: string) {
  const b = getEpicTickBook(epic);
  return publicOhlc10s(b?.ohlcState ?? emptyTenSecState());
}

/** Test helper */
export function resetEpicTickBooks(): void {
  books.clear();
}
