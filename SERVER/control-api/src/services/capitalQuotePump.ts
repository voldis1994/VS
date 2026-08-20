/**
 * Capital quote pump — REST quote polling independent of robotDesk ~2s cycle.
 *
 * Source of truth for cadence:
 *   CAPITAL_QUOTE_PUMP_MS (default 250ms) = REST quote polling interval.
 *   This is NOT a guarantee of “every market tick” — Capital.com in this
 *   codebase is polled via GET markets/{epic} (REST). There is no Capital
 *   Lightstreamer / streaming WebSocket price feed wired as primary.
 *   Outbound /ws telemetry sockets are unrelated.
 *
 * Each successful poll → FeedManager.ingest → fan-out → TickMicro + 10s OHLC
 * → Entry State Machine (when desk context published). REST remains primary;
 * if a Capital streaming feed is added later, attach it as primary and keep
 * this pump as fallback.
 */

import type { FeedManager } from '../vs-core/feedManager.js';
import type { CapitalMarketQuote } from './capitalCom.js';

export type QuoteFetchFn = () => Promise<CapitalMarketQuote | null>;

type Pump = {
  timer: ReturnType<typeof setInterval> | null;
  in_flight: boolean;
  key: string;
  epic: string;
  feedManager: FeedManager;
  fetchQuote: QuoteFetchFn;
  interval_ms: number;
  ticks_pushed: number;
  last_error: string | null;
};

const pumps = new Map<string, Pump>();

/**
 * Default 250ms REST quote polling interval.
 * Denser than robotDesk ~2s so micro/SM see polled quotes between desk cycles.
 * Not a market-tick stream.
 */
export const CAPITAL_QUOTE_PUMP_MS = 250;

export function startCapitalQuotePump(input: {
  key: string;
  epic: string;
  feedManager: FeedManager;
  fetchQuote: QuoteFetchFn;
  intervalMs?: number;
}): void {
  const key = String(input.key || '');
  if (!key) return;
  stopCapitalQuotePump(key);

  const pump: Pump = {
    timer: null,
    in_flight: false,
    key,
    epic: input.epic,
    feedManager: input.feedManager,
    fetchQuote: input.fetchQuote,
    interval_ms: Math.max(100, input.intervalMs ?? CAPITAL_QUOTE_PUMP_MS),
    ticks_pushed: 0,
    last_error: null,
  };

  const tick = async () => {
    if (pump.in_flight) return;
    pump.in_flight = true;
    try {
      const quote = await pump.fetchQuote();
      if (!quote || !quote.raw_ok) return;
      if (quote.bid == null || quote.ask == null) return;
      if (!Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)) return;
      pump.feedManager.ingest({
        source: 'capital',
        epic: pump.epic,
        bid: quote.bid,
        ask: quote.ask,
        source_timestamp: new Date().toISOString(),
      });
      pump.ticks_pushed += 1;
      pump.last_error = null;
    } catch (e) {
      pump.last_error = e instanceof Error ? e.message : String(e);
    } finally {
      pump.in_flight = false;
    }
  };

  pumps.set(key, pump);
  void tick();
  pump.timer = setInterval(() => void tick(), pump.interval_ms);
}

export function stopCapitalQuotePump(key: string): void {
  const p = pumps.get(key);
  if (!p) return;
  if (p.timer) clearInterval(p.timer);
  pumps.delete(key);
}

export function getCapitalQuotePumpStats(key: string): {
  ticks_pushed: number;
  interval_ms: number;
  last_error: string | null;
} | null {
  const p = pumps.get(key);
  if (!p) return null;
  return {
    ticks_pushed: p.ticks_pushed,
    interval_ms: p.interval_ms,
    last_error: p.last_error,
  };
}

/** Test helper — inject a quote without timer (still goes through FeedManager → fan-out). */
export function injectPumpQuote(
  feedManager: FeedManager,
  epic: string,
  bid: number,
  ask: number,
  tsMs = Date.now()
): void {
  feedManager.ingest({
    source: 'capital',
    epic,
    bid,
    ask,
    source_timestamp: new Date(tsMs).toISOString(),
    now: tsMs,
  });
}

export function resetCapitalQuotePumps(): void {
  for (const key of [...pumps.keys()]) stopCapitalQuotePump(key);
}
