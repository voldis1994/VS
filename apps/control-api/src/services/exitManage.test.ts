/**
 * BO 5m — HOLD thesis, PeakProtect only after MFE ≥ max(1R, ATR_5m).
 */
import { describe, expect, it } from 'vitest';
import {
  bestOutcomeMfeFloor,
  decideBestOutcomeExit,
  describeBestOutcomeState,
  hardInvalidationDistance,
  manageExitPrice,
  peakProtectArmThreshold,
  peakProtectK,
  protectedProfitLevel,
  type ExitSnapshot,
} from './exitManage.js';

const META = { tick_size: 0.01 };

function snap(
  partial: Partial<ExitSnapshot> & { open_side: 'BUY' | 'SELL'; entry_price: number }
): ExitSnapshot {
  return {
    mfe: 0,
    mae: 0,
    peak_retention: null,
    entry_at: new Date().toISOString(),
    regime: 'TREND_UP',
    tick_size: META.tick_size,
    ...partial,
  };
}

describe('BO 5m PeakProtect / HOLD', () => {
  it('manageExitPrice uses bid for BUY / ask for SELL', () => {
    expect(manageExitPrice('BUY', { bid: 4659.4, ask: 4659.8, mid: 4659.6 })).toBe(4659.4);
    expect(manageExitPrice('SELL', { bid: 4659.4, ask: 4659.8, mid: 4659.6 })).toBe(4659.8);
  });

  it('HardInvalidation → EXIT', () => {
    const entry = 4660;
    const atr = 5;
    const sl = hardInvalidationDistance(entry, atr, META)!;
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: entry, mfe: 0, atr }),
      entry - sl - 0.01
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/HardInvalidation/);
  });

  it('StructuralInvalidation → EXIT', () => {
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 100, structural_sl: 99, atr: 1 }),
      98.5
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/StructuralInvalidation/);
  });

  it('ThesisFailure regime flip → EXIT', () => {
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 100, mfe: 0.5, atr: 1, regime: 'TREND_DOWN' }),
      100.2
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/ThesisFailure/);
  });

  it('PeakProtect arm threshold is max(1R, ATR_5m)', () => {
    const entry = 4640;
    const atr = 8;
    const oneR = hardInvalidationDistance(entry, atr, META)!;
    expect(peakProtectArmThreshold(entry, atr, META)).toBeCloseTo(Math.max(oneR, atr), 8);
    expect(bestOutcomeMfeFloor(entry, atr, META)).toBeCloseTo(Math.max(oneR, atr), 8);
  });

  it('K bands: strong / normal / weak', () => {
    expect(peakProtectK('TREND_UP', { continuationSameSide: true }).strength).toBe('strong');
    expect(peakProtectK('TREND_UP', { continuationSameSide: true }).k).toBeGreaterThanOrEqual(0.8);
    expect(peakProtectK('TREND_UP', { continuationSameSide: true }).k).toBeLessThanOrEqual(1.2);
    expect(peakProtectK('PULLBACK_UPTREND').strength).toBe('normal');
    expect(peakProtectK('RANGE').strength).toBe('weak');
    expect(peakProtectK('RANGE').k).toBeGreaterThanOrEqual(0.3);
    expect(peakProtectK('RANGE').k).toBeLessThanOrEqual(0.5);
  });

  it('small MFE / normal retrace → HOLD (PeakProtect not armed)', () => {
    const entry = 4640;
    const atr = 5;
    const arm = peakProtectArmThreshold(entry, atr, META)!;
    // MFE well below arm; deep % giveback from tiny peak — still HOLD
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: arm * 0.35,
        atr,
        peak_retention: 0.2,
        regime: 'TREND_UP',
      }),
      entry + arm * 0.05
    );
    expect(hold.exit).toBe(false);
  });

  it('PeakProtect activates only when MFE ≥ max(1R, ATR); then ProtectedProfit = MFE − K×ATR', () => {
    const entry = 4640;
    const atr = 4;
    const arm = peakProtectArmThreshold(entry, atr, META)!;
    expect(arm).toBeGreaterThanOrEqual(atr);

    // Just below arm → HOLD even if giveback looks large in %
    const below = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: entry, mfe: arm * 0.9, atr, regime: 'TREND_UP' }),
      entry + arm * 0.2
    );
    expect(below.exit).toBe(false);

    const mfe = arm * 1.5;
    const { k } = peakProtectK('TREND_UP', { continuationSameSide: true });
    const prot = protectedProfitLevel(mfe, atr, k);
    // Holding past 1R with continuation; giveback below protected → EXIT PeakProtect
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe,
        atr,
        regime: 'TREND_UP',
        structure_target: arm * 4,
      }),
      entry + prot - 0.05,
      { continuationSameSide: true }
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/PeakProtection/);
    expect(cut.reason).toMatch(/K=/);

    // fav still above protected → HOLD
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe,
        atr,
        regime: 'TREND_UP',
        structure_target: arm * 4,
      }),
      entry + prot + 0.2,
      { continuationSameSide: true }
    );
    expect(hold.exit).toBe(false);
  });

  it('strong continuation → HOLD past 1R toward structure (and past 1R without target)', () => {
    const entry = 4640;
    const atr = 3;
    const oneR = hardInvalidationDistance(entry, atr, META)!;
    const holdStruct = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: oneR * 1.2,
        atr,
        structure_target: oneR * 2.5,
        regime: 'TREND_UP',
      }),
      entry + oneR * 1.1,
      { continuationSameSide: true }
    );
    expect(holdStruct.exit).toBe(false);

    const holdNoTarget = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: oneR * 1.2,
        atr,
        regime: 'TREND_UP',
      }),
      entry + oneR * 1.1,
      { continuationSameSide: true }
    );
    expect(holdNoTarget.exit).toBe(false);
  });

  it('structure/liquidity target without continuation → EXIT at 1R', () => {
    const entry = 4640;
    const atr = 3;
    const oneR = hardInvalidationDistance(entry, atr, META)!;
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: oneR,
        atr,
        structure_target: oneR * 2.5,
        regime: 'TREND_UP',
      }),
      entry + oneR,
      { continuationSameSide: false }
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/Target \/ best outcome|no continuation/);
  });

  it('structure target hit → EXIT even with continuation', () => {
    const entry = 4640;
    const atr = 3;
    const oneR = hardInvalidationDistance(entry, atr, META)!;
    const struct = oneR * 2.2;
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: struct,
        atr,
        structure_target: struct,
        regime: 'TREND_UP',
      }),
      entry + struct,
      { continuationSameSide: true }
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/Target \/ structure/);
  });

  it('strong continuation still yields to PeakProtect + HardInv', () => {
    const entry = 4600;
    const atr = 5;
    const oneR = hardInvalidationDistance(entry, atr, META)!;
    const mfe = Math.max(oneR, atr) * 3;
    const { k } = peakProtectK('TREND_UP', { continuationSameSide: true });
    const prot = protectedProfitLevel(mfe, atr, k);
    const pp = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe,
        atr,
        structure_target: oneR * 5,
        regime: 'TREND_UP',
      }),
      entry + Math.min(prot - 0.5, oneR * 0.5),
      { continuationSameSide: true }
    );
    expect(pp.exit).toBe(true);
    expect(pp.reason).toMatch(/PeakProtection/);

    const hi = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: oneR,
        atr,
        structure_target: oneR * 3,
        regime: 'TREND_UP',
      }),
      entry - oneR - 1,
      { continuationSameSide: true }
    );
    expect(hi.exit).toBe(true);
    expect(hi.reason).toMatch(/HardInvalidation/);
  });

  it('describe shows 5m HOLD + K PeakProtect arm', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 1.0, atr: 5, regime: 'TREND_UP' }),
      4600.8,
      { continuationReason: 'continuation · TAPE UP', continuationSameSide: true }
    );
    expect(s.hold).toMatch(/BO 5m HOLD/);
    expect(s.hold).toMatch(/K=/);
    expect(s.hold).toMatch(/PP arm@/);
  });

  it('no TimeDecay scalp exit on small green', () => {
    const entry = 4660;
    const atr = 4;
    const arm = peakProtectArmThreshold(entry, atr, META)!;
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: arm * 0.4,
        atr,
        peak_retention: 0.95,
        entry_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        regime: 'TREND_UP',
      }),
      entry + arm * 0.35
    );
    expect(hold.exit).toBe(false);
  });
});
