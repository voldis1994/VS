import { describe, expect, it } from 'vitest';
import {
  DecisionCodes,
  humanDecision,
  isErrorCode,
  isNoSetup,
  isTechnicalBlock,
  isWaitCode,
} from './decisionCodes.js';

describe('decisionCodes', () => {
  it('never invents UNKNOWN; NO_SETUP and BLOCKED_TECHNICAL are first-class', () => {
    expect(Object.values(DecisionCodes).includes('UNKNOWN' as never)).toBe(false);
    expect(DecisionCodes.NO_SETUP).toBe('NO_SETUP');
    expect(DecisionCodes.BLOCKED_TECHNICAL).toBe('BLOCKED_TECHNICAL');
    expect(isNoSetup(DecisionCodes.NO_SETUP)).toBe(true);
    expect(isTechnicalBlock(DecisionCodes.BLOCKED_TECHNICAL)).toBe(true);
    expect(isErrorCode(DecisionCodes.ERROR_STATE_UNRESOLVED)).toBe(true);
  });

  it('legacy WAIT_* aliases map to NO_SETUP or BLOCKED_TECHNICAL (not artificial modes)', () => {
    expect(DecisionCodes.WAIT_NO_SETUP).toBe('NO_SETUP');
    expect(DecisionCodes.WAIT_BAR_FORMING).toBe('NO_SETUP');
    expect(DecisionCodes.WAIT_COOLDOWN).toBe('BLOCKED_TECHNICAL');
    expect(DecisionCodes.WAIT_RISK_LIMIT).toBe('BLOCKED_TECHNICAL');
    expect(isWaitCode(DecisionCodes.NO_SETUP)).toBe(true);
  });

  it('maps market-closed technical block to operator text', () => {
    expect(humanDecision(DecisionCodes.BLOCKED_TECHNICAL)).toMatch(/Tehniski/);
    expect(humanDecision('WAIT_MARKET_CLOSED')).toMatch(/TRADEABLE/);
  });
});
