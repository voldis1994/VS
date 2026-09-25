import { _setTradeOpenAtStartForTests } from './tradeOpenPolicy.js';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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

describe('flipFilter — same-dir lock (no force-flip after Soft)', () => {
  beforeEach(() => {
    _setTradeOpenAtStartForTests(false);
  });
  afterEach(() => {
    _setTradeOpenAtStartForTests(null);
  });

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
    expect(sameDirLockLeftSec(t0, t0 + 30_000, sameDirLockMs(false))).toBe(
      Math.ceil((SAME_DIR_LOCK_MS - 30_000) / 1000)
    );
  });

  it('after Soft loss keeps same-dir blocked for lock window — no forced opposite', () => {
    expect(sameDirLockMs(true)).toBe(SAME_DIR_LOCK_AFTER_LOSS_MS);
    // 30s after Soft loss — same still blocked
    expect(
      sameDirectionBlocked('SELL', 'SELL', t0, t0 + 30_000, { wasLoss: true })
    ).toBe(true);
    // Opposite allowed by lock (next-move gate is robotDesk)
    expect(
      sameDirectionBlocked('BUY', 'SELL', t0, t0 + 30_000, { wasLoss: true })
    ).toBe(false);
    // Do NOT advertise forced flip after Soft
    expect(requiredFlipSide('SELL', t0, t0 + 30_000, { wasLoss: true })).toBeNull();
    // After lock expires — same-dir allowed again
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

  it('explains same-dir Soft lock vs normal flip lock', () => {
    expect(flipFilterReason('SELL', 'SELL', 400, true)).toMatch(/SAME-DIR LOCK after Soft/);
    expect(flipFilterReason('SELL', 'SELL', 400, true)).toMatch(/ne auto-flip/);
    expect(flipFilterReason('BUY', 'BUY', 40, false)).toMatch(
      new RegExp(`FLIP LOCK ${Math.ceil(SAME_DIR_LOCK_MS / 1000)}s`)
    );
  });

  it('exitReasonWasLoss detects Soft/structure, not Peak/Target/BE scratch', () => {
    expect(exitReasonWasLoss('HardInvalidation · UPL -3.2 (SL 3.2)')).toBe(true);
    expect(exitReasonWasLoss('StructureInvalidation · back under')).toBe(true);
    expect(exitReasonWasLoss('PeakProtection · retention 60%')).toBe(false);
    expect(exitReasonWasLoss('Target / best outcome')).toBe(false);
    expect(exitReasonWasLoss('HardInvalidation · BE-lock')).toBe(false);
  });
});
