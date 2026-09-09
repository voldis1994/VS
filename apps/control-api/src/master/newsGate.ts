/**
 * News hard-gate — Reader evaluate_news_filter + Check- news_filter_enabled.
 *
 * Priority:
 * 1. MASTER_NEWS_FILTER=true → Check- style force-block (treat as high impact)
 * 2. MASTER_NEWS_IMPACT=high|medium|low|off
 * 3. MASTER_STATE_DIR/news_window.json { impact, until_ms? }
 * 4. Forex Factory weekly calendar cache (VS-System faireconomy) for symbol
 * 5. UTC calendar heuristic (NFP first Friday 12:25–14:30 UTC)
 *
 * news_window.json is also DualPersist / MemoryPersist / PG primary so a full
 * file wipe does not fail-open the high-impact hard-gate.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isNewsCalendarBlocked } from './newsCalendar.js';
import {
  persistNewsWindowState,
  loadNewsWindowFromPersist,
} from './persist.js';
import { embedOperatorMetaPatch } from './operatorMetaEmbed.js';

export type NewsImpact = 'off' | 'low' | 'medium' | 'high';

export type NewsWindowState = {
  impact: NewsImpact;
  window_active: boolean;
  source: string;
  detail: string;
};

export type NewsWindowDiskPayload = {
  impact: string;
  until_ms?: number | null;
  active?: boolean;
  detail?: string | null;
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

function stateDir(root?: string): string {
  return (
    root ||
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function newsPath(root?: string): string {
  return join(stateDir(root), 'news_window.json');
}

function loadNewsFile(root?: string): NewsWindowState | null {
  try {
    // Vitest without explicit MASTER_STATE_DIR must not inherit cwd sidecar from
    // prior runtime ticks (would dual-starve filter unit tests).
    if (
      !root &&
      process.env.VITEST &&
      !process.env.MASTER_STATE_DIR &&
      !process.env.MASTER_GATES_DIR
    ) {
      return null;
    }
    const path = newsPath(root);
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

/** Durable write + DualPersist primary — operator / calendar hard-gate. */
export function saveNewsWindow(
  input: NewsWindowDiskPayload,
  root?: string
): boolean {
  try {
    const dir = stateDir(root);
    mkdirSync(dir, { recursive: true });
    const impact = parseImpact(input.impact) ?? 'off';
    const payload: NewsWindowDiskPayload = {
      impact,
      until_ms:
        input.until_ms != null && Number.isFinite(Number(input.until_ms))
          ? Number(input.until_ms)
          : null,
      active: input.active === true || impact === 'high',
      detail: input.detail ?? null,
    };
    writeFileSync(newsPath(root), JSON.stringify(payload));
    embedOperatorMetaPatch(
      { news_window: payload as unknown as Record<string, unknown> },
      dir
    );
    void persistNewsWindowState({
      ...payload,
      saved_at_ms: Date.now(),
    }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist an active high-impact window so wipe+restart does not fail-open
 * before calendar refresh. Extends until_ms ~45m when not provided.
 */
export function rememberHighImpactNewsWindow(
  state: NewsWindowState,
  nowMs = Date.now(),
  root?: string
): boolean {
  if (!(state.window_active && state.impact === 'high')) return false;
  // File source already durable; still dual-write primary
  const until = nowMs + 45 * 60_000;
  return saveNewsWindow(
    {
      impact: 'high',
      until_ms: until,
      active: true,
      detail: state.detail || state.source,
    },
    root
  );
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

/**
 * When news_window.json was wiped but DualPersist/PG primary still holds
 * the singleton payload, rewrite the sidecar before filter / status reads.
 */
export async function hydrateNewsWindowFromPersist(
  root?: string
): Promise<{ restored: boolean }> {
  const dir = stateDir(root);
  const path = newsPath(root);
  if (existsSync(path)) return { restored: false };
  try {
    const loaded = await loadNewsWindowFromPersist();
    if (!loaded || typeof loaded !== 'object') return { restored: false };
    const impact = parseImpact(loaded.impact);
    if (!impact || impact === 'off') {
      // active:true without impact still means high
      if (loaded.active !== true) return { restored: false };
    }
    const until =
      loaded.until_ms != null && Number.isFinite(Number(loaded.until_ms))
        ? Number(loaded.until_ms)
        : null;
    if (until != null && Date.now() > until) return { restored: false };
    const resolvedImpact = impact && impact !== 'off' ? impact : 'high';
    mkdirSync(dir, { recursive: true });
    const payload: NewsWindowDiskPayload = {
      impact: resolvedImpact,
      until_ms: until,
      active: true,
      detail:
        typeof loaded.detail === 'string' && loaded.detail
          ? loaded.detail
          : `healed impact=${resolvedImpact}`,
    };
    writeFileSync(path, JSON.stringify(payload));
    embedOperatorMetaPatch(
      { news_window: payload as unknown as Record<string, unknown> },
      dir
    );
    return { restored: true };
  } catch {
    return { restored: false };
  }
}
