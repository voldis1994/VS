import { describe, expect, it } from 'vitest';
import {
  isCapitalConfirmAccepted,
  isCapitalConfirmTerminal,
  isCapitalStopLevelReject,
  parseCapitalConfirm,
  formatCapitalConfirmRejection,
  capitalModifyRejectBackoffMs,
} from '../capitalConfirm.js';

describe('VS MASTER capital confirm (VS-System-)', () => {
  it('parses dealId and fill level from confirm payload', () => {
    const c = parseCapitalConfirm({
      dealId: 'deal-1',
      dealStatus: 'ACCEPTED',
      level: 4412.5,
      profit: 12.34,
      size: 0.1,
      direction: 'BUY',
    });
    expect(c.dealId).toBe('deal-1');
    expect(c.level).toBe(4412.5);
    expect(c.profit).toBe(12.34);
    expect(isCapitalConfirmAccepted(c)).toBe(true);
    expect(isCapitalConfirmTerminal(c)).toBe(true);
  });

  it('rejects REJECTED confirms', () => {
    const c = parseCapitalConfirm({
      dealStatus: 'REJECTED',
      reason: 'RISK_CHECK',
      affectedDeals: [{ dealId: 'x' }],
    });
    expect(isCapitalConfirmAccepted(c)).toBe(false);
    expect(isCapitalConfirmTerminal(c)).toBe(true);
    expect(c.reason).toMatch(/RISK_CHECK/);
    expect(formatCapitalConfirmRejection(c)).toMatch(/RISK_CHECK/);
  });

  it('reads dealId from affectedDeals when top-level missing', () => {
    const c = parseCapitalConfirm({
      status: 'OPEN',
      affectedDeals: [{ dealId: 'aff-9', level: 4401.2 }],
    });
    expect(c.dealId).toBe('aff-9');
    expect(c.level).toBe(4401.2);
    expect(isCapitalConfirmAccepted(c)).toBe(true);
    expect(isCapitalConfirmTerminal(c)).toBe(true);
  });

  it('detects stop-level rejects and VS-System- backoff', () => {
    expect(isCapitalStopLevelReject('MINIMUM_STOP_DISTANCE')).toBe(true);
    expect(isCapitalStopLevelReject('attached order rejected')).toBe(true);
    expect(isCapitalStopLevelReject('RISK_CHECK')).toBe(false);
    expect(capitalModifyRejectBackoffMs('RISK_CHECK')).toBe(300_000);
    expect(capitalModifyRejectBackoffMs('MINIMUM_STOP_DISTANCE')).toBe(120_000);
  });
});
