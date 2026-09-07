/**
 * Forex Factory weekly calendar (faireconomy mirror) — VS-System NewsCalendarService.
 * Cached sync reads for the filter path; refresh from runtime tick.
 */
export type CalendarNewsImpact = 'Low' | 'Medium' | 'High' | 'Holiday' | string;

export type CalendarNewsEvent = {
  title: string;
  country: string;
  date: string;
  impact: CalendarNewsImpact;
  forecast?: string;
  previous?: string;
};

export type CalendarNewsBlock = {
  blocked: boolean;
  reason?: string;
  event?: CalendarNewsEvent;
  minutesUntil?: number;
};

const DEFAULT_FEED =
  process.env.MASTER_NEWS_CALENDAR_URL ||
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

const CACHE_TTL_MS = 5 * 60_000;

let cache: { at: number; events: CalendarNewsEvent[] } | null = null;
let inflight: Promise<CalendarNewsEvent[]> | null = null;

/** Map broker symbol → currency countries that matter for news. */
export function currenciesForSymbol(symbol: string): string[] {
  const s = String(symbol ?? '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  const map: Record<string, string[]> = {
    EURUSD: ['EUR', 'USD'],
    GBPUSD: ['GBP', 'USD'],
    USDJPY: ['USD', 'JPY'],
    USDCHF: ['USD', 'CHF'],
    AUDUSD: ['AUD', 'USD'],
    NZDUSD: ['NZD', 'USD'],
    USDCAD: ['USD', 'CAD'],
    EURGBP: ['EUR', 'GBP'],
    EURJPY: ['EUR', 'JPY'],
    GBPJPY: ['GBP', 'JPY'],
    XAUUSD: ['USD'],
    GOLD: ['USD'],
    XAGUSD: ['USD'],
    SILVER: ['USD'],
    BTCUSD: ['USD'],
    ETHUSD: ['USD'],
    USOIL: ['USD'],
    UKOIL: ['GBP', 'USD'],
  };
  if (map[s]) return map[s]!;
  const m = s.match(/([A-Z]{3})([A-Z]{3})/);
  if (m) return [m[1]!, m[2]!];
  if (s.includes('USD') || s.includes('XAU') || s.includes('GOLD')) return ['USD'];
  return ['USD', 'EUR', 'GBP'];
}

export function impactRank(impact: string): number {
  const i = String(impact || '').toLowerCase();
  if (i === 'high') return 3;
  if (i === 'medium') return 2;
  if (i === 'low') return 1;
  return 0;
}

export function getCachedNewsEvents(): CalendarNewsEvent[] {
  return cache?.events ?? [];
}

/** Inject events for tests. */
export function setNewsCalendarCacheForTest(
  events: CalendarNewsEvent[],
  at = Date.now()
): void {
  cache = { at, events };
}

export function clearNewsCalendarCacheForTest(): void {
  cache = null;
  inflight = null;
}

export async function refreshNewsCalendar(force = false): Promise<CalendarNewsEvent[]> {
  if (
    !force &&
    cache &&
    Date.now() - cache.at < CACHE_TTL_MS
  ) {
    return cache.events;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch(DEFAULT_FEED, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        return cache?.events ?? [];
      }
      const raw = (await res.json()) as CalendarNewsEvent[];
      const events = Array.isArray(raw) ? raw : [];
      cache = { at: Date.now(), events };
      return events;
    } catch {
      return cache?.events ?? [];
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Sync block check against cache (call refreshNewsCalendar from runtime first).
 */
export function isNewsCalendarBlocked(input: {
  symbol: string;
  nowMs?: number;
  minutesBefore?: number;
  minutesAfter?: number;
  minImpact?: 'Medium' | 'High';
  enabled?: boolean;
}): CalendarNewsBlock {
  if (input.enabled === false) return { blocked: false };
  const before = Math.max(0, input.minutesBefore ?? 30);
  const after = Math.max(0, input.minutesAfter ?? 15);
  const minRank = impactRank(input.minImpact ?? 'High');
  const countries = new Set(currenciesForSymbol(input.symbol));
  const events = getCachedNewsEvents();
  const now = input.nowMs ?? Date.now();

  for (const ev of events) {
    if (impactRank(String(ev.impact)) < minRank) continue;
    if (!countries.has(String(ev.country).toUpperCase())) continue;
    const t = new Date(ev.date).getTime();
    if (!Number.isFinite(t)) continue;
    const start = t - before * 60_000;
    const end = t + after * 60_000;
    if (now >= start && now <= end) {
      return {
        blocked: true,
        reason: `news_calendar_${ev.impact}_${ev.country}_${ev.title}`.slice(0, 120),
        event: ev,
        minutesUntil: Math.round((t - now) / 60_000),
      };
    }
  }
  return { blocked: false };
}
