/**
 * Feed Manager — roles PRIMARY / CONFIRMATION / REFERENCE / FALLBACK.
 * PRIMARY offline must never silently drive Capital orders from a reference feed.
 */

export type FeedRole = 'PRIMARY' | 'CONFIRMATION' | 'REFERENCE' | 'FALLBACK';

export type FeedStatus = 'LIVE' | 'DEGRADED' | 'STALE' | 'OFFLINE' | 'ERROR';

export type FeedQuote = {
  source: string;
  role: FeedRole;
  epic: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread: number | null;
  source_timestamp: string | null;
  receive_timestamp: string;
  sequence: number;
  age_ms: number;
  status: FeedStatus;
  detail: string | null;
};

export type FeedManagerSnapshot = {
  epic: string;
  primary: FeedQuote | null;
  confirmation: FeedQuote[];
  reference: FeedQuote[];
  fallback: FeedQuote[];
  primary_status: FeedStatus | 'MISSING';
  allows_execution: boolean;
  block_reason: string | null;
};

const DEFAULT_STALE_MS = 5000;

/** Optional hook so TickMicro can mark DEGRADED without circular imports. */
type FanoutErrorHook = (epic: string, err: unknown) => void;
let fanoutErrorHook: FanoutErrorHook | null = null;

export function setFanoutErrorHook(hook: FanoutErrorHook | null): void {
  fanoutErrorHook = hook;
}

export class FeedManager {
  private seq = 0;
  private byEpic = new Map<string, Map<string, FeedQuote>>();
  private roles = new Map<string, FeedRole>(); // source → role
  private staleMs: number;
  private acceptedListeners: Array<(quote: FeedQuote) => void> = [];
  /** Fan-out callback failures — never silent. */
  fanout_error_count = 0;
  last_fanout_error: string | null = null;

  constructor(staleMs = DEFAULT_STALE_MS) {
    this.staleMs = staleMs;
  }

  defineSource(source: string, role: FeedRole): void {
    this.roles.set(source, role);
  }

  ingest(input: {
    source: string;
    epic: string;
    bid?: number | null;
    ask?: number | null;
    source_timestamp?: string | null;
    now?: number;
    force_status?: FeedStatus;
    detail?: string | null;
  }): FeedQuote {
    const role = this.roles.get(input.source) || 'REFERENCE';
    const now = input.now ?? Date.now();
    const receive = new Date(now).toISOString();
    const bid = input.bid ?? null;
    const ask = input.ask ?? null;
    let status: FeedStatus = input.force_status || 'LIVE';
    let detail = input.detail ?? null;

  if (status === 'LIVE') {
      if (bid == null || ask == null || !Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) {
        status = 'ERROR';
        detail = 'malformed bid/ask';
      } else {
        const srcTs = input.source_timestamp ? Date.parse(input.source_timestamp) : now;
        if (!Number.isFinite(srcTs)) {
          status = 'ERROR';
          detail = 'invalid source_timestamp';
        } else if (srcTs - now > 2000) {
          status = 'ERROR';
          detail = 'future timestamp';
        } else {
          const age = Math.max(0, now - srcTs);
          if (age > this.staleMs) {
            status = 'STALE';
            detail = `age ${age}ms`;
          }
        }
      }
    }

    const mid =
      bid != null && ask != null && Number.isFinite(bid) && Number.isFinite(ask)
        ? (bid + ask) / 2
        : null;
    const spread =
      bid != null && ask != null && Number.isFinite(bid) && Number.isFinite(ask)
        ? ask - bid
        : null;
    const srcTs = input.source_timestamp ? Date.parse(input.source_timestamp) : now;
    const age_ms = Number.isFinite(srcTs) ? Math.max(0, now - srcTs) : 0;

    const quote: FeedQuote = {
      source: input.source,
      role,
      epic: input.epic,
      bid,
      ask,
      mid,
      spread,
      source_timestamp: input.source_timestamp || null,
      receive_timestamp: receive,
      sequence: ++this.seq,
      age_ms,
      status,
      detail,
    };

    let map = this.byEpic.get(input.epic);
    if (!map) {
      map = new Map();
      this.byEpic.set(input.epic, map);
    }
    map.set(input.source, quote);

    // Event-driven: every LIVE accepted quote notifies listeners (TickMicro + OHLC fan-out).
    if (quote.status === 'LIVE' && quote.mid != null && Number.isFinite(quote.mid)) {
      for (const cb of this.acceptedListeners) {
        try {
          cb(quote);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.fanout_error_count += 1;
          this.last_fanout_error = msg;
          // Never swallow — log + degrade TickMicro quality for this epic.
          console.error(
            `[FeedManager] onAccepted fan-out failed epic=${quote.epic} source=${quote.source} seq=${quote.sequence}: ${msg}`
          );
          try {
            // Lazy import avoided — caller registers mark via setFanoutErrorHook
            fanoutErrorHook?.(quote.epic, err);
          } catch (hookErr) {
            console.error(
              `[FeedManager] fan-out error hook failed: ${
                hookErr instanceof Error ? hookErr.message : String(hookErr)
              }`
            );
          }
        }
      }
    }

    return quote;
  }

  /** Subscribe to each LIVE accepted quote after validation. */
  onAccepted(listener: (quote: FeedQuote) => void): () => void {
    this.acceptedListeners.push(listener);
    return () => {
      const i = this.acceptedListeners.indexOf(listener);
      if (i >= 0) this.acceptedListeners.splice(i, 1);
    };
  }

  markOffline(source: string, epic: string, detail = 'connection lost'): FeedQuote {
    return this.ingest({
      source,
      epic,
      force_status: 'OFFLINE',
      detail,
      bid: null,
      ask: null,
    });
  }

  snapshot(epic: string): FeedManagerSnapshot {
    const map = this.byEpic.get(epic) || new Map();
    const all = [...map.values()];
    const primary = all.find((q) => q.role === 'PRIMARY') || null;
    const confirmation = all.filter((q) => q.role === 'CONFIRMATION');
    const reference = all.filter((q) => q.role === 'REFERENCE');
    const fallback = all.filter((q) => q.role === 'FALLBACK');

    const primary_status: FeedStatus | 'MISSING' = primary ? primary.status : 'MISSING';
    let allows_execution = false;
    let block_reason: string | null = null;

    if (!primary) {
      block_reason = 'PRIMARY_FEED_MISSING';
    } else if (primary.status === 'OFFLINE') {
      block_reason = 'PRIMARY_FEED_OFFLINE';
    } else if (primary.status === 'STALE') {
      block_reason = 'PRIMARY_FEED_STALE';
    } else if (primary.status === 'ERROR') {
      block_reason = 'PRIMARY_FEED_ERROR';
    } else if (primary.status === 'DEGRADED') {
      block_reason = 'PRIMARY_FEED_DEGRADED';
    } else if (primary.status === 'LIVE') {
      allows_execution = true;
    } else {
      block_reason = `PRIMARY_FEED_${primary.status}`;
    }

    return {
      epic,
      primary,
      confirmation,
      reference,
      fallback,
      primary_status,
      allows_execution,
      block_reason,
    };
  }
}
