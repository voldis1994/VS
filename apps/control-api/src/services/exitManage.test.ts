/**
 * BO 5m — MAX OUTCOME MEMORY + STRUCTURE REVERSAL EXIT.
 */
import { describe, expect, it } from 'vitest';
import {
  decideBestOutcomeExit,
  describeBestOutcomeState,
  hardInvalidationDistance,
  manageExitPrice,
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
    entry_at: new Date().toISOString(),
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

describe('BO 5m structure reversal / HOLD', () => {
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

  it('large MFE retrace with alive thesis → HOLD (no PeakProtect scalp)', () => {
    const entry = 4640;
    const atr = 4;
    const arm = hardInvalidationDistance(entry, atr, META)!;
    const mfe = arm * 3;
    const bars = bullBars();
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe,
        atr,
        regime: 'TREND_UP',
        structure_target: arm * 4,
      }),
      entry + arm * 0.3,
      { continuationSameSide: true, bars5m: bars, bars1m: bars.slice(-6) }
    );
    expect(hold.exit).toBe(false);
  });

  it('strong continuation → HOLD past 1R toward structure', () => {
    const entry = 4640;
    const atr = 3;
    const oneR = hardInvalidationDistance(entry, atr, META)!;
    const bars = bullBars();
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
      { continuationSameSide: true, bars5m: bars }
    );
    expect(holdStruct.exit).toBe(false);
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

  it('describe shows peak MFE + thesis ALIVE (not PeakProtect)', () => {
    const bars = bullBars();
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 12, atr: 5, regime: 'TREND_UP' }),
      4608,
      { continuationReason: 'continuation · TAPE UP', continuationSameSide: true, bars5m: bars }
    );
    expect(s.hold).toMatch(/BO 5m HOLD/);
    expect(s.hold).toMatch(/peak MFE/);
    expect(s.hold).toMatch(/thesis ALIVE/);
    expect(s.hold).not.toMatch(/PP arm/);
  });

  it('no TimeDecay / small-profit exit on modest green', () => {
    const entry = 4660;
    const atr = 4;
    const arm = hardInvalidationDistance(entry, atr, META)!;
    const bars = bullBars();
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
      entry + arm * 0.35,
      { bars5m: bars }
    );
    expect(hold.exit).toBe(false);
  });
});
