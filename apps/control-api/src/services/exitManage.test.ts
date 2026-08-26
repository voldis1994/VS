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

describe('decideBestOutcomeExit 10s + PeakProtect 75%', () => {
  it('HardInv ~0.6pt Gold — cuts before Safety SL ~0.04%', () => {
    const hard = hardInvalidationDistance(4660);
    expect(hard).toBe(0.6);
    expect(hard).toBeLessThan(4660 * 0.0004);
  });

  it('manageExitPrice uses bid for BUY / ask for SELL (not mid)', () => {
    expect(manageExitPrice('BUY', { bid: 4659.4, ask: 4659.8, mid: 4659.6 })).toBe(4659.4);
    expect(manageExitPrice('SELL', { bid: 4659.4, ask: 4659.8, mid: 4659.6 })).toBe(4659.8);
  });

  it('HardInv fires at ~0.6pt adverse move on Gold', () => {
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4660, mfe: 0 }),
      4659.3
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/HardInvalidation/);

    const hold = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4660, mfe: 0 }),
      4659.5
    );
    expect(hold.exit).toBe(false);
  });

  it('MFE floor arms on micro ~0.20pt (not 1pt — user +0.25 case)', () => {
    expect(bestOutcomeMfeFloor(4640)).toBeLessThanOrEqual(0.25);
    expect(bestOutcomeMfeFloor(4640)).toBeGreaterThanOrEqual(0.2);
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

  it('PeakProtect arms on +0.25 and cuts before +0.06 giveback', () => {
    // User case: peak +0.25 → must NOT hold until +0.06 (that was ~76% giveback)
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
    // At +0.19 (76% of 0.25) still ok; at +0.18 (~72%) must cut via trigger 78%
    const early = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4640, mfe: 0.25, peak_retention: 0.9 }),
      4640.19
    );
    expect(early.exit).toBe(true); // 0.19/0.25=0.76 < 0.78 trigger
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
    // fav 12 / mfe 15 = 80% ≥ trigger 78% — hold; soft TP skipped by continuation
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

  it('describe shows lock@75%', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 15, peak_retention: 0.9 }),
      4612,
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
