/**
 * Unified manage exit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  decideBestOutcomeExit,
  decideManageExit,
  describeBestOutcomeState,
  favorableMove,
  manageExitPrice,
  thesisFailureReason,
  boMfeFloor,
  boTpDistance,
  type ExitSnapshot,
} from './exitManage.js';

const GOLD = { tick_size: 0.01 };

function snap(
  partial: Partial<ExitSnapshot> & { open_side: 'BUY' | 'SELL'; entry_price: number }
): ExitSnapshot {
  return {
    mfe: 0,
    mae: 0,
    peak_retention: null,
    entry_at: new Date().toISOString(),
    regime: 'TREND_UP',
    tick_size: GOLD.tick_size,
    broker_peak_upl: null,
    broker_upl: null,
    ...partial,
  };
}

describe('per-client exit isolation helpers', () => {
  it('favorableMove is side-correct (BUY vs SELL do not share PnL sign)', () => {
    expect(favorableMove('BUY', 2000, 2005)).toBe(5);
    expect(favorableMove('SELL', 2000, 2005)).toBe(-5);
    expect(favorableMove('SELL', 2000, 1995)).toBe(5);
  });

  it('manageExitPrice uses bid for BUY / ask for SELL', () => {
    expect(manageExitPrice('BUY', { bid: 4659.4, ask: 4659.8, mid: 4659.6 })).toBe(4659.4);
    expect(manageExitPrice('SELL', { bid: 4659.4, ask: 4659.8, mid: 4659.6 })).toBe(4659.8);
  });

  it('thesis failure is opposite-regime only', () => {
    expect(thesisFailureReason('BUY', 'TREND_DOWN')).toMatch(/ThesisFailure/);
    expect(thesisFailureReason('BUY', 'TREND_UP')).toBeNull();
  });
});

describe('decideBestOutcomeExit — profit symmetric', () => {
  it('Gold mfeFloor is tick-based (~0.08pt)', () => {
    expect(boMfeFloor(4660, GOLD)).toBe(0.08);
  });

  it('PeakProtection on +0.86pt micro win after giveback', () => {
    const entry = 4660;
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: 0.86,
        peak_retention: 0.01,
      }),
      entry + 0.01
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/PeakProtection/);
  });

  it('BrokerPeakLock at 50% of £ peak — not full BE chop', () => {
    const entry = 4660;
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: 1.2,
        peak_retention: 0.4,
        broker_peak_upl: 0.86,
        broker_upl: 0.4,
      }),
      entry + 0.5
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/BrokerPeakLock/);
  });

  it('does NOT BrokerPeakLock at £0.01 (no BE spam)', () => {
    const entry = 4660;
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: 0.86,
        peak_retention: 0.01,
        broker_peak_upl: 0.86,
        broker_upl: 0.01,
      }),
      entry + 0.01
    );
    expect(d.reason).not.toMatch(/BrokerPeakLock/);
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/PeakProtection/);
  });

  it('target at symmetric TP', () => {
    const entry = 4660;
    const tp = boTpDistance(entry, GOLD);
    expect(tp).toBeLessThan(16);
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: entry, mfe: tp }),
      entry + tp
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Target/);
  });
});

describe('decideManageExit — unified pipeline', () => {
  it('green SELL vs rally — HOLD (profit rules first, no tape chop)', () => {
    const entry = 4593.52;
    const d = decideManageExit(
      snap({
        open_side: 'SELL',
        entry_price: entry,
        mfe: 0.5,
        peak_retention: 0.8,
        regime: 'TREND_UP',
      }),
      entry - 0.2,
      { shortNetPct: 0.004, exitRegime: 'TREND_UP' }
    );
    expect(d.exit).toBe(false);
  });

  it('red SELL vs rally — TapeExit (after profit rules)', () => {
    const entry = 4593.52;
    const d = decideManageExit(
      snap({
        open_side: 'SELL',
        entry_price: entry,
        mfe: 0.05,
        peak_retention: null,
        regime: 'TREND_UP',
      }),
      entry + 4,
      { shortNetPct: 0.004, exitRegime: 'TREND_UP' }
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/TapeExit/);
  });

  it('ThesisFailure when red + opposite regime', () => {
    const d = decideManageExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_DOWN', mfe: 0 }),
      1999.5,
      { exitRegime: 'TREND_DOWN' }
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/ThesisFailure/);
  });

  it('describe shows BO HOLD state', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 2 }),
      4601
    );
    expect(s.hold).toMatch(/BO HOLD/);
  });
});
