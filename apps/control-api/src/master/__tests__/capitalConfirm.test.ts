import { describe, expect, it } from 'vitest';
import {
  isCapitalConfirmAccepted,
  isCapitalConfirmClosedGone,
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

  it('does not treat missing profit/size as realized 0 (Number(null) trap)', () => {
    const c = parseCapitalConfirm({
      dealId: 'deal-null-profit',
      dealStatus: 'ACCEPTED',
      level: 4410,
      profit: null,
      size: '',
    });
    expect(c.profit).toBeUndefined();
    expect(c.size).toBeUndefined();
    // Explicit zero remains zero
    const z = parseCapitalConfirm({
      dealId: 'deal-zero',
      dealStatus: 'ACCEPTED',
      level: 4410,
      profit: 0,
      size: 0,
    });
    expect(z.profit).toBe(0);
    expect(z.size).toBe(0);
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

  it('DELETED/CLOSED are closed-gone for CLOSE, not OPEN accept', () => {
    const deleted = parseCapitalConfirm({
      dealId: 'deal-closed',
      status: 'DELETED',
      level: 4410.2,
      profit: -1.5,
    });
    expect(isCapitalConfirmTerminal(deleted)).toBe(true);
    expect(isCapitalConfirmAccepted(deleted)).toBe(false);
    expect(isCapitalConfirmClosedGone(deleted)).toBe(true);

    const closed = parseCapitalConfirm({
      dealId: 'deal-closed-2',
      status: 'CLOSED',
    });
    expect(isCapitalConfirmAccepted(closed)).toBe(false);
    expect(isCapitalConfirmClosedGone(closed)).toBe(true);

    const rejectedDeleted = parseCapitalConfirm({
      dealId: 'deal-x',
      status: 'DELETED',
      dealStatus: 'REJECTED',
      reason: 'ERROR',
    });
    expect(isCapitalConfirmAccepted(rejectedDeleted)).toBe(false);
    expect(isCapitalConfirmClosedGone(rejectedDeleted)).toBe(false);
  });

  it('empty REJECTED rawHint with level is not a stop-level reject', () => {
    const hint = JSON.stringify({
      dealStatus: 'REJECTED',
      status: 'DELETED',
      level: 4410.5,
      dealId: 'x',
    });
    expect(isCapitalStopLevelReject(hint)).toBe(false);
    expect(isCapitalStopLevelReject('MINIMUM_STOP_DISTANCE')).toBe(true);
    expect(isCapitalStopLevelReject('STOP_LEVEL')).toBe(true);
  });

  it('detects stop-level rejects and VS-System- backoff', () => {
    expect(isCapitalStopLevelReject('MINIMUM_STOP_DISTANCE')).toBe(true);
    expect(isCapitalStopLevelReject('attached order rejected')).toBe(true);
    expect(isCapitalStopLevelReject('RISK_CHECK')).toBe(false);
    expect(capitalModifyRejectBackoffMs('RISK_CHECK')).toBe(300_000);
    expect(capitalModifyRejectBackoffMs('MINIMUM_STOP_DISTANCE')).toBe(120_000);
  });
});
