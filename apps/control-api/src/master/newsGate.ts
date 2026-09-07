/**
 * News hard-gate — Reader evaluate_news_filter + Check- news_filter_enabled.
 *
 * Priority:
 * 1. MASTER_NEWS_FILTER=true → Check- style force-block (treat as high impact)
 * 2. MASTER_NEWS_IMPACT=high|medium|low|off
 * 3. MASTER_STATE_DIR/news_window.json { impact, until_ms? }
 * 4. Forex Factory weekly calendar cache (VS-System faireconomy) for symbol
 * 5. UTC calendar heuristic (NFP first Friday 12:25–14:30 UTC)
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isNewsCalendarBlocked } from './newsCalendar.js';

export type NewsImpact = 'off' | 'low' | 'medium' | 'high';

export type NewsWindowState = {
  impact: NewsImpact;
  window_active: boolean;
  source: string;
  detail: string;
};

function parseImpact(raw: unknown): NewsImpact | null {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (s === 'off' || s === 'none' || s === '0' || s === 'false') return 'off';
  if (s === 'low') return 'low';
  if (s === 'medium' || s === 'med') return 'medium';
  if (s === 'high' || s === 'true' || s === '1' || s === 'on') return 'high';
  return null;
}

/** First Friday of month — US NFP release window (approximate UTC). */
export function isNfpWindowUtc(nowMs: number): boolean {
  const d = new Date(nowMs);
  if (d.getUTCDay() !== 5) return false; // Friday
  if (d.getUTCDate() > 7) return false; // first Friday
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  // 12:25–14:30 UTC covers typical release + digest
  return mins >= 12 * 60 + 25 && mins < 14 * 60 + 30;
}

function loadNewsFile(): NewsWindowState | null {
  try {
    const dir =
      process.env.MASTER_STATE_DIR ||
      process.env.MASTER_GATES_DIR ||
      join(process.cwd(), '.master-state');
    const path = join(dir, 'news_window.json');
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      impact?: string;
      until_ms?: number;
      active?: boolean;
      detail?: string;
    };
    const until = raw.until_ms != null ? Number(raw.until_ms) : null;
    if (until != null && Number.isFinite(until) && Date.now() > until) {
      return {
        impact: 'off',
        window_active: false,
        source: 'file_expired',
        detail: 'news_window expired',
      };
    }
    const impact =
      parseImpact(raw.impact) ??
      (raw.active === true ? 'high' : raw.active === false ? 'off' : null);
    if (!impact) return null;
    return {
      impact,
      window_active: impact !== 'off',
      source: 'file',
      detail: raw.detail || `file impact=${impact}`,
    };
  } catch {
    return null;
  }
}

/** Resolve current news window from env / file / calendar. */
export function resolveNewsWindow(
  nowMs = Date.now(),
  symbol?: string | null
): NewsWindowState {
  // Check- style: when filter toggle is ON, block all new entries
  const filterOn = /^(1|true|yes|on)$/i.test(
    String(process.env.MASTER_NEWS_FILTER || '')
  );
  if (filterOn) {
    return {
      impact: 'high',
      window_active: true,
      source: 'env_filter',
      detail: 'MASTER_NEWS_FILTER=true (Check- style)',
    };
  }

  const envImpact = parseImpact(process.env.MASTER_NEWS_IMPACT);
  if (envImpact != null) {
    return {
      impact: envImpact,
      window_active: envImpact !== 'off',
      source: 'env_impact',
      detail: `MASTER_NEWS_IMPACT=${envImpact}`,
    };
  }

  const file = loadNewsFile();
  if (file) return file;

  // VS-System Forex Factory weekly feed (cache filled by runtime refresh)
  const cal = isNewsCalendarBlocked({
    symbol: symbol || 'GOLD',
    nowMs,
    minImpact: 'High',
  });
  if (cal.blocked) {
    return {
      impact: 'high',
      window_active: true,
      source: 'calendar_ff',
      detail: cal.reason || 'forex_factory_high_impact',
    };
  }

  if (isNfpWindowUtc(nowMs)) {
    return {
      impact: 'high',
      window_active: true,
      source: 'calendar_nfp',
      detail: 'first_friday_NFP_UTC_window',
    };
  }

  return {
    impact: 'off',
    window_active: false,
    source: 'none',
    detail: 'no_news_window',
  };
}

/**
 * Reader-style: block when high-impact window active and config enabled.
 * Check MASTER_NEWS_FILTER already elevates impact to high in resolveNewsWindow.
 */
export function newsBlocksEntries(
  blockHighImpact: boolean,
  nowMs = Date.now(),
  symbol?: string | null
): { blocked: boolean; reason: string | null; state: NewsWindowState } {
  const state = resolveNewsWindow(nowMs, symbol);
  const high = state.window_active && state.impact === 'high';
  if (blockHighImpact && high) {
    return {
      blocked: true,
      reason:
        state.source === 'calendar_ff'
          ? state.detail.slice(0, 80) || 'news_high_impact'
          : 'news_high_impact',
      state,
    };
  }
  return { blocked: false, reason: null, state };
}
