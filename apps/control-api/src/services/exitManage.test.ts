import { describe, expect, it } from 'vitest';
import {
  BEST_OUTCOME_LOCK_RETENTION,
  bestOutcomeMfeFloor,
  bestOutcomeMinGreen,
  bestOutcomeTarget,
  decideBestOutcomeExit,
  describeBestOutcomeState,
  hardInvalidationDistance,
  manageExitPrice,
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

describe('decideBestOutcomeExit 10s + PeakProtect 70%', () => {
  it('HardInv 2.0pt Gold — cuts before Safety SL ~0.08%', () => {
    const hard = hardInvalidationDistance(4660);
    expect(hard).toBe(2.0);
    expect(hard).toBeLessThan(4660 * 0.0008);
  });

  it('manageExitPrice uses bid for BUY / ask for SELL (not mid)', () => {
    expect(manageExitPrice('BUY', { bid: 4659.4, ask: 4659.8, mid: 4659.6 })).toBe(4659.4);
    expect(manageExitPrice('SELL', { bid: 4659.4, ask: 4659.8, mid: 4659.6 })).toBe(4659.8);
  });

  it('HardInv fires at ~2.0pt adverse move on Gold', () => {
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4660, mfe: 0 }),
      4657.9
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/HardInvalidation/);

    const hold = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4660, mfe: 0 }),
      4658.1
    );
    expect(hold.exit).toBe(false);
  });

  it('MFE floor arms on micro ~0.20pt (not 1pt — user +0.25 case)', () => {
    expect(bestOutcomeMfeFloor(4640)).toBeLessThanOrEqual(0.25);
    expect(bestOutcomeMfeFloor(4640)).toBeGreaterThanOrEqual(0.2);
    expect(bestOutcomeMinGreen(4640)).toBeLessThanOrEqual(1);
  });

  it('PeakProtect @70% cuts deep giveback even with continuation', () => {
    expect(BEST_OUTCOME_LOCK_RETENTION).toBe(0.7);
    // MFE 3.5pt, now only 1.0pt left (ret≈29%) — must exit
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
    expect(cut.reason).toMatch(/70%/);
  });

  it('PeakProtect arms on +0.25 and cuts before +0.06 giveback', () => {
    expect(bestOutcomeMfeFloor(4640)).toBeLessThanOrEqual(0.25);
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4640,
        mfe: 0.25,
        peak_retention: 0.06 / 0.25,
      }),
      4640.06,
      { continuationSameSide: true }
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/PeakProtection/);
    // 0.18/0.25=0.72 < trigger 0.73 → cut; 0.19/0.25=0.76 → hold
    const early = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4640, mfe: 0.25, peak_retention: 0.9 }),
      4640.18
    );
    expect(early.exit).toBe(true);
    const keep = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4640, mfe: 0.25, peak_retention: 0.9 }),
      4640.19
    );
    expect(keep.exit).toBe(false);
  });

  it('PeakProtect holds while still ≥70% of MFE', () => {
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
    // fav 12 / mfe 15 = 80% ≥ trigger 73% — hold; soft TP skipped by continuation
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        mfe: 15,
        peak_retention: 0.9,
      }),
      4612,
      { continuationSameSide: true }
    );
    expect(hold.exit).toBe(false);
  });

  it('describe shows lock@70%', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 15, peak_retention: 0.9 }),
      4612,
      { continuationSameSide: true, continuationReason: 'continuation · TREND_UP' }
    );
    expect(s.hold).toMatch(/BO10s/);
    expect(s.hold).toMatch(/lock@70%/);
    expect(s.hold).toMatch(/HOLD/);
  });

  it('TP scaled for 10s (~0.53%)', () => {
    expect(bestOutcomeTarget(4600)).toBeCloseTo(4600 * 0.0053, 5);
    expect(bestOutcomeTarget(4600)).toBeLessThan(4600 * 0.01);
    expect(bestOutcomeMfeFloor(4600)).toBeLessThan(bestOutcomeTarget(4600));
  });
});
