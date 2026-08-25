import { describe, expect, it } from 'vitest';
import {
  BEST_OUTCOME_LOCK_RETENTION,
  bestOutcomeMfeFloor,
  bestOutcomeMinGreen,
  bestOutcomeTarget,
  decideBestOutcomeExit,
  describeBestOutcomeState,
  hardInvalidationDistance,
  type ExitSnapshot,
} from './exitManage.js';

function snap(partial: Partial<ExitSnapshot> & { open_side: 'BUY' | 'SELL'; entry_price: number }): ExitSnapshot {
  return {
    mfe: 0,
    mae: 0,
    peak_retention: null,
    entry_at: new Date().toISOString(),
    regime: 'TREND_UP',
    ...partial,
  };
}

describe('decideBestOutcomeExit 10s + continuation', () => {
  it('HardInv ~0.15% tighter than Safety 0.20%', () => {
    const hard = hardInvalidationDistance(4600);
    expect(hard).toBeGreaterThanOrEqual(0.15);
    expect(hard).toBeLessThan(4600 * 0.002);
  });

  it('holds micro green below minGreen', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4640, mfe: 2, peak_retention: 0.5 }),
      4641
    );
    expect(d.exit).toBe(false);
    expect(bestOutcomeMinGreen(4640)).toBeGreaterThanOrEqual(3);
  });

  it('PeakProtect without continuation after deep giveback', () => {
    expect(BEST_OUTCOME_LOCK_RETENTION).toBe(0.4);
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        mfe: 20,
        peak_retention: 0.35,
      }),
      4608
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/PeakProtection/);
  });

  it('continuation hold skips PeakProtect soft exit', () => {
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        mfe: 20,
        peak_retention: 0.35,
      }),
      4608,
      { continuationSameSide: true }
    );
    expect(hold.exit).toBe(false);
  });

  it('continuation does not skip HardInvalidation', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 10, peak_retention: 0.9 }),
      4580,
      { continuationSameSide: true }
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
  });

  it('describe shows BO10s + continuation', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 15, peak_retention: 0.9 }),
      4610,
      { continuationSameSide: true, continuationReason: 'continuation · TREND_UP' }
    );
    expect(s.hold).toMatch(/BO10s/);
    expect(s.hold).toMatch(/HOLD/);
  });

  it('TP scaled for 10s (~0.45%)', () => {
    expect(bestOutcomeTarget(4600)).toBeLessThan(4600 * 0.01);
    expect(bestOutcomeMfeFloor(4600)).toBeLessThan(bestOutcomeTarget(4600));
  });
});
