/** Decision engine — BUY / SELL / WAIT / BLOCK. Scores are heuristic, not probability. */
import { randomUUID } from 'crypto';
import { buildCandidates } from './candidates.js';
import type {
  AnalysisSnapshot,
  ExpectancySnapshot,
  MasterConfig,
  MasterDecision,
  Quote,
  TradeCandidate,
} from './types.js';

export function decide(
  analysis: AnalysisSnapshot,
  quote: Quote,
  cfg: MasterConfig,
  expectancyLookup: (setupKey: string) => ExpectancySnapshot | null
): MasterDecision {
  const decision_id = randomUUID();
  const { buy, sell } = buildCandidates(analysis, quote, cfg);

  if (cfg.kill_switch) {
    return blocked(decision_id, buy, sell, analysis, null, 'kill_switch');
  }
  if (!buy.filter_ok && !sell.filter_ok) {
    return blocked(
      decision_id,
      buy,
      sell,
      analysis,
      null,
      buy.filter_reason || sell.filter_reason || 'filters'
    );
  }

  const preferred = pickPreferred(buy, sell);
  if (!preferred) {
    return {
      decision_id,
      kind: 'WAIT',
      side: null,
      score: Math.max(buy.score, sell.score),
      block_reason: 'no_valid_candidate',
      buy,
      sell,
      analysis,
      expectancy: null,
    };
  }

  const setup_key = setupKey(analysis, preferred.side);
  const exp = expectancyLookup(setup_key);
  if (
    cfg.require_positive_expectancy &&
    exp &&
    exp.samples >= cfg.min_expectancy_samples &&
    !exp.positive
  ) {
    return blocked(
      decision_id,
      buy,
      sell,
      analysis,
      exp,
      `negative_expectancy:${setup_key}:ev=${exp.ev.toFixed(4)}`
    );
  }

  return {
    decision_id,
    kind: preferred.side,
    side: preferred.side,
    score: preferred.score,
    block_reason: null,
    buy,
    sell,
    analysis,
    expectancy: exp,
  };
}

function pickPreferred(buy: TradeCandidate, sell: TradeCandidate): TradeCandidate | null {
  if (buy.valid && sell.valid) return buy.score >= sell.score ? buy : sell;
  if (buy.valid) return buy;
  if (sell.valid) return sell;
  return null;
}

function blocked(
  decision_id: string,
  buy: TradeCandidate,
  sell: TradeCandidate,
  analysis: AnalysisSnapshot,
  expectancy: ExpectancySnapshot | null,
  reason: string
): MasterDecision {
  return {
    decision_id,
    kind: 'BLOCK',
    side: null,
    score: Math.max(buy.score, sell.score),
    block_reason: reason,
    buy,
    sell,
    analysis,
    expectancy,
  };
}

export function setupKey(analysis: AnalysisSnapshot, side: 'BUY' | 'SELL'): string {
  return `${side}|${analysis.regime}|${analysis.trend_dir}|${analysis.session}`;
}
