/**
 * MASTER-owns → Client multi-account fanout after accepted OPEN.
 * Market Core EntryReady is blocked while owns_pipeline; MASTER becomes the publisher.
 */
import type { PipelineIntentInput } from '../services/intentFanout.js';
import type { MasterJournal } from './journal.js';
import type {
  ExecutionResult,
  MasterDecision,
  Mode,
  OpportunityRecord,
  RiskVerdict,
} from './types.js';

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
  /** Opportunities written into MASTER journal for successful Client fills */
  journaled_count?: number;
};

export function summarizeFanoutResult(input: {
  attempted: boolean;
  subscribers?: number;
  executed?: Array<{ ok: boolean; detail: string }>;
  error?: string | null;
  journaled_count?: number;
}): MasterFanoutSummary {
  if (!input.attempted) {
    return {
      attempted: false,
      subscribers: 0,
      ok_count: 0,
      fail_count: 0,
      detail: 'not_attempted',
      journaled_count: 0,
    };
  }
  if (input.error) {
    return {
      attempted: true,
      subscribers: input.subscribers ?? 0,
      ok_count: 0,
      fail_count: 0,
      detail: `error:${input.error}`.slice(0, 240),
      journaled_count: 0,
    };
  }
  const executed = input.executed || [];
  const ok_count = executed.filter((e) => e.ok).length;
  const fail_count = executed.length - ok_count;
  const subscribers = input.subscribers ?? executed.length;
  const firstFail = executed.find((e) => !e.ok)?.detail;
  const journaled = input.journaled_count ?? 0;
  return {
    attempted: true,
    subscribers,
    ok_count,
    fail_count,
    journaled_count: journaled,
    detail:
      subscribers === 0
        ? 'no_subscribers'
        : `ok=${ok_count}/${subscribers}${
            journaled ? ` · journaled=${journaled}` : ''
          }${firstFail ? ` · ${firstFail}` : ''}`.slice(0, 240),
  };
}

export type FanoutFillRow = {
  client_id: number;
  account_id: number;
  lot_size: number;
  ok: boolean;
  detail: string;
  entry_price: number | null;
};

/**
 * Mirror successful Client fanout fills into MASTER journal so
 * journal → performance sees multi-account opens (not status-only).
 */
export function journalMasterFanoutFills(input: {
  journal: MasterJournal;
  mode: Mode;
  epic: string;
  side: 'BUY' | 'SELL';
  intent_id: string;
  decision: MasterDecision | null;
  fills: FanoutFillRow[];
}): OpportunityRecord[] {
  const out: OpportunityRecord[] = [];
  if (!input.decision || !input.decision.side) return out;
  const risk: RiskVerdict = {
    allowed: true,
    volume: 0,
    risk_amount: 0,
    reasons: ['client_fanout'],
  };
  for (const row of input.fills) {
    if (!row.ok) continue;
    const vol =
      row.lot_size > 0 && Number.isFinite(row.lot_size) ? row.lot_size : 0;
    const execution: ExecutionResult = {
      intent_id: `${input.intent_id}:acct${row.account_id}`,
      order_id: null,
      accepted: true,
      fill_price:
        row.entry_price != null && Number.isFinite(row.entry_price)
          ? row.entry_price
          : null,
      detail: `client_fanout · client=${row.client_id} account=${row.account_id} · ${row.detail}`.slice(
        0,
        240
      ),
      paper: false,
    };
    const rec = input.journal.recordOpportunity({
      id: `fanout-${input.intent_id}-${row.account_id}`.slice(0, 80),
      mode: input.mode,
      epic: input.epic,
      decision: {
        ...input.decision,
        kind: input.side,
        side: input.side,
        block_reason: null,
      },
      risk: { ...risk, volume: vol },
      executed: true,
      execution,
    });
    out.push(rec);
  }
  return out;
}
