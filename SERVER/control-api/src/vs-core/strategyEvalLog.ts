/**
 * Strategy evaluation observability — non-secret JSONL for market validation.
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

export type StrategyEvalRecord = {
  timestamp: string;
  market: string;
  regime: string;
  bias: string;
  setup_candidate: string | null;
  evidence: Record<string, unknown>;
  decision: string;
  reason: string;
  reference_price: number | null;
  invalidation_reason: string | null;
};

let disabled = false;

export function disableStrategyEvalLogForTests(disable = true): void {
  disabled = disable;
}

export function recordStrategyEvaluation(rec: StrategyEvalRecord): void {
  if (disabled) return;
  if (process.env.VS_STRATEGY_EVAL_LOG === '0') return;
  try {
    const root =
      process.env.VS_SERVER_DATA ||
      process.env.VS_CORE_DATA ||
      join(process.cwd(), 'data', 'vs-server');
    const path = join(root, 'strategy', 'evaluations.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    // Scrub accidental secrets
    const safe = {
      ...rec,
      evidence: scrub(rec.evidence),
      reason: String(rec.reason || '').slice(0, 500),
    };
    appendFileSync(path, JSON.stringify(safe) + '\n', { mode: 0o600 });
  } catch {
    /* never break Strategy on log IO */
  }
}

function scrub(ev: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev || {})) {
    if (/token|secret|password|private|key/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}
