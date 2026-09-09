/**
 * MASTER-owns → Client multi-account fanout after accepted OPEN.
 * Market Core EntryReady is blocked while owns_pipeline; MASTER becomes the publisher.
 * last_client_fanout also DualPersist / MemoryPersist / PG primary so wipe heals.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { PipelineIntentInput } from '../services/intentFanout.js';
import type { MasterJournal } from './journal.js';
import {
  persistClientFanoutState,
  loadClientFanoutFromPersist,
} from './persist.js';
import { embedOperatorMetaPatch } from './operatorMetaEmbed.js';
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

/** Deterministic MASTER opportunity id for a Client fanout fill. */
export function fanoutOpportunityId(
  intentId: string,
  accountId: number
): string {
  return `fanout-${String(intentId || '').trim()}-${accountId}`.slice(0, 80);
}

/**
 * Strip `master:` prefix from fanout idempotency keys.
 * Non-master ids return null (Market Core fanout is not MASTER-journaled).
 */
export function masterIntentIdFromIdem(idem: string | null | undefined): string | null {
  const raw = String(idem || '').trim();
  if (!raw.startsWith('master:')) return null;
  const id = raw.slice('master:'.length).trim();
  return id || null;
}

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
      id: fanoutOpportunityId(input.intent_id, row.account_id),
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

export type FanoutCloseInput = {
  opportunity_id: string;
  position_id: string | null;
  epic: string;
  side: 'BUY' | 'SELL' | string | null;
  volume: number | null;
  entry: number | null;
  exit: number | null;
  reason: string;
  mae?: number;
  mfe?: number;
  hold_ms?: number;
};

/**
 * Build a TradeOutcome for a Client fanout close (pnl unproven until Capital
 * realized profit is available — same honesty as desk hard exits).
 */
export function buildFanoutCloseOutcome(
  input: FanoutCloseInput
): import('./types.js').TradeOutcome {
  const side = input.side === 'SELL' ? 'SELL' : 'BUY';
  const entry =
    input.entry != null && Number.isFinite(input.entry)
      ? Number(input.entry)
      : input.exit != null && Number.isFinite(input.exit)
        ? Number(input.exit)
        : 0;
  const exit =
    input.exit != null && Number.isFinite(input.exit)
      ? Number(input.exit)
      : entry;
  const volume =
    input.volume != null && Number.isFinite(input.volume) && input.volume > 0
      ? Number(input.volume)
      : 0;
  return {
    position_id: input.position_id || input.opportunity_id,
    side,
    entry,
    exit,
    volume,
    pnl: 0,
    fees: 0,
    slippage: 0,
    mae: input.mae ?? 0,
    mfe: input.mfe ?? 0,
    r_multiple: 0,
    hold_ms: input.hold_ms ?? 0,
    exit_reason: `FANOUT_CLIENT · ${input.reason}`.slice(0, 240),
    pnl_proven: false,
  };
}

export type ClientFanoutDiskPayload = MasterFanoutSummary & {
  ts?: string;
};

function stateDir(root?: string): string {
  return (
    root ||
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function fanoutPath(root?: string): string {
  return join(stateDir(root), 'client_fanout.json');
}

function normalizeFanoutSummary(
  raw: unknown
): MasterFanoutSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.attempted !== 'boolean') return null;
  if (typeof o.detail !== 'string') return null;
  return {
    attempted: o.attempted === true,
    subscribers: Math.max(0, Math.floor(Number(o.subscribers) || 0)),
    ok_count: Math.max(0, Math.floor(Number(o.ok_count) || 0)),
    fail_count: Math.max(0, Math.floor(Number(o.fail_count) || 0)),
    detail: String(o.detail || '').slice(0, 400),
    journaled_count: Math.max(0, Math.floor(Number(o.journaled_count) || 0)),
  };
}

/** Durable last Client fanout summary — DualPersist / sidecar. */
export function saveClientFanoutSummary(
  summary: MasterFanoutSummary,
  root?: string
): boolean {
  try {
    const dir = stateDir(root);
    mkdirSync(dir, { recursive: true });
    const payload: ClientFanoutDiskPayload = {
      ...summary,
      ts: new Date().toISOString(),
    };
    writeFileSync(fanoutPath(root), JSON.stringify(payload));
    embedOperatorMetaPatch(
      { client_fanout: payload as unknown as Record<string, unknown> },
      dir
    );
    void persistClientFanoutState({
      ...payload,
      saved_at_ms: Date.now(),
    }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export function loadClientFanoutSummary(
  root?: string
): MasterFanoutSummary | null {
  try {
    const path = fanoutPath(root);
    if (!existsSync(path)) return null;
    return normalizeFanoutSummary(
      JSON.parse(readFileSync(path, 'utf8')) as unknown
    );
  } catch {
    return null;
  }
}

/**
 * When client_fanout.json was wiped but DualPersist/PG primary still holds
 * the singleton payload, rewrite the sidecar before status reads.
 */
export async function hydrateClientFanoutFromPersist(
  root?: string
): Promise<{ restored: boolean; summary: MasterFanoutSummary | null }> {
  const dir = stateDir(root);
  const path = fanoutPath(root);
  if (existsSync(path)) {
    return { restored: false, summary: loadClientFanoutSummary(root) };
  }
  try {
    const loaded = await loadClientFanoutFromPersist();
    const summary = normalizeFanoutSummary(loaded);
    if (!summary || !summary.attempted) {
      return { restored: false, summary: null };
    }
    mkdirSync(dir, { recursive: true });
    const payload: ClientFanoutDiskPayload = {
      ...summary,
      ts:
        typeof loaded?.ts === 'string' && loaded.ts
          ? loaded.ts
          : new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(payload));
    embedOperatorMetaPatch(
      { client_fanout: payload as unknown as Record<string, unknown> },
      dir
    );
    return { restored: true, summary };
  } catch {
    return { restored: false, summary: null };
  }
}
