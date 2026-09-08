/** Journal — records evaluated opportunities, including blocked/non-traded setups. */
import { randomUUID } from 'crypto';
import type {
  ExecutionResult,
  MasterDecision,
  Mode,
  OpportunityRecord,
  RiskVerdict,
  TradeOutcome,
} from './types.js';

export class MasterJournal {
  readonly opportunities: OpportunityRecord[] = [];
  /** Every close / partial slice — drives Fees/KPI (not overwritten by multi-TP). */
  readonly closeOutcomes: TradeOutcome[] = [];

  recordOpportunity(input: {
    mode: Mode;
    epic: string;
    decision: MasterDecision;
    risk: RiskVerdict;
    executed: boolean;
    execution?: ExecutionResult;
    /** Optional stable id (e.g. recover UUID) so exits can attach. */
    id?: string;
  }): OpportunityRecord {
    const rec: OpportunityRecord = {
      id: input.id ?? randomUUID(),
      ts: new Date().toISOString(),
      mode: input.mode,
      epic: input.epic,
      decision: input.decision,
      risk: input.risk,
      executed: input.executed,
      execution: input.execution,
    };
    this.opportunities.push(rec);
    return rec;
  }

  attachOutcome(opportunityId: string, outcome: TradeOutcome) {
    this.closeOutcomes.push(outcome);
    const hit = this.opportunities.find((o) => o.id === opportunityId);
    if (!hit) return;
    // Keep a single display outcome per opp — accumulate multi-TP / partial slices
    if (hit.outcome) {
      hit.outcome = mergeOutcomeSlices(hit.outcome, outcome);
    } else {
      hit.outcome = outcome;
    }
  }

  traded(): OpportunityRecord[] {
    return this.opportunities.filter((o) => o.executed && o.outcome);
  }

  /** All close slices for performance (partials count separately). */
  allCloseOutcomes(): TradeOutcome[] {
    return this.closeOutcomes.slice();
  }

  /**
   * Dashboard window: always keep recent closed trades visible.
   * A naive last-N slice can be all WAIT noise while traded_count > 0.
   * traded_count skips Capital unproven closes (pnl_proven:false).
   */
  surfaceForApi(tradedCap = 50, restCap = 150): {
    opportunities: Array<
      OpportunityRecord & { block_reason: string | null }
    >;
    traded_count: number;
  } {
    const traded = this.traded();
    const provenTraded = traded.filter((o) => o.outcome?.pnl_proven !== false);
    const provenSlices = this.closeOutcomes.filter((o) => o.pnl_proven !== false);
    const rest = this.opportunities.filter((o) => !(o.executed && o.outcome));
    const enrich = (o: OpportunityRecord) => ({
      ...o,
      block_reason:
        o.decision.block_reason ??
        (o.risk?.allowed === false
          ? `risk:${(o.risk.reasons || []).join(',')}`
          : null) ??
        o.execution?.detail ??
        null,
    });
    return {
      opportunities: [
        ...traded.slice(-tradedCap).map(enrich),
        ...rest.slice(-restCap).map(enrich),
      ],
      traded_count: Math.max(provenTraded.length, provenSlices.length),
    };
  }

  blocked(): OpportunityRecord[] {
    return this.opportunities.filter((o) => o.decision.kind === 'BLOCK' || !o.executed);
  }

  /**
   * Restart hydration — replace in-memory journal from durable store.
   * Pass every outcome slice so Fees/KPI survive multi-TP / external partials.
   */
  hydrate(records: OpportunityRecord[], allOutcomes?: TradeOutcome[]) {
    this.opportunities.length = 0;
    this.closeOutcomes.length = 0;
    for (const r of records) this.opportunities.push(r);
    if (allOutcomes?.length) {
      for (const o of allOutcomes) this.closeOutcomes.push(o);
    } else {
      for (const r of records) {
        if (r.outcome) this.closeOutcomes.push(r.outcome);
      }
    }
  }
}

/** Accumulate partial / multi-TP slices onto one display outcome. */
export function mergeOutcomeSlices(a: TradeOutcome, b: TradeOutcome): TradeOutcome {
  return {
    position_id: b.position_id || a.position_id,
    side: a.side,
    entry: a.entry,
    exit: b.exit,
    volume: (Number(a.volume) || 0) + (Number(b.volume) || 0),
    pnl: (Number(a.pnl) || 0) + (Number(b.pnl) || 0),
    fees: (Number(a.fees) || 0) + (Number(b.fees) || 0),
    slippage: Math.max(Number(a.slippage) || 0, Number(b.slippage) || 0),
    mae: Math.max(Number(a.mae) || 0, Number(b.mae) || 0),
    mfe: Math.max(Number(a.mfe) || 0, Number(b.mfe) || 0),
    r_multiple: Number(b.r_multiple) || Number(a.r_multiple) || 0,
    hold_ms: Math.max(Number(a.hold_ms) || 0, Number(b.hold_ms) || 0),
    exit_reason: [a.exit_reason, b.exit_reason].filter(Boolean).join('|').slice(0, 200),
    // Any unproven slice fails-closed the merge (omit when both legacy/undefined)
    ...(a.pnl_proven === false || b.pnl_proven === false
      ? { pnl_proven: false as const }
      : a.pnl_proven === true && b.pnl_proven === true
        ? { pnl_proven: true as const }
        : a.pnl_proven === true || b.pnl_proven === true
          ? { pnl_proven: true as const }
          : {}),
  };
}
