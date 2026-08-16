import { describe, it, expect } from 'vitest';
import { TREND_CONTINUATION_THEORY } from '../theory.ts';
import { confirmEntry } from '../entry.ts';
import type { SetupRecord } from '../../market-intelligence/src/types.ts';

describe('trend_continuation module', () => {
  it('forbids label-only entry in theory contract', () => {
    expect(TREND_CONTINUATION_THEORY.forbids_label_only_entry).toBe(true);
    expect(TREND_CONTINUATION_THEORY.emergency_sl_ceiling_pct).toBe(0.2);
  });

  it('confirmEntry rejects incomplete setup', () => {
    const setup = {
      setup_id: 'x',
      strategy_id: 'trend_continuation',
      instrument: 'XAUUSD',
      timestamp: new Date().toISOString(),
      direction: null,
      conditions: [],
      all_pass: false,
      market_state: {} as SetupRecord['market_state'],
      feed_quality: 'OK',
      entry_reference: null,
      invalidation_reference: null,
      evidence: [],
      block: 'NO_SETUP',
    } as SetupRecord;
    expect(confirmEntry(setup).ok).toBe(false);
  });
});
