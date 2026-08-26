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

describe('decideBestOutcomeExit 10s + PeakProtect 75%', () => {
  it('HardInv ~1.9pt Gold — cuts before Safety SL 0.20%', () => {
    const hard = hardInvalidationDistance(4660);
    expect(hard).toBe(1.9);
    expect(hard).toBeLessThan(4660 * 0.002);
  });

  it('HardInv fires at ~2.0pt adverse move on Gold', () => {
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4660, mfe: 0.5 }),
      4658.0
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/HardInvalidation/);

    const hold = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4660, mfe: 0.5 }),
      4658.2
    );
    expect(hold.exit).toBe(false);
  });

  it('MFE floor arms on micro ~1pt (not 4pt)', () => {
    expect(bestOutcomeMfeFloor(4640)).toBeLessThanOrEqual(1.5);
    expect(bestOutcomeMinGreen(4640)).toBeLessThanOrEqual(1);
  });

  it('PeakProtect @75% cuts +0.35 peak → ~+0.10 giveback (user bug)', () => {
    expect(BEST_OUTCOME_LOCK_RETENTION).toBe(0.75);
    // MFE 3.5pt, now only 1.0pt left (ret≈29%) — must exit, even with continuation
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4640,
        mfe: 3.5,
        peak_retention: 1.0 / 3.5,
      }),
      4641.0,
      { continuationSameSide: true }
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/PeakProtection/);
    expect(cut.reason).toMatch(/75%/);
  });

  it('PeakProtect holds while still ≥75% of MFE', () => {
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4640,
        mfe: 3.5,
        peak_retention: 0.8,
      }),
      4642.8
    );
    expect(hold.exit).toBe(false);
  });

  it('continuation does not skip PeakProtect', () => {
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        mfe: 20,
        peak_retention: 0.35,
      }),
      4608,
      { continuationSameSide: true }
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/PeakProtection/);
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

  it('continuation still skips soft TP while PeakProtect not breached', () => {
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        mfe: 15,
        peak_retention: 0.9,
      }),
      4610,
      { continuationSameSide: true }
    );
    expect(hold.exit).toBe(false);
  });

  it('describe shows lock@75%', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 15, peak_retention: 0.9 }),
      4610,
      { continuationSameSide: true, continuationReason: 'continuation · TREND_UP' }
    );
    expect(s.hold).toMatch(/BO10s/);
    expect(s.hold).toMatch(/lock@75%/);
    expect(s.hold).toMatch(/HOLD/);
  });

  it('TP scaled for 10s (~0.53%)', () => {
    expect(bestOutcomeTarget(4600)).toBeCloseTo(4600 * 0.0053, 5);
    expect(bestOutcomeTarget(4600)).toBeLessThan(4600 * 0.01);
    expect(bestOutcomeMfeFloor(4600)).toBeLessThan(bestOutcomeTarget(4600));
  });
});
