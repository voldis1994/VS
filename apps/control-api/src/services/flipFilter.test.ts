import { describe, expect, it } from 'vitest';
import {
  SAME_DIR_LOCK_MS,
  SAME_DIR_LOCK_AFTER_LOSS_MS,
  exitReasonWasLoss,
  flipFilterReason,
  requiredFlipSide,
  sameDirLockActive,
  sameDirLockLeftSec,
  sameDirLockMs,
  sameDirectionBlocked,
} from './flipFilter.js';

describe('flipFilter — same-dir lock + after-loss flip', () => {
  const t0 = 1_000_000;

  it('allows any side when no prior close', () => {
    expect(sameDirectionBlocked('BUY', null, null, t0)).toBe(false);
    expect(sameDirectionBlocked('SELL', null, 0, t0)).toBe(false);
    expect(requiredFlipSide(null, null, t0)).toBeNull();
  });

  it('blocks same direction within win lock; allows opposite', () => {
    expect(
      sameDirectionBlocked('BUY', 'BUY', t0, t0 + 30_000, { wasLoss: false })
    ).toBe(true);
    expect(
      sameDirectionBlocked('SELL', 'BUY', t0, t0 + 30_000, { wasLoss: false })
    ).toBe(false);
    expect(requiredFlipSide('BUY', t0, t0 + 30_000, { wasLoss: false })).toBe('SELL');
    expect(sameDirLockLeftSec(t0, t0 + 30_000, sameDirLockMs(false))).toBe(60);
  });

  it('after Soft loss keeps same-dir blocked for 12m (Funds SELL spam)', () => {
    expect(sameDirLockMs(true)).toBe(SAME_DIR_LOCK_AFTER_LOSS_MS);
    // 5 min after Soft loss — still blocked
    expect(
      sameDirectionBlocked('SELL', 'SELL', t0, t0 + 5 * 60_000, { wasLoss: true })
    ).toBe(true);
    expect(
      sameDirectionBlocked('BUY', 'SELL', t0, t0 + 5 * 60_000, { wasLoss: true })
    ).toBe(false);
    // After 12m — allowed
    expect(
      sameDirectionBlocked(
        'SELL',
        'SELL',
        t0,
        t0 + SAME_DIR_LOCK_AFTER_LOSS_MS + 1,
        { wasLoss: true }
      )
    ).toBe(false);
  });

  it('allows same direction again after win lock', () => {
    expect(sameDirLockActive(t0, t0 + SAME_DIR_LOCK_MS)).toBe(false);
    expect(
      sameDirectionBlocked('BUY', 'BUY', t0, t0 + SAME_DIR_LOCK_MS, { wasLoss: false })
    ).toBe(false);
  });

  it('explains loss flip vs normal lock', () => {
    expect(flipFilterReason('SELL', 'SELL', 400, true)).toMatch(/FLIP AFTER LOSS 12m/);
    expect(flipFilterReason('BUY', 'BUY', 40, false)).toMatch(/FLIP LOCK 90s/);
  });

  it('exitReasonWasLoss detects Soft/structure, not Peak/Target/BE scratch', () => {
    expect(exitReasonWasLoss('HardInvalidation · UPL -3.2 (SL 3.2)')).toBe(true);
    expect(exitReasonWasLoss('StructureInvalidation · back under')).toBe(true);
    expect(exitReasonWasLoss('PeakProtection · retention 60%')).toBe(false);
    expect(exitReasonWasLoss('Target / best outcome')).toBe(false);
    expect(exitReasonWasLoss('HardInvalidation · BE-lock')).toBe(false);
  });
});
