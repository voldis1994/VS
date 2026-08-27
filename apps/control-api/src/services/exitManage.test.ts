/**
 * BO hybrid — structure reversal primary + soft ATR trail after arm.
 */
import { describe, expect, it } from 'vitest';
import {
  decideBestOutcomeExit,
  describeBestOutcomeState,
  hardInvalidationDistance,
  hybridProtectedFloor,
  manageExitPrice,
  peakProtectArmThreshold,
  peakProtectK,
  type ExitSnapshot,
} from './exitManage.js';
import type { StructureBar } from './marketStructure.js';

const META = { tick_size: 0.01 };

function snap(
  partial: Partial<ExitSnapshot> & { open_side: 'BUY' | 'SELL'; entry_price: number }
): ExitSnapshot {
  return {
    mfe: 0,
    mae: 0,
    peak_retention: null,
    // Default: past young-trade grace so soft BO exits still testable
    entry_at: new Date(Date.now() - 120_000).toISOString(),
    regime: 'TREND_UP',
    tick_size: META.tick_size,
    ...partial,
  };
}

function bullBars(n = 12): StructureBar[] {
  const out: StructureBar[] = [];
  let px = 4640;
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = px + (i % 2 === 0 ? 1.5 : 0.8);
    out.push({
      open_time_ms: i * 300_000,
      open: o,
      high: Math.max(o, c) + 0.4,
      low: Math.min(o, c) - 0.3,
      close: c,
      ticks: 10,
      provenance: 'REAL',
    });
    px = c;
  }
  return out;
}

describe('BO hybrid structure + PeakTrail', () => {
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

  it('young trade (<60s): soft StructureReversal/Thesis HOLD; HardInv still exits', () => {
    const young = snap({
      open_side: 'BUY',
      entry_price: 100,
      mfe: 0.2,
      atr: 1,
      regime: 'TREND_DOWN',
      entry_at: new Date().toISOString(),
    });
    const soft = decideBestOutcomeExit(young, 100.1);
    expect(soft.exit).toBe(false);

    const sl = hardInvalidationDistance(100, 1, META)!;
    const hard = decideBestOutcomeExit(young, 100 - sl - 0.01);
    expect(hard.exit).toBe(true);
    expect(hard.reason).toMatch(/HardInvalidation/);
  });

  it('K bands are wide (hybrid, not scalp)', () => {
    expect(peakProtectK('TREND_UP', { continuationSameSide: true })).toEqual(
      expect.objectContaining({ k: 2.5, strength: 'strong' })
    );
    expect(peakProtectK('PULLBACK_UPTREND').k).toBe(1.5);
    expect(peakProtectK('RANGE').k).toBe(1.0);
  });

  it('below arm: deep % giveback → HOLD (no trail)', () => {
    const entry = 4640;
    const atr = 5;
    const arm = peakProtectArmThreshold(entry, atr, META)!;
    const bars = bullBars();
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: arm * 0.4,
        atr,
        regime: 'TREND_UP',
      }),
      entry + arm * 0.05,
      { continuationSameSide: true, bars5m: bars }
    );
    expect(hold.exit).toBe(false);
  });

  it('after arm: moderate retrace above floor → HOLD', () => {
    const entry = 4640;
    const atr = 4;
    const arm = peakProtectArmThreshold(entry, atr, META)!;
    const mfe = Math.max(arm, atr) * 3;
    const { k } = peakProtectK('TREND_UP', { continuationSameSide: true });
    const floor = hybridProtectedFloor(mfe, atr, k);
    const bars = bullBars();
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe,
        atr,
        regime: 'TREND_UP',
        structure_target: arm * 5,
      }),
      entry + floor + 0.5,
      { continuationSameSide: true, bars5m: bars }
    );
    expect(hold.exit).toBe(false);
  });

  it('after arm: giveback below floor → PeakTrail EXIT', () => {
    const entry = 4640;
    const atr = 4;
    const arm = peakProtectArmThreshold(entry, atr, META)!;
    const mfe = Math.max(arm, atr) * 3;
    const { k } = peakProtectK('TREND_UP', { continuationSameSide: true });
    const floor = hybridProtectedFloor(mfe, atr, k);
    expect(floor).toBeGreaterThan(0);
    const bars = bullBars();
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe,
        atr,
        regime: 'TREND_UP',
        structure_target: arm * 5,
      }),
      entry + Math.max(0, floor - 0.5),
      { continuationSameSide: true, bars5m: bars }
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/PeakTrail/);
  });

  it('MFE=1000 ATR=50 strong → floor 875 (giveback max 125, not 1000)', () => {
    const floor = hybridProtectedFloor(1000, 50, 2.5);
    expect(floor).toBe(875);
  });

  it('armed trail never below breakeven', () => {
    expect(hybridProtectedFloor(3, 5, 2.5)).toBe(0);
  });

  it('structure target + continuation ended → TargetEnd exit', () => {
    const entry = 4640;
    const atr = 3;
    const oneR = hardInvalidationDistance(entry, atr, META)!;
    const struct = oneR * 2.2;
    const bars = bullBars();
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: struct + 0.05,
        atr,
        structure_target: struct,
        regime: 'TREND_UP',
      }),
      entry + struct + 0.01,
      { continuationSameSide: false, bars5m: bars }
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/TargetEnd|structure/);
  });

  it('describe shows hybrid HOLD + trail state', () => {
    const bars = bullBars();
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 12, atr: 5, regime: 'TREND_UP' }),
      4608,
      { continuationReason: 'continuation · TAPE UP', continuationSameSide: true, bars5m: bars }
    );
    expect(s.hold).toMatch(/BO hybrid HOLD/);
    expect(s.hold).toMatch(/peak MFE/);
    expect(s.hold).toMatch(/thesis ALIVE/);
    expect(s.hold).toMatch(/trail/);
  });
});
