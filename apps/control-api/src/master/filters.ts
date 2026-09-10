/**
 * FILTERS stage — shared gates applied to both BUY and SELL candidates.
 * Separated so the pipeline has one explicit filter owner (Reader-style).
 */
import { newsBlocksEntries } from './newsGate.js';
import { effectiveSpreadCaps } from './spreadCaps.js';
import { relativeSpreadAcceptable } from './spreadModel.js';
import { withinTradingHours } from './tradingHours.js';
import {
  calculateRelativeVolatility,
  relativeVolatilityAcceptable,
} from './volatility.js';
import type { AnalysisSnapshot, Bar, MasterConfig, Quote } from './types.js';

export type FilterVerdict = {
  ok: boolean;
  reason: string | null;
  checks: Record<string, boolean>;
};

export { effectiveSpreadCaps, isMetalEpic } from './spreadCaps.js';

/** Check- style weekend hard gate (UTC Sat/Sun). */
export function isWeekendUtc(nowMs = Date.now()): boolean {
  const d = new Date(nowMs).getUTCDay();
  return d === 0 || d === 6;
}

export function applyMarketFilters(
  a: AnalysisSnapshot,
  quote: Quote,
  cfg: MasterConfig,
  nowMs = Date.now(),
  bars?: Bar[] | null,
  relativeSpread?: number | null,
  symbol?: string | null
): FilterVerdict {
  const weekend = isWeekendUtc(nowMs);
  const news = newsBlocksEntries(
    cfg.block_high_impact_news,
    nowMs,
    symbol ?? quote.epic ?? null
  );
  const relVol = calculateRelativeVolatility(bars, cfg.volatility_lookback_bars);
  const relOk = relativeVolatilityAcceptable(relVol, cfg.max_relative_volatility);
  const caps = effectiveSpreadCaps(cfg, symbol ?? quote.epic);
  const relSpread =
    relativeSpread != null && Number.isFinite(relativeSpread) ? relativeSpread : null;
  // Relative z-score only when abs is already elevated — otherwise tight GOLD
  // history (std≈0.05) turns 0.4→0.7 into z>5 and kills ARMED setups.
  const nearAbsLimit = quote.spread > caps.max_spread_abs * 0.85;
  const spreadRelOk =
    relSpread == null ||
    !nearAbsLimit ||
    relativeSpreadAcceptable(relSpread, caps.max_relative_spread);
  const hoursOk = withinTradingHours(cfg.trading_hours, nowMs);
  const checks: Record<string, boolean> = {
    data_quality: a.data_quality >= 0.35,
    spread_abs: quote.spread <= caps.max_spread_abs,
    spread_pct: !(
      quote.mid > 0 && quote.spread / quote.mid > caps.max_spread_pct
    ),
    // Reader relative spread z-score (skipped until history exists / near abs)
    spread_relative: spreadRelOk,
    // UNKNOWN is tradeable-with-caution; only UNSTABLE hard-blocks both sides
    regime_stable: a.regime !== 'UNSTABLE',
    // Absolute vol (legacy) OR Reader relative TR spike
    volatility_ok: !(a.volatility > 0.008) && relOk,
    // Reader OFF session + Check- weekend — entries only in labeled weekday windows
    session_ok:
      !cfg.block_off_hours || (a.session !== 'OFF_HOURS' && !weekend),
    // Check- hard weekday hour windows (optional)
    trading_hours_ok: hoursOk,
    // Reader high-impact news + Check- MASTER_NEWS_FILTER
    news_ok: !news.blocked,
  };

  if (!checks.data_quality) return { ok: false, reason: 'data_quality', checks };
  if (!checks.spread_abs) return { ok: false, reason: 'spread_abs', checks };
  if (!checks.spread_pct) return { ok: false, reason: 'spread_pct', checks };
  if (!checks.spread_relative) return { ok: false, reason: 'relative_spread', checks };
  if (!checks.regime_stable) return { ok: false, reason: `regime_${a.regime}`, checks };
  if (!checks.volatility_ok) {
    return {
      ok: false,
      reason: relOk ? 'abnormal_volatility' : 'relative_volatility',
      checks,
    };
  }
  if (!checks.session_ok) {
    return {
      ok: false,
      reason: weekend ? 'session_weekend' : 'session_off_hours',
      checks,
    };
  }
  if (!checks.trading_hours_ok) {
    return { ok: false, reason: 'trading_hours', checks };
  }
  if (!checks.news_ok) {
    return { ok: false, reason: news.reason || 'news_high_impact', checks };
  }
  return { ok: true, reason: null, checks };
}
