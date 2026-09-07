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
    const hit = this.opportunities.find((o) => o.id === opportunityId);
    if (hit) hit.outcome = outcome;
  }

  traded(): OpportunityRecord[] {
    return this.opportunities.filter((o) => o.executed && o.outcome);
  }

  blocked(): OpportunityRecord[] {
    return this.opportunities.filter((o) => o.decision.kind === 'BLOCK' || !o.executed);
  }

  /** Restart hydration — replace in-memory journal from durable store. */
  hydrate(records: OpportunityRecord[]) {
    this.opportunities.length = 0;
    for (const r of records) this.opportunities.push(r);
  }
}
