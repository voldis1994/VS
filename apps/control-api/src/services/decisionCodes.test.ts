import { describe, expect, it } from 'vitest';
import { DecisionCodes, humanDecision, isErrorCode, isWaitCode } from './decisionCodes.js';

describe('decisionCodes', () => {
  it('treats WAIT_* as wait and never invents UNKNOWN decision', () => {
    expect(isWaitCode(DecisionCodes.WAIT_NO_SETUP)).toBe(true);
    expect(isErrorCode(DecisionCodes.ERROR_STATE_UNRESOLVED)).toBe(true);
    expect(Object.values(DecisionCodes).includes('UNKNOWN' as never)).toBe(false);
  });

  it('maps WAIT_MARKET_CLOSED to operator text', () => {
    expect(humanDecision(DecisionCodes.WAIT_MARKET_CLOSED)).toMatch(/TRADEABLE/);
  });
});
