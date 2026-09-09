/**
 * MASTER-owns → Client multi-account fanout after accepted OPEN.
 * Market Core EntryReady is blocked while owns_pipeline; MASTER becomes the publisher.
 */
import type { PipelineIntentInput } from '../services/intentFanout.js';

export type MasterFanoutOpenInput = {
  epic: string;
  side: 'BUY' | 'SELL';
  intent_id: string;
  reference_price?: number | null;
  regime?: string | null;
  setup_type?: string | null;
  explanation?: string | null;
};

/** Build EntryReady intent for Client Panel subscriptions (per-account lots). */
export function buildMasterFanoutIntent(
  input: MasterFanoutOpenInput
): PipelineIntentInput {
  const epic = String(input.epic || '').trim();
  const direction = input.side === 'SELL' ? 'SELL' : 'BUY';
  const idem = `master:${String(input.intent_id || '').trim()}`.slice(0, 190);
  return {
    epic,
    direction,
    decision: 'ENTRY_READY',
    idempotency_key: idem,
    reference_price:
      input.reference_price != null && Number.isFinite(input.reference_price)
        ? Number(input.reference_price)
        : null,
    regime: input.regime ? String(input.regime) : null,
    setup_type: input.setup_type ? String(input.setup_type) : null,
    explanation:
      input.explanation ||
      `MASTER owns_pipeline OPEN ${direction} ${epic}`,
  };
}

export type MasterFanoutSummary = {
  attempted: boolean;
  subscribers: number;
  ok_count: number;
  fail_count: number;
  detail: string;
};

export function summarizeFanoutResult(input: {
  attempted: boolean;
  subscribers?: number;
  executed?: Array<{ ok: boolean; detail: string }>;
  error?: string | null;
}): MasterFanoutSummary {
  if (!input.attempted) {
    return {
      attempted: false,
      subscribers: 0,
      ok_count: 0,
      fail_count: 0,
      detail: 'not_attempted',
    };
  }
  if (input.error) {
    return {
      attempted: true,
      subscribers: input.subscribers ?? 0,
      ok_count: 0,
      fail_count: 0,
      detail: `error:${input.error}`.slice(0, 240),
    };
  }
  const executed = input.executed || [];
  const ok_count = executed.filter((e) => e.ok).length;
  const fail_count = executed.length - ok_count;
  const subscribers = input.subscribers ?? executed.length;
  const firstFail = executed.find((e) => !e.ok)?.detail;
  return {
    attempted: true,
    subscribers,
    ok_count,
    fail_count,
    detail:
      subscribers === 0
        ? 'no_subscribers'
        : `ok=${ok_count}/${subscribers}${firstFail ? ` · ${firstFail}` : ''}`.slice(
            0,
            240
          ),
  };
}
