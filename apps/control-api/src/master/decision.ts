/** Decision engine — BUY / SELL / WAIT / BLOCK. Scores are heuristic, not probability. */
import { randomUUID } from 'crypto';
import { buildCandidates } from './candidates.js';
import type { DeskEntryConfirm } from './deskEntryConfirm.js';
import type { MarketSetup } from '../services/marketSetup.js';
import type {
  AnalysisSnapshot,
  Bar,
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
  expectancyLookup: (setupKey: string) => ExpectancySnapshot | null,
  bars?: Bar[] | null,
  relativeSpread?: number | null,
  marketSetup?: MarketSetup | null,
  deskEntry?: DeskEntryConfirm | null,
  opts?: { closed_10s_present?: boolean }
): MasterDecision {
  const decision_id = randomUUID();
  const { buy, sell } = buildCandidates(analysis, quote, cfg, bars, relativeSpread);

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

  let preferred = pickPreferred(buy, sell, cfg.min_score_delta);

  // Desk 10s SETUP/MOVE confirm — prefer confirmed side when candidate is valid
  if (deskEntry) {
    const confirmed = deskEntry.side === 'BUY' ? buy : sell;
    if (confirmed.valid && confirmed.filter_ok) {
      preferred = confirmed;
    } else if (cfg.require_armed_setup) {
      return {
        decision_id,
        kind: 'WAIT',
        side: null,
        score: Math.max(buy.score, sell.score),
        block_reason: `setup_confirm_blocked:${deskEntry.source}:${deskEntry.side}`,
        buy,
        sell,
        analysis,
        expectancy: null,
      };
    }
  } else if (cfg.require_armed_setup && opts?.closed_10s_present) {
    // LIVE desk path: ARMED alone is not enough without closed 10s confirm
    return {
      decision_id,
      kind: 'WAIT',
      side: null,
      score: Math.max(buy.score, sell.score),
      block_reason: 'setup_confirm_pending',
      buy,
      sell,
      analysis,
      expectancy: null,
    };
  }

  if (!preferred) {
    const delta = Math.abs(buy.score - sell.score);
    const bothValid = buy.valid && sell.valid;
    const equalScores = bothValid && delta < 1e-12;
    const nearTie =
      bothValid && !equalScores && cfg.min_score_delta > 0 && delta < cfg.min_score_delta;
    return {
      decision_id,
      kind: 'WAIT',
      side: null,
      score: Math.max(buy.score, sell.score),
      block_reason: equalScores
        ? 'equal_scores'
        : nearTie
          ? 'score_delta_too_small'
          : 'no_valid_candidate',
      buy,
      sell,
      analysis,
      expectancy: null,
    };
  }

  // Desk SETUP consolidation — never fight an ARMED opposite-side sticky setup
  const setupGate = gatePreferredBySetup(preferred.side, marketSetup, cfg.require_armed_setup);
  if (setupGate) {
    return {
      decision_id,
      kind: 'WAIT',
      side: null,
      score: preferred.score,
      block_reason: setupGate,
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

/**
 * Desk sticky SETUP gate (callers pass setup only when gate is armed).
 * - Block when ARMED setup side conflicts with preferred (setup_side_mismatch).
 * - When requireArmed: also block NONE/FORMING/missing (setup_none).
 */
export function gatePreferredBySetup(
  preferredSide: 'BUY' | 'SELL',
  setup: MarketSetup | null | undefined,
  requireArmed: boolean
): string | null {
  const armed =
    !!setup &&
    setup.status === 'ARMED' &&
    (setup.side === 'BUY' || setup.side === 'SELL') &&
    setup.kind !== 'NONE';
  if (armed && setup!.side !== preferredSide) {
    return `setup_side_mismatch:${setup!.side}`;
  }
  if (requireArmed && !armed) {
    return 'setup_none';
  }
  return null;
}

/** Reader scorer: strict preference; equal/near-tie valid scores → null (WAIT). */
export function pickPreferred(
  buy: TradeCandidate,
  sell: TradeCandidate,
  minScoreDelta = 0
): TradeCandidate | null {
  if (buy.valid && sell.valid) {
    const delta = Math.abs(buy.score - sell.score);
    if (delta < Math.max(minScoreDelta, 0) || delta < 1e-12) return null;
    if (buy.score > sell.score) return buy;
    if (sell.score > buy.score) return sell;
    return null;
  }
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
