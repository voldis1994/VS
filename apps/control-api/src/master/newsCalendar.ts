/**
 * Forex Factory weekly calendar (faireconomy mirror) — VS-System NewsCalendarService.
 * Cached sync reads for the filter path; refresh from runtime tick.
 * Also DualPersist / disk / operator_meta so restart does not fail-open before fetch.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  persistNewsCalendarState,
  loadNewsCalendarFromPersist,
} from './persist.js';
import { embedOperatorMetaPatch } from './operatorMetaEmbed.js';

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
/** Disk cache may be older than TTL but still useful until live refresh. */
const DISK_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

let cache: { at: number; events: CalendarNewsEvent[] } | null = null;
let inflight: Promise<CalendarNewsEvent[]> | null = null;

function stateDir(root?: string): string {
  return (
    root ||
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function calendarPath(root?: string): string {
  return join(stateDir(root), 'news_calendar.json');
}

function normalizeEvents(raw: unknown): CalendarNewsEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e) =>
      e &&
      typeof e === 'object' &&
      typeof (e as CalendarNewsEvent).title === 'string' &&
      typeof (e as CalendarNewsEvent).date === 'string'
  ) as CalendarNewsEvent[];
}

function saveCalendarDisk(
  events: CalendarNewsEvent[],
  fetchedAtMs: number,
  root?: string
): boolean {
  try {
    const dir = stateDir(root);
    mkdirSync(dir, { recursive: true });
    const payload = {
      events,
      fetched_at_ms: fetchedAtMs,
    };
    writeFileSync(calendarPath(root), JSON.stringify(payload));
    embedOperatorMetaPatch(
      { news_calendar: payload as unknown as Record<string, unknown> },
      dir
    );
    void persistNewsCalendarState({
      events,
      fetched_at_ms: fetchedAtMs,
      saved_at_ms: Date.now(),
    }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function loadCalendarDisk(root?: string): {
  events: CalendarNewsEvent[];
  fetched_at_ms: number;
} | null {
  try {
    const path = calendarPath(root);
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      events?: unknown;
      fetched_at_ms?: number;
    };
    const events = normalizeEvents(raw.events);
    if (!events.length) return null;
    const fetched =
      typeof raw.fetched_at_ms === 'number' && Number.isFinite(raw.fetched_at_ms)
        ? raw.fetched_at_ms
        : Date.now();
    if (Date.now() - fetched > DISK_MAX_AGE_MS) return null;
    return { events, fetched_at_ms: fetched };
  } catch {
    return null;
  }
}

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
  if (cache?.events?.length) return cache.events;
  // Sync cold path — load disk so first filter after restart does not fail-open
  const disk = loadCalendarDisk();
  if (disk?.events.length) {
    cache = { at: disk.fetched_at_ms, events: disk.events };
    return cache.events;
  }
  return [];
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
  if (!cache) {
    const disk = loadCalendarDisk();
    if (disk?.events.length) {
      cache = { at: disk.fetched_at_ms, events: disk.events };
      if (!force && Date.now() - disk.fetched_at_ms < CACHE_TTL_MS) {
        return cache.events;
      }
    }
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch(DEFAULT_FEED, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        return cache?.events ?? loadCalendarDisk()?.events ?? [];
      }
      const raw = (await res.json()) as CalendarNewsEvent[];
      const events = normalizeEvents(raw);
      const at = Date.now();
      cache = { at, events };
      saveCalendarDisk(events, at);
      return events;
    } catch {
      return cache?.events ?? loadCalendarDisk()?.events ?? [];
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * When news_calendar.json was wiped but DualPersist/PG primary still holds
 * events, rewrite sidecar and seed memory before entry filters.
 */
export async function hydrateNewsCalendarFromPersist(
  root?: string
): Promise<{ restored: boolean; count: number }> {
  const dir = stateDir(root);
  const path = calendarPath(root);
  if (existsSync(path)) {
    const disk = loadCalendarDisk(root);
    if (disk?.events.length) {
      cache = { at: disk.fetched_at_ms, events: disk.events };
      return { restored: false, count: disk.events.length };
    }
  }
  try {
    const loaded = await loadNewsCalendarFromPersist();
    const events = normalizeEvents(loaded?.events);
    if (!events.length) return { restored: false, count: 0 };
    const fetched =
      typeof loaded?.fetched_at_ms === 'number' &&
      Number.isFinite(loaded.fetched_at_ms)
        ? loaded.fetched_at_ms
        : Date.now();
    if (Date.now() - fetched > DISK_MAX_AGE_MS) {
      return { restored: false, count: 0 };
    }
    mkdirSync(dir, { recursive: true });
    const payload = { events, fetched_at_ms: fetched };
    writeFileSync(path, JSON.stringify(payload));
    embedOperatorMetaPatch(
      { news_calendar: payload as unknown as Record<string, unknown> },
      dir
    );
    cache = { at: fetched, events };
    return { restored: true, count: events.length };
  } catch {
    return { restored: false, count: 0 };
  }
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
