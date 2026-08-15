/**
 * Market Core — validated market state. Stale data must not drive orders.
 */

export type MarketQuality = 'OK' | 'STALE' | 'OFFLINE' | 'INVALID';

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
  age_ms: number;
  quality: MarketQuality;
  market_status: string | null;
  instrument_meta?: Record<string, unknown>;
};

export type MarketCoreState = {
  epic: string;
  last: ValidatedTick | null;
  status: MarketQuality;
  reason: string | null;
};

const DEFAULT_STALE_MS = 5000;

export class MarketCore {
  private seq = 0;
  private byEpic = new Map<string, MarketCoreState>();
  private readonly staleMs: number;

  constructor(staleMs = DEFAULT_STALE_MS) {
    this.staleMs = staleMs;
  }

  ingest(input: {
    epic: string;
    bid: number | null | undefined;
    ask: number | null | undefined;
    source: string;
    source_timestamp?: string | null;
    market_status?: string | null;
    now?: number;
    instrument_meta?: Record<string, unknown>;
  }): ValidatedTick {
    const now = input.now ?? Date.now();
    const receive = new Date(now).toISOString();
    const bid = input.bid;
    const ask = input.ask;

    let quality: MarketQuality = 'OK';
    let reason: string | null = null;

    if (
      bid == null ||
      ask == null ||
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      ask < bid
    ) {
      quality = 'INVALID';
      reason = 'Invalid bid/ask';
    }

    const sourceTs = input.source_timestamp
      ? Date.parse(input.source_timestamp)
      : now;
    const age_ms = Number.isFinite(sourceTs) ? Math.max(0, now - sourceTs) : 0;
    if (quality === 'OK' && age_ms > this.staleMs) {
      quality = 'STALE';
      reason = `Tick age ${age_ms}ms > ${this.staleMs}ms`;
    }

    const mid = quality === 'INVALID' ? NaN : (bid! + ask!) / 2;
    const spread = quality === 'INVALID' ? NaN : ask! - bid!;
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
      age_ms,
      quality,
      market_status: input.market_status ?? null,
      instrument_meta: input.instrument_meta,
    };

    this.byEpic.set(input.epic, {
      epic: input.epic,
      last: tick,
      status: quality,
      reason,
    });
    return tick;
  }

  markOffline(epic: string, reason = 'Network offline'): void {
    const prev = this.byEpic.get(epic);
    this.byEpic.set(epic, {
      epic,
      last: prev?.last ?? null,
      status: 'OFFLINE',
      reason,
    });
  }

  get(epic: string): MarketCoreState | undefined {
    return this.byEpic.get(epic);
  }

  /** True only when quality OK and market TRADEABLE/OPEN. */
  allowsTrading(epic: string): boolean {
    const s = this.byEpic.get(epic);
    if (!s || !s.last) return false;
    if (s.status !== 'OK') return false;
    const ms = (s.last.market_status || '').toUpperCase();
    return ms === 'TRADEABLE' || ms === 'OPEN';
  }
}

export function marketAllowsStatus(marketStatus: string | null | undefined): boolean {
  const ms = String(marketStatus || '').toUpperCase();
  return ms === 'TRADEABLE' || ms === 'OPEN';
}
