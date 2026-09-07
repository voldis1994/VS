/** Dual BUY/SELL candidates — independent component scores (heuristic, not probability). */
import { candleBiasFromBars, scalpStrictEntryAllowed } from './candleBias.js';
import { applyMarketFilters } from './filters.js';
import { isLateMoveOnBars } from './lateMove.js';
import type {
  AnalysisSnapshot,
  Bar,
  ComponentScores,
  MasterConfig,
  Quote,
  TradeCandidate,
} from './types.js';

const WEIGHTS: ComponentScores = {
  momentum: 0.18,
  trend: 0.18,
  structure: 0.16,
  pressure: 0.14,
  behavior: 0.1,
  impact: 0.12,
  context: 0.12,
};

function weighted(c: ComponentScores): number {
  let s = 0;
  let w = 0;
  for (const k of Object.keys(WEIGHTS) as (keyof ComponentScores)[]) {
    s += c[k] * WEIGHTS[k];
    w += WEIGHTS[k];
  }
  return w > 0 ? s / w : 0;
}

export function buildBuyComponents(a: AnalysisSnapshot): ComponentScores {
  const momentum = (a.momentum_score + 1) / 2;
  const trend =
    a.trend_dir === 'UP'
      ? a.trend_strength
      : a.trend_dir === 'DOWN'
        ? 1 - a.trend_strength
        : 0.5;
  const structure =
    a.structure_bias === 'BULLISH' ? 1 : a.structure_bias === 'BEARISH' ? 0 : 0.5;
  return {
    momentum,
    trend,
    structure,
    pressure: a.buy_pressure,
    behavior: a.behavior_bull,
    impact: a.impact_score,
    context: a.context_quality,
  };
}

export function buildSellComponents(a: AnalysisSnapshot): ComponentScores {
  const momentum = (1 - a.momentum_score) / 2;
  const trend =
    a.trend_dir === 'DOWN'
      ? a.trend_strength
      : a.trend_dir === 'UP'
        ? 1 - a.trend_strength
        : 0.5;
  const structure =
    a.structure_bias === 'BEARISH' ? 1 : a.structure_bias === 'BULLISH' ? 0 : 0.5;
  return {
    momentum,
    trend,
    structure,
    pressure: a.sell_pressure,
    behavior: a.behavior_bear,
    impact: a.impact_score,
    context: a.context_quality,
  };
}

export function buildCandidates(
  a: AnalysisSnapshot,
  quote: Quote,
  cfg: MasterConfig,
  bars?: Bar[] | null,
  relativeSpread?: number | null
): { buy: TradeCandidate; sell: TradeCandidate } {
  // Side-aware planned entry — matches ask/bid fills (not mid)
  const buyEntry = quote.ask;
  const sellEntry = quote.bid;
  const atrRef = quote.mid;
  const atr = Math.max(a.atr, Math.abs(atrRef) * 0.0003, 0.5);
  const buffer = atr * cfg.sl_buffer_atr_mult;
  const buySl = Math.min(a.swing_low - buffer, buyEntry - atr);
  const sellSl = Math.max(a.swing_high + buffer, sellEntry + atr);
  const buyRisk = Math.max(buyEntry - buySl, atr * 0.5);
  const sellRisk = Math.max(sellSl - sellEntry, atr * 0.5);

  const buyComp = buildBuyComponents(a);
  const sellComp = buildSellComponents(a);
  const buyScore = weighted(buyComp);
  const sellScore = weighted(sellComp);

  const filter = applyMarketFilters(a, quote, cfg, Date.now(), bars, relativeSpread);

  // Reader-style against-flow hard reject (per side — shared filter no longer dual-starves UNKNOWN)
  const buyAgainstDump = a.momentum_dir === 'DOWN' && a.trend_dir === 'DOWN';
  const sellAgainstRally = a.momentum_dir === 'UP' && a.trend_dir === 'UP';
  // Capital desk late-move — do not chase a bar that already ran
  const buyLate = isLateMoveOnBars('BUY', bars);
  const sellLate = isLateMoveOnBars('SELL', bars);

  // VS-System strict scalp candle gate (opt-in)
  let buyScalpBlock: string | null = null;
  let sellScalpBlock: string | null = null;
  if (cfg.scalp_strict_entry) {
    const { tf, micro } = candleBiasFromBars(bars);
    const buyGate = scalpStrictEntryAllowed({
      signal: 'BUY',
      tfBias: tf.bias,
      tfNetPct: tf.netPct,
      microBias: micro.bias,
      buyScore,
      sellScore,
      minEdge: cfg.scalp_min_edge,
    });
    const sellGate = scalpStrictEntryAllowed({
      signal: 'SELL',
      tfBias: tf.bias,
      tfNetPct: tf.netPct,
      microBias: micro.bias,
      buyScore,
      sellScore,
      minEdge: cfg.scalp_min_edge,
    });
    if (!buyGate.ok) buyScalpBlock = buyGate.skip || 'scalp_strict_entry';
    if (!sellGate.ok) sellScalpBlock = sellGate.skip || 'scalp_strict_entry';
  }

  const buy: TradeCandidate = {
    side: 'BUY',
    valid:
      buyScore >= cfg.min_score &&
      filter.ok &&
      a.regime !== 'UNSTABLE' &&
      !buyAgainstDump &&
      !buyLate &&
      !buyScalpBlock,
    score: buyScore,
    components: buyComp,
    entry: buyEntry,
    stop_loss: buySl,
    take_profit: buyEntry + buyRisk * cfg.reward_ratio,
    filter_ok: filter.ok && !buyAgainstDump && !buyLate && !buyScalpBlock,
    filter_reason: !filter.ok
      ? filter.reason
      : buyAgainstDump
        ? 'against_flow_dump'
        : buyLate
          ? 'late_move'
          : buyScalpBlock,
  };
  const sell: TradeCandidate = {
    side: 'SELL',
    valid:
      sellScore >= cfg.min_score &&
      filter.ok &&
      a.regime !== 'UNSTABLE' &&
      !sellAgainstRally &&
      !sellLate &&
      !sellScalpBlock,
    score: sellScore,
    components: sellComp,
    entry: sellEntry,
    stop_loss: sellSl,
    take_profit: sellEntry - sellRisk * cfg.reward_ratio,
    filter_ok: filter.ok && !sellAgainstRally && !sellLate && !sellScalpBlock,
    filter_reason: !filter.ok
      ? filter.reason
      : sellAgainstRally
        ? 'against_flow_rally'
        : sellLate
          ? 'late_move'
          : sellScalpBlock,
  };
  return { buy, sell };
}
