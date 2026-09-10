/**
 * Capital.com market streaming — VS-System capital-stream + ensureMarketStream.
 * REST getQuote remains fallback when WS is down.
 */
import WebSocket from 'ws';
import { capitalQuoteTsMs } from './capitalQuoteAge.js';

export type CapitalStreamQuote = {
  epic: string;
  bid: number;
  offer: number;
  mid: number;
  ts_ms: number;
};

/** Parse Capital streaming WS quote frame (destination: quote). */
export function parseCapitalStreamQuote(raw: string): CapitalStreamQuote | null {
  let msg: {
    destination?: string;
    payload?: Record<string, unknown>;
  };
  try {
    msg = JSON.parse(raw) as typeof msg;
  } catch {
    return null;
  }
  if (msg.destination !== 'quote' || !msg.payload) return null;
  const epic = String(msg.payload.epic ?? '');
  if (!epic) return null;
  const bidRaw = msg.payload.bid;
  const ofrRaw = msg.payload.ofr ?? msg.payload.offer;
  const bid = bidRaw == null || bidRaw === '' ? undefined : Number(bidRaw);
  const ofr = ofrRaw == null || ofrRaw === '' ? undefined : Number(ofrRaw);
  if (
    (bid == null || !Number.isFinite(bid)) &&
    (ofr == null || !Number.isFinite(ofr))
  ) {
    return null;
  }
  // One-sided quotes forge 0-spread mid — refuse so REST two-sided can win
  if (
    bid == null ||
    !Number.isFinite(bid) ||
    ofr == null ||
    !Number.isFinite(ofr)
  ) {
    return null;
  }
  const bidN = bid;
  const ofrN = ofr;
  // Venue payload.timestamp — never forge Date.now() (hides stale stream marks)
  const venueTs =
    msg.payload.timestamp ?? msg.payload.updateTime ?? msg.payload.update_time;
  return {
    epic,
    bid: bidN,
    offer: ofrN,
    mid: (bidN + ofrN) / 2,
    ts_ms: capitalQuoteTsMs(venueTs as string | number | null | undefined, Date.now(), {
      onMissing: 'receive',
    }),
  };
}

export function capitalStreamEndpoint(baseUrl: string): string {
  return String(baseUrl || '').includes('demo-api')
    ? 'wss://demo-streaming-capital.backend-capital.com/connect'
    : 'wss://api-streaming-capital.backend-capital.com/connect';
}

export type CapitalStreamTokens = {
  cst: string;
  securityToken: string;
  baseUrl: string;
};

/**
 * Lightweight Capital quote stream — one WS per session tokens.
 * Survives process while CapitalBroker holds it; REST remains fallback.
 */
export class CapitalQuoteStream {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private corr = 0;
  private epics = new Set<string>();
  private lastQuoteAt = 0;
  private latest = new Map<string, CapitalStreamQuote>();
  private tokens: CapitalStreamTokens | null = null;

  setTokens(tokens: CapitalStreamTokens | null) {
    this.tokens = tokens;
  }

  isHealthy(maxAgeMs = 30_000, epic?: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    // Per-epic freshness — a quote on SILVER must not keep GOLD stream "healthy"
    if (epic) {
      const q = this.getLatest(epic);
      return (
        !!q &&
        Number.isFinite(q.ts_ms) &&
        q.ts_ms > 0 &&
        Date.now() - q.ts_ms < maxAgeMs
      );
    }
    return this.lastQuoteAt > 0 && Date.now() - this.lastQuoteAt < maxAgeMs;
  }

  getLatest(epic: string): CapitalStreamQuote | null {
    const key = String(epic || '').trim().toUpperCase();
    if (!key) return null;
    // Exact / case-insensitive only — never substring (GOLDMICRO must not feed GOLD)
    for (const [k, v] of this.latest) {
      if (k.toUpperCase() === key) return v;
    }
    return this.latest.get(epic) ?? null;
  }

  async ensure(epics: string[]): Promise<'streaming' | 'fallback'> {
    if (!this.tokens?.cst || !this.tokens.securityToken) return 'fallback';
    const wanted = [...new Set(epics.map((e) => String(e || '').trim()).filter(Boolean))].slice(
      0,
      40
    );
    if (!wanted.length) return 'fallback';

    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        await this.connect();
      }
    } catch {
      return 'fallback';
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return 'fallback';

    const toAdd = wanted.filter((e) => !this.epics.has(e));
    const toRemove = [...this.epics].filter((e) => !wanted.includes(e));
    if (toRemove.length) {
      this.send('marketData.unsubscribe', { epics: toRemove });
      for (const e of toRemove) this.epics.delete(e);
    }
    if (toAdd.length) {
      this.send('marketData.subscribe', { epics: toAdd });
      for (const e of toAdd) this.epics.add(e);
    } else if (wanted.length && this.epics.size === 0) {
      this.send('marketData.subscribe', { epics: wanted });
      for (const e of wanted) this.epics.add(e);
    }
    return 'streaming';
  }

  /** Drop cached quotes so reconnect cannot claim healthy on pre-disconnect ticks. */
  private clearQuoteCache() {
    this.latest.clear();
    this.lastQuoteAt = 0;
  }

  stop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.epics.clear();
    this.connecting = null;
    this.clearQuoteCache();
  }

  private async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (!this.tokens) throw new Error('no_stream_tokens');
    const endpoint = capitalStreamEndpoint(this.tokens.baseUrl);
    this.connecting = new Promise<void>((resolve, reject) => {
      try {
        const ws = new WebSocket(endpoint);
        const timer = setTimeout(() => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error('Capital stream connect timeout'));
        }, 8_000);

        ws.on('open', () => {
          clearTimeout(timer);
          this.ws = ws;
          this.epics.clear();
          // New socket — ignore quotes from a prior connection
          this.clearQuoteCache();
          if (this.pingTimer) clearInterval(this.pingTimer);
          this.pingTimer = setInterval(() => this.send('ping'), 4 * 60_000);
          resolve();
        });

        ws.on('message', (data) => {
          const quote = parseCapitalStreamQuote(String(data));
          if (!quote) return;
          this.lastQuoteAt = Date.now();
          this.latest.set(quote.epic, quote);
        });

        ws.on('close', () => {
          clearTimeout(timer);
          if (this.ws === ws) this.ws = null;
          this.epics.clear();
          this.connecting = null;
          this.clearQuoteCache();
        });

        ws.on('error', () => {
          clearTimeout(timer);
          reject(new Error('Capital stream socket error'));
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private send(destination: string, payload?: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.tokens) return;
    this.corr += 1;
    const msg: Record<string, unknown> = {
      destination,
      correlationId: String(this.corr),
      cst: this.tokens.cst,
      securityToken: this.tokens.securityToken,
    };
    if (payload) msg.payload = payload;
    this.ws.send(JSON.stringify(msg));
  }
}
