/**
 * Live public market feed for MASTER — real internet quotes (Yahoo / Aurum / FX).
 * Enables live-data PAPER path without Capital credentials.
 *
 * Structure bars (Yahoo OHLC) are kept separate from 10s tick overlays so flat
 * mid polls cannot erase real ATR / trend into neutral score starvation.
 */
import {
  epicToYahooSymbol,
  fusePriceMids,
  readAllPublicFeeds,
  type PublicFeedRead,
} from '../services/publicInternetFeeds.js';
import type { Bar, Quote } from './types.js';

export type LiveMarketSnapshot = {
  ok: boolean;
  quote: Quote | null;
  sources: PublicFeedRead[];
  contributing: number;
  /** Finite public mids used for fusion / divergence gates */
  mids: number[];
  agreement: 'STRONG' | 'OK' | 'DIVERGENT' | 'INSUFFICIENT' | 'NONE';
  span: number;
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
      mids: [],
      agreement: 'NONE',
      span: 0,
      detail: sources.map((s) => `${s.sender_id}:${s.detail || 'fail'}`).join('; ') || 'no_feeds',
    };
  }

  const mids = okReads.map((s) => s.mid!);
  const fused = fusePriceMids(mids, { mixedPublic: true });
  const mid = fused.mid ?? mids[Math.floor(mids.length / 2)]!;

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
    contributing: fused.contributing || okReads.length,
    mids,
    agreement: fused.agreement,
    span: fused.span,
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
        // Yahoo pads null sessions as null → Number(null)===0; drop placeholders
        if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) continue;
        if (!(high >= low)) continue;
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

function barRange(b: Bar): number {
  return Math.max(0, b.high - b.low);
}

/** True when closed bar has meaningful range (not a flat mid poll). */
export function isMeaningfulBar(b: Bar, minRangeAbs = 0.05): boolean {
  return barRange(b) >= minRangeAbs || Math.abs(b.close - b.open) >= minRangeAbs * 0.5;
}

/**
 * Map LiveBarBuilder justClosed → desk TenSecBar for SETUP/MOVE confirm.
 * Flat closes still count as closed_10s present (armed gate honesty); only
 * null/invalid OHLC is omitted.
 */
export function closed10sFromJustClosed(
  justClosed: Bar | null | undefined
): import('../services/tenSecondOhlc.js').TenSecBar | null {
  if (!justClosed) return null;
  const { open, high, low, close } = justClosed;
  if (
    ![open, high, low, close].every((n) => Number.isFinite(n)) ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0
  ) {
    return null;
  }
  const open_time_ms =
    typeof justClosed.ts_ms === 'number' && Number.isFinite(justClosed.ts_ms)
      ? justClosed.ts_ms
      : 0;
  return {
    open_time_ms,
    open,
    high,
    low,
    close,
    // Mid-poll builder has no tick count — one closed OHLC still arms confirm
    ticks: 1,
  };
}

/**
 * Rolling bar builder from live ticks.
 * Yahoo structure OHLC is preserved; flat 10s closes never displace it.
 */
/**
 * Capital LIVE entries require venue OHLC structure — Yahoo/synthetic must not
 * drive regime/candidates against Capital marks. Manage-only stays allowed.
 * Test/demo synthetic feeds opt out via allowSynthetic.
 */
export function capitalLiveEntriesAllowed(
  seed_source: string,
  opts?: { allowSynthetic?: boolean }
): boolean {
  const s = String(seed_source || 'none');
  if (s === 'capital_ohlc') return true;
  if (opts?.allowSynthetic && (s === 'synthetic_fallback' || s === 'none')) {
    return true;
  }
  return false;
}

export class LiveBarBuilder {
  /** Real Yahoo (or synthetic seed) structure — analysis backbone */
  private structureBars: Bar[] = [];
  /** Recent non-flat closed tick bars only (overlay, capped) */
  private tickOverlay: Bar[] = [];
  private open: number | null = null;
  private high = 0;
  private low = 0;
  private close = 0;
  private barStart = 0;
  seed_source:
    | 'yahoo_ohlc'
    | 'capital_ohlc'
    | 'mt4_ohlc'
    | 'broker_ohlc'
    | 'synthetic_fallback'
    | 'none' = 'none';
  last_structure_refresh_ms = 0;

  constructor(
    private readonly barMs = 10_000,
    private readonly maxBars = 80,
    private readonly maxTickOverlay = 8
  ) {}

  /**
   * Capital LIVE entries require venue OHLC structure — Yahoo/synthetic must not
   * drive regime/candidates against Capital marks. Manage-only stays allowed.
   * Test/demo synthetic feeds opt out via allowSynthetic.
   */
  static capitalLiveEntriesAllowed(
    seed_source: LiveBarBuilder['seed_source'] | string,
    opts?: { allowSynthetic?: boolean }
  ): boolean {
    return capitalLiveEntriesAllowed(seed_source, opts);
  }

  /** Install real OHLC history (preferred). */
  seedBars(bars: Bar[], source: LiveBarBuilder['seed_source'] = 'yahoo_ohlc') {
    this.structureBars = bars.slice(-this.maxBars);
    this.tickOverlay = [];
    this.open = null;
    this.seed_source = source;
    this.last_structure_refresh_ms = Date.now();
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
    this.structureBars = out;
    this.tickOverlay = [];
    this.open = null;
    this.seed_source = 'synthetic_fallback';
    this.last_structure_refresh_ms = Date.now();
  }

  /** Map broker hist detail → honest seed_source label (never claim Capital for MT4). */
  private brokerSeedSource(
    detail: string | undefined
  ): LiveBarBuilder['seed_source'] {
    const d = String(detail || '');
    if (/mt4_bars_m1/i.test(d)) return 'mt4_ohlc';
    if (/capital/i.test(d)) return 'capital_ohlc';
    return 'broker_ohlc';
  }

  /**
   * Prefer broker OHLC (Capital/MT4 LIVE), then Yahoo; fall back to synthetic around mid.
   */
  async seedFromBrokerOrPublic(
    epic: string,
    liveMid: number,
    n = 40,
    brokerBars?: { ok: boolean; bars: Bar[]; detail: string } | null
  ): Promise<string> {
    if (brokerBars?.ok && brokerBars.bars.length >= 10) {
      this.seedBars(brokerBars.bars, this.brokerSeedSource(brokerBars.detail));
      return brokerBars.detail;
    }
    return this.seedFromPublic(epic, liveMid, n);
  }

  /** Prefer Yahoo OHLC; fall back to synthetic around live mid. */
  async seedFromPublic(epic: string, liveMid: number, n = 40): Promise<string> {
    const hist = await fetchYahooMinuteBars(epic, n);
    if (hist.ok && hist.bars.length >= 10) {
      this.seedBars(hist.bars, 'yahoo_ohlc');
      return hist.detail;
    }
    this.seedAround(liveMid, n);
    return `synthetic_fallback(${hist.detail})`;
  }

  /** Refresh structure on an interval — broker OHLC first when provided. */
  async refreshStructureIfStale(
    epic: string,
    liveMid: number,
    everyMs = 120_000,
    brokerBars?: { ok: boolean; bars: Bar[]; detail: string } | null
  ): Promise<string | null> {
    if (Date.now() - this.last_structure_refresh_ms < everyMs) return null;
    if (brokerBars?.ok && brokerBars.bars.length >= 10) {
      this.structureBars = brokerBars.bars.slice(-this.maxBars);
      this.seed_source = this.brokerSeedSource(brokerBars.detail);
      this.last_structure_refresh_ms = Date.now();
      return `refresh:${brokerBars.detail}`;
    }
    const hist = await fetchYahooMinuteBars(epic, 50);
    if (hist.ok && hist.bars.length >= 10) {
      this.structureBars = hist.bars.slice(-this.maxBars);
      this.seed_source = 'yahoo_ohlc';
      this.last_structure_refresh_ms = Date.now();
      return `refresh:${hist.detail}`;
    }
    this.last_structure_refresh_ms = Date.now();
    return `refresh_failed:${hist.detail}`;
  }

  pushTick(mid: number, now = Date.now()): { justClosed: Bar | null; bars: Bar[] } {
    let justClosed: Bar | null = null;
    if (this.open == null) {
      this.open = mid;
      this.high = mid;
      this.low = mid;
      this.close = mid;
      this.barStart = now;
      return { justClosed: null, bars: this.getAnalysisBars() };
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
      // Only keep non-flat closes — flat mid polls must not poison structure
      if (isMeaningfulBar(justClosed)) {
        this.tickOverlay = [...this.tickOverlay, justClosed].slice(-this.maxTickOverlay);
      }
      this.open = mid;
      this.high = mid;
      this.low = mid;
      this.close = mid;
      this.barStart = now;
    }

    return { justClosed, bars: this.getAnalysisBars() };
  }

  /** Structure OHLC + forming bar for freshness. Tick overlay kept separate —
   * even "meaningful" 10s bars poison 5m ATR when merged into the analysis window. */
  getAnalysisBars(): Bar[] {
    const forming: Bar[] = [];
    if (this.open != null) {
      forming.push({
        open: this.open,
        high: this.high,
        low: this.low,
        close: this.close,
        ts_ms: this.barStart,
      });
    }
    // Optionally tip with last meaningful tick close for momentum (max 1), not a pile
    const tip =
      this.tickOverlay.length > 0 ? [this.tickOverlay[this.tickOverlay.length - 1]!] : [];
    const merged = [...this.structureBars, ...tip, ...forming];
    return merged.slice(-this.maxBars);
  }

  getBars(): Bar[] {
    return this.getAnalysisBars();
  }

  structureCount() {
    return this.structureBars.length;
  }
}
