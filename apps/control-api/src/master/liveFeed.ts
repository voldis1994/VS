/**
 * Live public market feed for MASTER — real internet quotes (Yahoo / Aurum / FX).
 * Enables live-data PAPER path without Capital credentials.
 */
import {
  readAllPublicFeeds,
  type PublicFeedRead,
} from '../services/publicInternetFeeds.js';
import type { Bar, Quote } from './types.js';

export type LiveMarketSnapshot = {
  ok: boolean;
  quote: Quote | null;
  sources: PublicFeedRead[];
  contributing: number;
  detail: string;
};

/** Fuse public mids into one quote — prefer consensus mid, derive bid/ask. */
export async function fetchLiveMarket(epic = 'GOLD'): Promise<LiveMarketSnapshot> {
  const sources = await readAllPublicFeeds(epic);
  const okReads = sources.filter((s) => s.ok && s.mid != null && Number.isFinite(s.mid));
  if (!okReads.length) {
    return {
      ok: false,
      quote: null,
      sources,
      contributing: 0,
      detail: sources.map((s) => `${s.sender_id}:${s.detail || 'fail'}`).join('; ') || 'no_feeds',
    };
  }

  const mids = okReads.map((s) => s.mid!);
  mids.sort((a, b) => a - b);
  const mid = mids[Math.floor(mids.length / 2)]!;

  // Prefer a source that already has bid/ask; else synthesize tight spread
  const withBa = okReads.find((s) => s.bid != null && s.ask != null);
  let bid = withBa?.bid ?? mid - 0.25;
  let ask = withBa?.ask ?? mid + 0.25;
  if (ask < bid) {
    bid = mid - 0.25;
    ask = mid + 0.25;
  }
  const spread = ask - bid;

  return {
    ok: true,
    quote: { bid, ask, mid, spread, ts_ms: Date.now() },
    sources,
    contributing: okReads.length,
    detail: okReads.map((s) => s.sender_id).join('+'),
  };
}

/** Rolling bar builder from live ticks — closes a bar every barMs. */
export class LiveBarBuilder {
  private bars: Bar[] = [];
  private open: number | null = null;
  private high = 0;
  private low = 0;
  private close = 0;
  private barStart = 0;

  constructor(
    private readonly barMs = 10_000,
    private readonly maxBars = 80
  ) {}

  /** Seed with synthetic history around a live mid so analysis has enough bars. */
  seedAround(mid: number, n = 40) {
    const out: Bar[] = [];
    let px = mid - n * 0.15;
    const t0 = Date.now() - n * this.barMs;
    for (let i = 0; i < n; i++) {
      const o = px;
      const c = o + (i % 5 === 0 ? -0.2 : 0.25);
      out.push({
        open: o,
        high: Math.max(o, c) + 0.3,
        low: Math.min(o, c) - 0.2,
        close: c,
        ts_ms: t0 + i * this.barMs,
      });
      px = c;
    }
    this.bars = out;
    this.open = null;
  }

  pushTick(mid: number, now = Date.now()): { justClosed: Bar | null; bars: Bar[] } {
    let justClosed: Bar | null = null;
    if (this.open == null) {
      this.open = mid;
      this.high = mid;
      this.low = mid;
      this.close = mid;
      this.barStart = now;
      return { justClosed: null, bars: [...this.bars] };
    }

    this.high = Math.max(this.high, mid);
    this.low = Math.min(this.low, mid);
    this.close = mid;

    if (now - this.barStart >= this.barMs) {
      justClosed = {
        open: this.open,
        high: this.high,
        low: this.low,
        close: this.close,
        ts_ms: this.barStart,
      };
      this.bars = [...this.bars, justClosed].slice(-this.maxBars);
      this.open = mid;
      this.high = mid;
      this.low = mid;
      this.close = mid;
      this.barStart = now;
    }

    // Include forming bar for decision freshness
    const forming: Bar = {
      open: this.open,
      high: this.high,
      low: this.low,
      close: this.close,
      ts_ms: this.barStart,
    };
    return { justClosed, bars: [...this.bars, forming] };
  }

  getBars(): Bar[] {
    return [...this.bars];
  }
}
