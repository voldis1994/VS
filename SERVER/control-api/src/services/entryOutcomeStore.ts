/**
 * Entry outcome research store.
 * Records EVERY candidate (entered or skipped). Future MFE/MAE never feeds live Entry.
 */

import { DESK_PROTOTYPE_STRATEGY } from './mainPrototype.js';
import type { EntryPlan } from './regimeEntryPlan.js';
import type { TickMicroMetrics } from './tickMicroEngine.js';
import type { EntryMachineSnapshot } from './entryStateMachine.js';
import type { OpportunityBreakdown } from './entryOpportunity.js';

export type EntryCandidateRecord = {
  id: string;
  at: string;
  instrument: string;
  mode: string;
  setup: string | null;
  regime: string | null;
  movement_phase: string;
  entry_state: string;
  direction: 'BUY' | 'SELL' | null;
  kind: string | null;
  mid: number | null;
  targets: EntryPlan['targets'] | null;
  micro: TickMicroMetrics;
  score: number | null;
  score_breakdown: OpportunityBreakdown | null;
  entry_or_skip: 'ENTER' | 'SKIP' | 'SHADOW';
  reason: string;
  hard_block: string | null;
  late_reason: string | null;
  strategy_version: string;
  /** Filled later from post-event price path — never used in live decide */
  outcome?: {
    mfe: number | null;
    mae: number | null;
    plus_10s: number | null;
    plus_30s: number | null;
    plus_60s: number | null;
    plus_120s: number | null;
    time_to_mfe_ms: number | null;
    giveback: number | null;
    computed_at?: string;
  };
};

const MAX_RECORDS = 2_000;
const records: EntryCandidateRecord[] = [];
let seq = 0;

export function recordEntryCandidate(input: {
  instrument: string;
  machine: EntryMachineSnapshot;
  plan: EntryPlan;
  micro: TickMicroMetrics;
  score: OpportunityBreakdown | null;
  mid: number | null;
  regime?: string | null;
  entryOrSkip: 'ENTER' | 'SKIP' | 'SHADOW';
  reason: string;
}): EntryCandidateRecord {
  seq += 1;
  const rec: EntryCandidateRecord = {
    id: `ec-${Date.now()}-${seq}`,
    at: new Date().toISOString(),
    instrument: String(input.instrument || '').toUpperCase(),
    mode: input.machine.mode,
    setup: input.plan.setup,
    regime: input.regime ?? null,
    movement_phase: input.machine.phase,
    entry_state: input.machine.state,
    direction: input.machine.direction,
    kind: input.machine.kind,
    mid: input.mid,
    targets: input.plan.targets,
    micro: { ...input.micro },
    score: input.score?.total ?? null,
    score_breakdown: input.score,
    entry_or_skip: input.entryOrSkip,
    reason: input.reason,
    hard_block: input.machine.hard_block,
    late_reason: input.machine.late_reason,
    strategy_version: DESK_PROTOTYPE_STRATEGY,
  };
  records.push(rec);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  return rec;
}

/**
 * Post-event research only. Call with future mids — NEVER from live Entry path.
 */
export function attachEntryOutcome(
  id: string,
  path: { ts_ms: number; mid: number }[],
  side: 'BUY' | 'SELL',
  entryMid: number,
  entryAtMs: number
): EntryCandidateRecord | null {
  const rec = records.find((r) => r.id === id);
  if (!rec) return null;
  let mfe = 0;
  let mae = 0;
  let timeToMfe: number | null = null;
  const at = (ms: number): number | null => {
    const t = path.find((p) => p.ts_ms >= entryAtMs + ms);
    if (!t) return null;
    return side === 'BUY' ? t.mid - entryMid : entryMid - t.mid;
  };
  for (const p of path) {
    if (p.ts_ms < entryAtMs) continue;
    const fav = side === 'BUY' ? p.mid - entryMid : entryMid - p.mid;
    if (fav > mfe) {
      mfe = fav;
      timeToMfe = p.ts_ms - entryAtMs;
    }
    if (fav < mae) mae = fav;
  }
  const last = path[path.length - 1];
  const lastFav =
    last && last.ts_ms >= entryAtMs
      ? side === 'BUY'
        ? last.mid - entryMid
        : entryMid - last.mid
      : null;
  rec.outcome = {
    mfe,
    mae,
    plus_10s: at(10_000),
    plus_30s: at(30_000),
    plus_60s: at(60_000),
    plus_120s: at(120_000),
    time_to_mfe_ms: timeToMfe,
    giveback: lastFav != null ? Math.max(0, mfe - lastFav) : null,
    computed_at: new Date().toISOString(),
  };
  return rec;
}

export function listEntryCandidates(limit = 100): EntryCandidateRecord[] {
  return records.slice(-limit);
}

export function resetEntryCandidates(): void {
  records.length = 0;
  seq = 0;
}
