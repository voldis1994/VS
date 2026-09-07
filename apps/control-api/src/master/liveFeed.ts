/**
 * Live public market feed for MASTER — real internet quotes (Yahoo / Aurum / FX).
 * Enables live-data PAPER path without Capital credentials.
 */
import {
  epicToYahooSymbol,
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

export type YahooBarsResult = {
  ok: boolean;
  bars: Bar[];
  detail: string;
  symbol: string | null;
};

/**
 * Fetch real Yahoo OHLC for bootstrap — replaces synthetic seed when online.
 * Tries several interval/range combos (futures often empty on 1m/1d off-hours).
 */
export async function fetchYahooMinuteBars(
  epic = 'GOLD',
  maxBars = 60
): Promise<YahooBarsResult> {
  const symbol = epicToYahooSymbol(epic);
  if (!symbol) {
    return { ok: false, bars: [], detail: 'no_yahoo_symbol', symbol: null };
  }
  const attempts = [
    'interval=1m&range=1d',
    'interval=5m&range=5d',
    'interval=15m&range=5d',
    'interval=1h&range=1mo',
  ];
  let lastDetail = 'yahoo_no_bars';
  for (const q of attempts) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${q}`;
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'VS-MASTER/1.0 (+live-bars)',
        },
      });
      const json = (await res.json().catch(() => null)) as {
        chart?: {
          result?: Array<{
            timestamp?: number[];
            indicators?: {
              quote?: Array<{ open?: number[]; high?: number[]; low?: number[]; close?: number[] }>;
            };
          }>;
        };
      } | null;
      const result = json?.chart?.result?.[0];
      const ts = result?.timestamp || [];
      const quote = result?.indicators?.quote?.[0];
      if (!res.ok || !ts.length || !quote) {
        lastDetail = `yahoo_${q}_http_${res.status}_ts_${ts.length}`;
        continue;
      }
      const bars: Bar[] = [];
      for (let i = 0; i < ts.length; i++) {
        const open = Number(quote.open?.[i]);
        const high = Number(quote.high?.[i]);
        const low = Number(quote.low?.[i]);
        const close = Number(quote.close?.[i]);
        if (![open, high, low, close].every(Number.isFinite)) continue;
        bars.push({
          open,
          high,
          low,
          close,
          ts_ms: Number(ts[i]) * 1000,
        });
      }
      const sliced = bars.slice(-Math.max(10, maxBars));
      if (sliced.length >= 10) {
        return {
          ok: true,
          bars: sliced,
          detail: `yahoo_${symbol}_${q}_${sliced.length}_bars`,
          symbol,
        };
      }
      lastDetail = `yahoo_${q}_finite_${sliced.length}`;
    } catch (e) {
      lastDetail = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, bars: [], detail: lastDetail, symbol };
}

/** Rolling bar builder from live ticks — closes a bar every barMs. */
export class LiveBarBuilder {
  private bars: Bar[] = [];
  private open: number | null = null;
  private high = 0;
  private low = 0;
  private close = 0;
  private barStart = 0;
  seed_source: 'yahoo_ohlc' | 'synthetic_fallback' | 'none' = 'none';

  constructor(
    private readonly barMs = 10_000,
    private readonly maxBars = 80
  ) {}

  /** Install real OHLC history (preferred). */
  seedBars(bars: Bar[]) {
    this.bars = bars.slice(-this.maxBars);
    this.open = null;
    this.seed_source = 'yahoo_ohlc';
  }

  /**
   * Last-resort synthetic history when Yahoo OHLC is unavailable.
   * Marked explicitly — not claimed as live market structure.
   */
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
    this.seed_source = 'synthetic_fallback';
  }

  /** Prefer Yahoo 1m OHLC; fall back to synthetic around live mid. */
  async seedFromPublic(epic: string, liveMid: number, n = 40): Promise<string> {
    const hist = await fetchYahooMinuteBars(epic, n);
    if (hist.ok && hist.bars.length >= 10) {
      this.seedBars(hist.bars);
      return hist.detail;
    }
    this.seedAround(liveMid, n);
    return `synthetic_fallback(${hist.detail})`;
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
