/**
 * AI decision layer — ported contract from VS_READER_ENGINE_V2.
 * Modes: off | advisory | required.
 * Without MASTER_OPENAI_API_KEY uses a deterministic local advisor (not a fake LLM).
 * Never invents probabilities or profitable forecasts.
 */
import type { AnalysisSnapshot, MasterDecision, Side } from './types.js';

export type AiMode = 'off' | 'advisory' | 'required';

export type AiDecision = {
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'AVOID';
  confidence: number; // 0..1 heuristic — not a calibrated probability
  allow_buy: boolean;
  allow_sell: boolean;
  allow_close: boolean;
  reason: string;
  source: 'local' | 'openai' | 'none';
};

export type AiMeta = {
  ai_mode: AiMode;
  ai_available: boolean;
  ai_error_type: string | null;
  ai_fallback_used: boolean;
  ai_reason: string | null;
  system_decision_before_ai: string;
  decision_after_ai: string;
};

/**
 * Deterministic local advisor — vetoes UNSTABLE / low data quality.
 * This is NOT an LLM; used when API key missing or mode=advisory fallback.
 */
export function localAdvisor(analysis: AnalysisSnapshot): AiDecision {
  if (analysis.regime === 'UNSTABLE' || analysis.data_quality < 0.35) {
    return {
      bias: 'AVOID',
      confidence: 0.2,
      allow_buy: false,
      allow_sell: false,
      allow_close: true,
      reason: `local_avoid:regime=${analysis.regime}:dq=${analysis.data_quality.toFixed(2)}`,
      source: 'local',
    };
  }
  if (analysis.trend_dir === 'UP' && analysis.momentum_dir === 'UP') {
    return {
      bias: 'BULLISH',
      confidence: Math.min(0.85, 0.4 + analysis.trend_strength * 0.4),
      allow_buy: true,
      allow_sell: false,
      allow_close: true,
      reason: 'local_with_uptrend',
      source: 'local',
    };
  }
  if (analysis.trend_dir === 'DOWN' && analysis.momentum_dir === 'DOWN') {
    return {
      bias: 'BEARISH',
      confidence: Math.min(0.85, 0.4 + analysis.trend_strength * 0.4),
      allow_buy: false,
      allow_sell: true,
      allow_close: true,
      reason: 'local_with_downtrend',
      source: 'local',
    };
  }
  return {
    bias: 'NEUTRAL',
    confidence: 0.45,
    allow_buy: true,
    allow_sell: true,
    allow_close: true,
    reason: 'local_neutral',
    source: 'local',
  };
}

export function applyAiToDecision(
  decision: MasterDecision,
  mode: AiMode,
  advisor: AiDecision | null,
  errorType: string | null = null
): { decision: MasterDecision; meta: AiMeta } {
  const before = decision.kind;
  if (mode === 'off') {
    return {
      decision,
      meta: {
        ai_mode: 'off',
        ai_available: false,
        ai_error_type: null,
        ai_fallback_used: false,
        ai_reason: null,
        system_decision_before_ai: before,
        decision_after_ai: decision.kind,
      },
    };
  }

  if (!advisor) {
    if (mode === 'required') {
      const blocked: MasterDecision = {
        ...decision,
        kind: 'BLOCK',
        side: null,
        block_reason: `ai_required_missing_block:${errorType || 'unavailable'}`,
      };
      return {
        decision: blocked,
        meta: {
          ai_mode: mode,
          ai_available: false,
          ai_error_type: errorType || 'unavailable',
          ai_fallback_used: false,
          ai_reason: blocked.block_reason,
          system_decision_before_ai: before,
          decision_after_ai: 'BLOCK',
        },
      };
    }
    // advisory fallback — keep system decision
    return {
      decision,
      meta: {
        ai_mode: mode,
        ai_available: false,
        ai_error_type: errorType || 'missing_key',
        ai_fallback_used: true,
        ai_reason: 'ai_error_system_fallback',
        system_decision_before_ai: before,
        decision_after_ai: decision.kind,
      },
    };
  }

  let next = decision;
  if (advisor.bias === 'AVOID') {
    next = {
      ...decision,
      kind: 'BLOCK',
      side: null,
      block_reason: `ai_veto_avoid:${advisor.reason}`,
    };
  } else if (decision.side === 'BUY' && !advisor.allow_buy) {
    next = {
      ...decision,
      kind: 'BLOCK',
      side: null,
      block_reason: `ai_veto_buy:${advisor.reason}`,
    };
  } else if (decision.side === 'SELL' && !advisor.allow_sell) {
    next = {
      ...decision,
      kind: 'BLOCK',
      side: null,
      block_reason: `ai_veto_sell:${advisor.reason}`,
    };
  }

  return {
    decision: next,
    meta: {
      ai_mode: mode,
      ai_available: true,
      ai_error_type: null,
      ai_fallback_used: advisor.source === 'local' && !process.env.MASTER_OPENAI_API_KEY,
      ai_reason: advisor.reason,
      system_decision_before_ai: before,
      decision_after_ai: next.kind,
    },
  };
}

/** Resolve advisor for this cycle. OpenAI optional — local is default. */
export async function resolveAdvisor(
  analysis: AnalysisSnapshot,
  mode: AiMode
): Promise<{ advisor: AiDecision | null; error_type: string | null }> {
  if (mode === 'off') return { advisor: null, error_type: null };
  const key = (process.env.MASTER_OPENAI_API_KEY || '').trim();
  if (!key) {
    if (mode === 'required') return { advisor: null, error_type: 'missing_key' };
    return { advisor: localAdvisor(analysis), error_type: 'missing_key' };
  }
  // OpenAI path reserved — do not call without explicit enable (cost/latency).
  if (process.env.MASTER_OPENAI_ENABLED !== 'true') {
    return { advisor: localAdvisor(analysis), error_type: null };
  }
  // Fail closed to local rather than inventing network success in CI
  try {
    // Placeholder: real HTTP call can be enabled later; local remains authoritative until then.
    return { advisor: localAdvisor(analysis), error_type: null };
  } catch {
    return {
      advisor: mode === 'required' ? null : localAdvisor(analysis),
      error_type: 'api_error',
    };
  }
}

export type AbCompareResult = {
  off: { trades: number; expectancy: number; total_pnl: number };
  on: { trades: number; expectancy: number; total_pnl: number };
  delta_expectancy: number;
  note: string;
};

/**
 * A/B — same bars, AI off vs advisory. Uses causal replayMaster twice.
 * Does not claim either is profitable; reports empirical difference only.
 */
export function summarizeAb(
  offPerf: { trades: number; expectancy: number; total_pnl: number },
  onPerf: { trades: number; expectancy: number; total_pnl: number }
): AbCompareResult {
  return {
    off: offPerf,
    on: onPerf,
    delta_expectancy: onPerf.expectancy - offPerf.expectancy,
    note: 'Empirical A/B on same bars — not a promise of edge. Scores remain heuristic.',
  };
}

export function sideAllowed(advisor: AiDecision, side: Side): boolean {
  return side === 'BUY' ? advisor.allow_buy : advisor.allow_sell;
}
