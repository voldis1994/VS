/**
 * Event-driven fan-out: every FeedManager LIVE accepted quote → TickMicro + desk OHLC
 * → Entry State Machine evaluation (when desk context is published).
 * Single validated-tick source. Not tied to robotDesk ~2s cadence.
 * Never places broker orders from this path.
 */

import type { FeedManager, FeedQuote } from '../vs-core/feedManager.js';
import { setFanoutErrorHook } from '../vs-core/feedManager.js';
import {
  getTickMicroBook,
  ingestValidatedTick,
  markTickMicroFanoutDegraded,
  type ValidatedTick,
} from './tickMicroEngine.js';
import { ingestValidatedTickToDeskOhlc } from './ohlcCanonicalAdapter.js';
import {
  emptyTenSecState,
  publicOhlc10s,
  type TenSecBar,
  type TenSecState,
} from './tenSecondOhlc.js';
import { advanceEntryEngineOnAcceptedTick } from './entryEngine.js';

export type EpicTickBook = {
  epic: string;
  ohlcState: TenSecState;
  closedBars: TenSecBar[];
  last_accepted: FeedQuote | null;
  accepted_count: number;
  last_closed: TenSecBar | null;
  /** Per-tick SM advances (no orders). */
  sm_advance_count: number;
  last_sm_state: string | null;
  last_sm_phase: string | null;
};

const books = new Map<string, EpicTickBook>();
const attached = new WeakSet<FeedManager>();
const MAX_CLOSED = 120;
let errorHookInstalled = false;

function ensureErrorHook(): void {
  if (errorHookInstalled) return;
  errorHookInstalled = true;
  setFanoutErrorHook((epic, err) => {
    markTickMicroFanoutDegraded(epic, err);
  });
}

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
      sm_advance_count: 0,
      last_sm_state: null,
      last_sm_phase: null,
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
 * Apply one accepted FeedManager quote to TickMicro + 10s OHLC + Entry SM (same tick).
 * Does not place orders.
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

  // Per-tick Entry State Machine — IGNITION/TRIGGER without waiting for ~2s desk cycle.
  // Execution still only via robotDesk → C++/risk/moneyPath.
  const eng = advanceEntryEngineOnAcceptedTick({
    instrument: q.epic,
    mid: tick.mid,
    nowMs: tick.ts_ms,
  });
  if (eng) {
    book.sm_advance_count += 1;
    book.last_sm_state = eng.machine.state;
    book.last_sm_phase = eng.machine.phase;
  }

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

/** Attach fan-out to a FeedManager — every LIVE accept notifies TickMicro+OHLC+SM. */
export function attachValidatedTickFanout(fm: FeedManager): () => void {
  ensureErrorHook();
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
