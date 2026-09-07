/**
 * FILTERS stage — shared gates applied to both BUY and SELL candidates.
 * Separated so the pipeline has one explicit filter owner (Reader-style).
 */
import type { AnalysisSnapshot, MasterConfig, Quote } from './types.js';

export type FilterVerdict = {
  ok: boolean;
  reason: string | null;
  checks: Record<string, boolean>;
};

export function applyMarketFilters(
  a: AnalysisSnapshot,
  quote: Quote,
  cfg: MasterConfig
): FilterVerdict {
  const checks: Record<string, boolean> = {
    data_quality: a.data_quality >= 0.35,
    spread_abs: quote.spread <= cfg.max_spread_abs,
    spread_pct: !(quote.mid > 0 && quote.spread / quote.mid > cfg.max_spread_pct),
    // UNKNOWN is tradeable-with-caution; only UNSTABLE hard-blocks both sides
    regime_stable: a.regime !== 'UNSTABLE',
    volatility_ok: !(a.volatility > 0.008),
  };

  if (!checks.data_quality) return { ok: false, reason: 'data_quality', checks };
  if (!checks.spread_abs) return { ok: false, reason: 'spread_abs', checks };
  if (!checks.spread_pct) return { ok: false, reason: 'spread_pct', checks };
  if (!checks.regime_stable) return { ok: false, reason: `regime_${a.regime}`, checks };
  if (!checks.volatility_ok) return { ok: false, reason: 'abnormal_volatility', checks };
  return { ok: true, reason: null, checks };
}
