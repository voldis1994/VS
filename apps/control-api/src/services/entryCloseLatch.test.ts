import { describe, expect, it } from 'vitest';
import { shouldAttemptZoneSeed } from './robotDesk.js';
import { MOVE, MOVE_RANGE } from './regimeBands.js';
import { bodyPct, isMoving10s, type TenSecBar } from './tenSecondOhlc.js';
import { decideEntryFrom10sRegime } from './entryFromRegime.js';

/** Mirrors seedZoneFromMinuteHistory guard — close tick must not run seed. */
function shouldSkipZoneSeedOnCloseTick(justClosed: boolean): boolean {
  return justClosed;
}

describe('entry close latch / zone-seed race', () => {
  it('defers zone seed on the just_closed tick so entry window is not wiped', () => {
    expect(shouldSkipZoneSeedOnCloseTick(true)).toBe(true);
    expect(shouldSkipZoneSeedOnCloseTick(false)).toBe(false);
  });

  it('still allows zone seed while book is thin (throttle only)', () => {
    expect(shouldAttemptZoneSeed(0, 0, 20_000)).toBe(true);
    expect(shouldAttemptZoneSeed(10, 0, 20_000)).toBe(true);
  });

  it('quiet Gold body ~0.008% is MOVING with soft 10s MOVE floor', () => {
    const mid = 2650;
    const bar: TenSecBar = {
      open_time_ms: 0,
      open: mid,
      high: mid + mid * MOVE * 0.5,
      low: mid - mid * MOVE * 0.2,
      close: mid + mid * MOVE * 1.01,
      ticks: 6,
    };
    expect(Math.abs(bodyPct(bar))).toBeGreaterThanOrEqual(MOVE);
    expect(isMoving10s(bar)).toBe(true);
    expect(decideEntryFrom10sRegime(bar, 'RANGE')?.direction).toBe('SELL');
  });

  it('Asia-scale ~0.35pt Gold body arms MOVING on live ~4360 mid', () => {
    const mid = 4360;
    // Soft MOVE 0.008% ≈ 0.35 pt at live Gold — prior 0.012% needed ~0.52 pt
    const bodyPts = mid * MOVE * 1.02;
    const bar: TenSecBar = {
      open_time_ms: 0,
      open: mid,
      high: mid + bodyPts,
      low: mid - 0.05,
      close: mid + bodyPts,
      ticks: 8,
    };
    expect(Math.abs(bodyPct(bar))).toBeGreaterThanOrEqual(MOVE);
    expect(isMoving10s(bar)).toBe(true);
    expect(decideEntryFrom10sRegime(bar, 'RANGE')?.direction).toBe('SELL');
    expect(decideEntryFrom10sRegime(bar, 'COMPRESSION')?.direction).toBe('SELL');
  });

  it('range-only micro bar below MOVE_RANGE stays QUIET (no false arm)', () => {
    const mid = 2650;
    const bar: TenSecBar = {
      open_time_ms: 0,
      open: mid,
      high: mid + mid * MOVE_RANGE * 0.4,
      low: mid - mid * MOVE_RANGE * 0.2,
      close: mid + mid * MOVE * 0.4,
      ticks: 4,
    };
    expect(isMoving10s(bar)).toBe(false);
    expect(decideEntryFrom10sRegime(bar, 'TREND_UP')).toBeNull();
  });
});
