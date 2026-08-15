import { describe, expect, it } from 'vitest';
import {
  DecisionCodes,
  humanDecision,
  isErrorCode,
  isNoSetup,
  isTechnicalBlock,
} from './decisionCodes.js';
import { mapLegacyWaitCode, isLegacyWaitString } from '../vs-core/decisionCompat.js';

describe('decisionCodes', () => {
  it('never invents UNKNOWN; production codes are NO_SETUP / BLOCKED_TECHNICAL / SIGNAL_*', () => {
    expect(Object.values(DecisionCodes).includes('UNKNOWN' as never)).toBe(false);
    expect(Object.keys(DecisionCodes).some((k) => k.startsWith('WAIT_'))).toBe(false);
    expect(DecisionCodes.NO_SETUP).toBe('NO_SETUP');
    expect(DecisionCodes.BLOCKED_TECHNICAL).toBe('BLOCKED_TECHNICAL');
    expect(DecisionCodes.BROKER_RESULT_UNRESOLVED).toBe('BROKER_RESULT_UNRESOLVED');
    expect(isNoSetup(DecisionCodes.NO_SETUP)).toBe(true);
    expect(isTechnicalBlock(DecisionCodes.BLOCKED_TECHNICAL)).toBe(true);
    expect(isErrorCode(DecisionCodes.ERROR_STATE_UNRESOLVED)).toBe(true);
  });

  it('legacy WAIT_* only via compatibility layer — not production DecisionCodes', () => {
    expect(isLegacyWaitString('WAIT_COOLDOWN')).toBe(true);
    expect(mapLegacyWaitCode('WAIT_NO_SETUP')).toBe('NO_SETUP');
    expect(mapLegacyWaitCode('WAIT_COOLDOWN')).toBe('BLOCKED_TECHNICAL');
    expect(mapLegacyWaitCode('WAIT_MARKET_CLOSED')).toBe('BLOCKED_TECHNICAL');
    expect(humanDecision(DecisionCodes.NO_SETUP)).toMatch(/Nav setup/);
  });
});
