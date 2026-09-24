import { describe, expect, it } from 'vitest';
import {
  SAME_DIR_LOCK_MS,
  flipFilterReason,
  requiredFlipSide,
  sameDirLockActive,
  sameDirLockLeftSec,
  sameDirectionBlocked,
} from './flipFilter.js';

describe('flipFilter — 45s same-direction lock after close', () => {
  const t0 = 1_000_000;

  it('allows any side when no prior close', () => {
    expect(sameDirectionBlocked('BUY', null, null, t0)).toBe(false);
    expect(sameDirectionBlocked('SELL', null, 0, t0)).toBe(false);
    expect(requiredFlipSide(null, null, t0)).toBeNull();
  });

  it('blocks same direction within 45s; allows opposite', () => {
    expect(sameDirectionBlocked('BUY', 'BUY', t0, t0 + 20_000)).toBe(true);
    expect(sameDirectionBlocked('SELL', 'BUY', t0, t0 + 20_000)).toBe(false);
    expect(requiredFlipSide('BUY', t0, t0 + 20_000)).toBe('SELL');
    expect(sameDirLockLeftSec(t0, t0 + 20_000)).toBe(25);
  });

  it('allows same direction again after 45s', () => {
    expect(sameDirLockActive(t0, t0 + SAME_DIR_LOCK_MS)).toBe(false);
    expect(sameDirectionBlocked('BUY', 'BUY', t0, t0 + SAME_DIR_LOCK_MS)).toBe(false);
    expect(sameDirectionBlocked('BUY', 'BUY', t0, t0 + SAME_DIR_LOCK_MS + 1)).toBe(false);
    expect(requiredFlipSide('BUY', t0, t0 + SAME_DIR_LOCK_MS)).toBeNull();
    expect(sameDirLockLeftSec(t0, t0 + SAME_DIR_LOCK_MS)).toBe(0);
  });

  it('blocks SELL after SELL close only while lock active', () => {
    expect(sameDirectionBlocked('SELL', 'SELL', t0, t0 + 30_000)).toBe(true);
    expect(sameDirectionBlocked('BUY', 'SELL', t0, t0 + 30_000)).toBe(false);
    expect(sameDirectionBlocked('SELL', 'SELL', t0, t0 + SAME_DIR_LOCK_MS)).toBe(false);
  });

  it('explains the lock with seconds left', () => {
    const msg = flipFilterReason('BUY', 'BUY', 30);
    expect(msg).toMatch(/FLIP LOCK 45s/);
    expect(msg).toMatch(/30s/);
    expect(msg).toMatch(/SELL/);
  });
});
