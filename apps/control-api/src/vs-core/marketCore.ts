/**
 * Market Core — validated market state. Stale/invalid/future/out-of-order must not drive orders.
 */

export type MarketQuality =
  | 'OK'
  | 'STALE'
  | 'OFFLINE'
  | 'INVALID'
  | 'DUPLICATE'
  | 'OUT_OF_ORDER'
  | 'FUTURE_TIMESTAMP';

export type ValidatedTick = {
  epic: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  source: string;
  source_timestamp: string;
  receive_timestamp: string;
  sequence: number;
  source_sequence?: number | null;
  age_ms: number;
  quality: MarketQuality;
  market_status: string | null;
  accepted: boolean;
  instrument_meta?: Record<string, unknown>;
};

export type MarketCoreState = {
  epic: string;
  last: ValidatedTick | null;
  status: MarketQuality | 'OFFLINE';
  reason: string | null;
  last_source_ts_ms: number | null;
  last_source_sequence: number | null;
};

const DEFAULT_STALE_MS = 5000;
const FUTURE_SKEW_MS = 2000;

export class MarketCore {
  private seq = 0;
  private byEpic = new Map<string, MarketCoreState>();
  private readonly staleMs: number;
  private seenFingerprints = new Map<string, number>(); // epic+fp → expire

  constructor(staleMs = DEFAULT_STALE_MS) {
    this.staleMs = staleMs;
  }

  ingest(input: {
    epic: string;
    bid: number | null | undefined;
    ask: number | null | undefined;
    source: string;
    source_timestamp?: string | null;
    source_sequence?: number | null;
    market_status?: string | null;
    now?: number;
    instrument_meta?: Record<string, unknown>;
  }): ValidatedTick {
    const now = input.now ?? Date.now();
    const receive = new Date(now).toISOString();
    const bid = input.bid;
    const ask = input.ask;
    const prev = this.byEpic.get(input.epic);

    let quality: MarketQuality = 'OK';
    let reason: string | null = null;
    let accepted = true;

    if (
      bid == null ||
      ask == null ||
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      ask < bid
    ) {
      quality = 'INVALID';
      reason = 'malformed bid/ask';
      accepted = false;
    }

    const sourceTs = input.source_timestamp ? Date.parse(input.source_timestamp) : now;
    let age_ms = 0;
    if (!Number.isFinite(sourceTs)) {
      quality = 'INVALID';
      reason = 'invalid source_timestamp';
      accepted = false;
    } else {
      age_ms = Math.max(0, now - sourceTs);
      if (quality === 'OK' && sourceTs - now > FUTURE_SKEW_MS) {
        quality = 'FUTURE_TIMESTAMP';
        reason = `source_ts ${sourceTs - now}ms in future`;
        accepted = false;
      }
      if (quality === 'OK' && age_ms > this.staleMs) {
        quality = 'STALE';
        reason = `Tick age ${age_ms}ms > ${this.staleMs}ms`;
        accepted = false;
      }
    }

    const fp = `${input.source}|${input.source_timestamp}|${bid}|${ask}|${input.source_sequence ?? ''}`;
    const fpKey = `${input.epic}|${fp}`;
    if (accepted && this.seenFingerprints.has(fpKey)) {
      quality = 'DUPLICATE';
      reason = 'duplicate tick fingerprint';
      accepted = false;
    }

    if (
      accepted &&
      input.source_sequence != null &&
      prev?.last_source_sequence != null &&
      input.source_sequence < prev.last_source_sequence
    ) {
      quality = 'OUT_OF_ORDER';
      reason = `seq ${input.source_sequence} < ${prev.last_source_sequence}`;
      accepted = false;
    }

    if (
      accepted &&
      Number.isFinite(sourceTs) &&
      prev?.last_source_ts_ms != null &&
      sourceTs + 1 < prev.last_source_ts_ms &&
      input.source_sequence == null
    ) {
      quality = 'OUT_OF_ORDER';
      reason = 'source_timestamp older than last accepted';
      accepted = false;
    }

    const mid = !accepted || quality === 'INVALID' ? NaN : (bid! + ask!) / 2;
    const spread = !accepted || quality === 'INVALID' ? NaN : ask! - bid!;
    const tick: ValidatedTick = {
      epic: input.epic,
      bid: bid ?? NaN,
      ask: ask ?? NaN,
      mid,
      spread,
      source: input.source,
      source_timestamp: input.source_timestamp || receive,
      receive_timestamp: receive,
      sequence: ++this.seq,
      source_sequence: input.source_sequence ?? null,
      age_ms,
      quality,
      market_status: input.market_status ?? null,
      accepted,
      instrument_meta: input.instrument_meta,
    };

    if (accepted) {
      this.seenFingerprints.set(fpKey, now + 60_000);
      this.byEpic.set(input.epic, {
        epic: input.epic,
        last: tick,
        status: quality,
        reason,
        last_source_ts_ms: Number.isFinite(sourceTs) ? sourceTs : null,
        last_source_sequence: input.source_sequence ?? prev?.last_source_sequence ?? null,
      });
    } else {
      // Keep last good state; surface rejection on returned tick
      if (!prev) {
        this.byEpic.set(input.epic, {
          epic: input.epic,
          last: tick,
          status: quality,
          reason,
          last_source_ts_ms: null,
          last_source_sequence: null,
        });
      } else {
        this.byEpic.set(input.epic, {
          ...prev,
          reason: `${prev.reason || prev.status}; rejected=${quality}:${reason}`,
        });
      }
    }

    // prune fingerprints
    for (const [k, exp] of this.seenFingerprints) {
      if (exp < now) this.seenFingerprints.delete(k);
    }

    return tick;
  }

  markOffline(epic: string, reason = 'Network offline'): void {
    const prev = this.byEpic.get(epic);
    this.byEpic.set(epic, {
      epic,
      last: prev?.last ?? null,
      status: 'OFFLINE',
      reason,
      last_source_ts_ms: prev?.last_source_ts_ms ?? null,
      last_source_sequence: prev?.last_source_sequence ?? null,
    });
  }

  get(epic: string): MarketCoreState | undefined {
    return this.byEpic.get(epic);
  }

  allowsTrading(epic: string): boolean {
    const s = this.byEpic.get(epic);
    if (!s || !s.last || !s.last.accepted) return false;
    if (s.status !== 'OK') return false;
    const ms = (s.last.market_status || '').toUpperCase();
    return ms === 'TRADEABLE' || ms === 'OPEN';
  }
}

export function marketAllowsStatus(marketStatus: string | null | undefined): boolean {
  const ms = String(marketStatus || '').toUpperCase();
  return ms === 'TRADEABLE' || ms === 'OPEN';
}
