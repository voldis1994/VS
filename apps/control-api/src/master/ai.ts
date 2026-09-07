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
 * This is NOT an LLM; used when API key missing or OpenAI unavailable.
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

function parseOpenAiDecision(raw: string): AiDecision | null {
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    const biasRaw = String(obj.bias || obj.stance || 'NEUTRAL').toUpperCase();
    const bias =
      biasRaw === 'BULLISH' || biasRaw === 'BEARISH' || biasRaw === 'AVOID'
        ? biasRaw
        : 'NEUTRAL';
    const confidence = Math.max(0, Math.min(1, Number(obj.confidence ?? 0.5)));
    return {
      bias,
      confidence: Number.isFinite(confidence) ? confidence : 0.5,
      allow_buy: obj.allow_buy !== false && bias !== 'AVOID' && bias !== 'BEARISH',
      allow_sell: obj.allow_sell !== false && bias !== 'AVOID' && bias !== 'BULLISH',
      allow_close: obj.allow_close !== false,
      reason: String(obj.reason || 'openai'),
      source: 'openai',
    };
  } catch {
    return null;
  }
}

/** Real OpenAI HTTP — VS_READER_ENGINE_V2 contract. Failures return null. */
export async function callOpenAiAdvisor(
  analysis: AnalysisSnapshot,
  apiKey: string
): Promise<{ advisor: AiDecision | null; error_type: string | null }> {
  const prompt = [
    'Return ONLY JSON with keys: bias (BULLISH|BEARISH|NEUTRAL|AVOID),',
    'confidence (0..1 heuristic), allow_buy, allow_sell, allow_close, reason.',
    'Do not invent calibrated probabilities or guaranteed profits.',
    `regime=${analysis.regime} trend=${analysis.trend_dir} mom=${analysis.momentum_dir}`,
    `dq=${analysis.data_quality} atr=${analysis.atr} state=${analysis.market_state}`,
  ].join('\n');
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.MASTER_OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0,
        messages: [
          { role: 'system', content: 'Return strictly valid JSON only.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      return { advisor: null, error_type: `openai_http_${res.status}` };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return { advisor: null, error_type: 'openai_empty' };
    const advisor = parseOpenAiDecision(content);
    if (!advisor) return { advisor: null, error_type: 'openai_parse' };
    return { advisor, error_type: null };
  } catch (e) {
    return {
      advisor: null,
      error_type: e instanceof Error ? e.message.slice(0, 80) : 'openai_error',
    };
  }
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

  const usedOpenAi = advisor.source === 'openai';
  return {
    decision: next,
    meta: {
      ai_mode: mode,
      // Only true when a real OpenAI decision was applied — never for local fallback
      ai_available: usedOpenAi,
      ai_error_type: usedOpenAi ? null : errorType,
      ai_fallback_used: !usedOpenAi,
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
  const key = (
    process.env.MASTER_OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    ''
  ).trim();
  if (!key) {
    if (mode === 'required') return { advisor: null, error_type: 'missing_key' };
    return { advisor: localAdvisor(analysis), error_type: 'missing_key' };
  }
  if (process.env.MASTER_OPENAI_ENABLED !== 'true') {
    return { advisor: localAdvisor(analysis), error_type: 'openai_disabled_use_local' };
  }
  const remote = await callOpenAiAdvisor(analysis, key);
  if (remote.advisor) return remote;
  if (mode === 'required') return { advisor: null, error_type: remote.error_type };
  return {
    advisor: localAdvisor(analysis),
    error_type: remote.error_type || 'openai_fallback_local',
  };
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
