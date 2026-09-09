import { describe, expect, it } from 'vitest';
import { fromOutcomes, performanceByDeskEntry } from '../performance.js';
import type { OpportunityRecord, TradeOutcome } from '../types.js';

function outcome(pnl: number): TradeOutcome {
  return {
    position_id: 'pos',
    side: 'BUY',
    entry: 4400,
    exit: 4400 + pnl,
    volume: 1,
    pnl,
    fees: 0,
    slippage: 0,
    mae: 0,
    mfe: Math.max(0, pnl),
    r_multiple: pnl,
    hold_ms: 1000,
    exit_reason: 'TEST',
    pnl_proven: true,
  };
}

function opp(id: string, pnl: number): OpportunityRecord {
  return {
    id,
    ts: new Date().toISOString(),
    mode: 'PAPER',
    epic: 'GOLD',
    decision: null as never,
    risk: null as never,
    executed: true,
    outcome: outcome(pnl),
  };
}

describe('performanceByDeskEntry', () => {
  it('joins DecisionEvent.opportunity_id to closed outcomes by confirm source', () => {
    const records = [opp('a', 10), opp('b', -4), opp('c', 6)];
    const decisions = [
      { opportunity_id: 'a', desk_entry_source: 'setup' as const },
      { opportunity_id: 'b', desk_entry_source: 'move' as const },
      { opportunity_id: 'c', desk_entry_source: null },
    ];
    const slices = performanceByDeskEntry(records, decisions);
    const by = Object.fromEntries(slices.map((s) => [s.source, s]));
    expect(by.setup!.trades).toBe(1);
    expect(by.setup!.total_pnl).toBe(10);
    expect(by.move!.trades).toBe(1);
    expect(by.move!.total_pnl).toBe(-4);
    expect(by.none!.trades).toBe(1);
    expect(by.none!.total_pnl).toBe(6);
    expect(by.setup!.expectancy).toBe(fromOutcomes([outcome(10)]).expectancy);
  });

  it('prefers setup/move over none when multiple decisions share opportunity_id', () => {
    const records = [opp('z', 3)];
    const decisions = [
      { opportunity_id: 'z', desk_entry_source: null },
      { opportunity_id: 'z', desk_entry_source: 'move' as const },
    ];
    const slices = performanceByDeskEntry(records, decisions);
    expect(slices.find((s) => s.source === 'move')!.trades).toBe(1);
    expect(slices.find((s) => s.source === 'none')!.trades).toBe(0);
  });
});
