import { describe, expect, it } from 'vitest';
import {
  backfillDeskEntrySources,
  resolveDeskEntrySourceForPosition,
} from '../deskEntryHydrate.js';
import type { MasterDecision } from '../types.js';

function decision(
  desk?: 'setup' | 'move' | 'none' | null
): MasterDecision {
  return {
    decision_id: 'd1',
    kind: 'BUY',
    side: 'BUY',
    score: 1,
    block_reason: null,
    buy: null as never,
    sell: null as never,
    analysis: {
      regime: 'TREND',
      market_state: 'trend',
      momentum_score: 1,
      momentum_dir: 'UP',
      trend_dir: 'UP',
      trend_strength: 1,
      structure_bias: 'BULLISH',
      swing_high: 1,
      swing_low: 0,
      buy_pressure: 1,
      sell_pressure: 0,
      behavior_bull: 1,
      behavior_bear: 0,
      impact_score: 0,
      context_quality: 1,
      volatility: 0,
      atr: 1,
      data_quality: 1,
      session: 'LONDON',
    },
    expectancy: null,
    desk_entry_source: desk,
  };
}

describe('deskEntryHydrate', () => {
  it('keeps stamped setup/move and does not invent when unknown', () => {
    const setupPos = {
      opportunity_id: 'a',
      decision: decision('setup'),
    };
    expect(resolveDeskEntrySourceForPosition(setupPos, {})).toBe('setup');
    const unknown = {
      opportunity_id: 'missing',
      decision: decision(null),
    };
    expect(resolveDeskEntrySourceForPosition(unknown, {})).toBeNull();
  });

  it('backfills from opportunity.decision then DecisionEvent', () => {
    const posOpp = {
      opportunity_id: 'opp-1',
      decision: decision(undefined),
    };
    expect(
      resolveDeskEntrySourceForPosition(posOpp, {
        opportunities: [
          { id: 'opp-1', decision: { desk_entry_source: 'move' } },
        ],
      })
    ).toBe('move');

    const posEv = {
      opportunity_id: 'opp-2',
      decision: decision(null),
    };
    expect(
      resolveDeskEntrySourceForPosition(posEv, {
        decisions: [
          { opportunity_id: 'opp-2', desk_entry_source: 'setup' },
        ],
      })
    ).toBe('setup');
  });

  it('mutates positions missing desk_entry_source', () => {
    const positions = [
      { opportunity_id: 'a', decision: decision(null) },
      { opportunity_id: 'b', decision: decision('setup') },
    ];
    const n = backfillDeskEntrySources(positions, {
      opportunities: [
        { id: 'a', decision: { desk_entry_source: 'move' } },
      ],
    });
    expect(n).toBe(1);
    expect(positions[0]!.decision.desk_entry_source).toBe('move');
    expect(positions[1]!.decision.desk_entry_source).toBe('setup');
  });
});
