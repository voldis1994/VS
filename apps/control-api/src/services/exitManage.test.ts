import { describe, expect, it } from 'vitest';
import {
  BEST_OUTCOME_LOCK_RETENTION,
  bestOutcomeMfeFloor,
  bestOutcomeMinGreen,
  decideBestOutcomeExit,
  describeBestOutcomeState,
  favorableMove,
  hardInvalidationDistance,
  thesisFailureReason,
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

describe('per-client exit isolation helpers', () => {
  it('favorableMove is side-correct', () => {
    expect(favorableMove('BUY', 2000, 2005)).toBe(5);
    expect(favorableMove('SELL', 2000, 2005)).toBe(-5);
  });

  it('thesis failure is opposite-regime only', () => {
    expect(thesisFailureReason('BUY', 'TREND_DOWN')).toMatch(/ThesisFailure/);
    expect(thesisFailureReason('SELL', 'TREND_UP')).toMatch(/ThesisFailure/);
    expect(thesisFailureReason('BUY', 'TREND_UP')).toBeNull();
  });
});

describe('decideBestOutcomeExit 5m', () => {
  it('holds micro green below minGreen (~3pt)', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4640, mfe: 2, peak_retention: 0.5 }),
      4641
    );
    expect(d.exit).toBe(false);
    expect(bestOutcomeMinGreen(4640)).toBeGreaterThanOrEqual(3);
  });

  it('cuts when peak was real and giveback hits flat/red', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        mfe: 8,
        peak_retention: 0.01,
      }),
      4599.9
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/BestOutcome cut|gave back/);
  });

  it('locks majority of MFE while still meaningful green', () => {
    expect(BEST_OUTCOME_LOCK_RETENTION).toBe(0.7);
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        mfe: 10,
        peak_retention: 0.64,
      }),
      4606.4
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/PeakProtection/);
  });

  it('hard invalidation at ~0.20%', () => {
    expect(hardInvalidationDistance(4600)).toBeCloseTo(9.2, 1);
    const d = decideBestOutcomeExit(snap({ open_side: 'BUY', entry_price: 4600, regime: 'RANGE' }), 4590);
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
  });

  it('arms peak after ~5.5pt MFE on Gold', () => {
    const floor = bestOutcomeMfeFloor(4600);
    expect(floor).toBeGreaterThanOrEqual(5);
    expect(floor).toBeLessThanOrEqual(6);
  });

  it('target at ~0.60%', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4600, regime: 'TREND_UP', mfe: 30 }),
      4630
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Target/);
  });

  it('describeBestOutcomeState shows BO5m', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 8, peak_retention: 0.9 }),
      4606
    );
    expect(s.exit).toBe(false);
    expect(s.hold).toMatch(/BO5m/);
    expect(s.hold).toMatch(/lock@70%/);
  });
});
