/**
 * BO — restored Aug 13 2026 17:43 (e0e479a).
 */
import { describe, expect, it } from 'vitest';
import {
  decideBestOutcomeExit,
  describeBestOutcomeState,
  favorableMove,
  manageExitPrice,
  thesisFailureReason,
  boMfeFloor,
  boTpDistance,
  type ExitSnapshot,
} from './exitManage.js';

function snap(
  partial: Partial<ExitSnapshot> & { open_side: 'BUY' | 'SELL'; entry_price: number }
): ExitSnapshot {
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
  it('favorableMove is side-correct (BUY vs SELL do not share PnL sign)', () => {
    expect(favorableMove('BUY', 2000, 2005)).toBe(5);
    expect(favorableMove('SELL', 2000, 2005)).toBe(-5);
    expect(favorableMove('SELL', 2000, 1995)).toBe(5);
  });

  it('manageExitPrice uses bid for BUY / ask for SELL', () => {
    expect(manageExitPrice('BUY', { bid: 4659.4, ask: 4659.8, mid: 4659.6 })).toBe(4659.4);
    expect(manageExitPrice('SELL', { bid: 4659.4, ask: 4659.8, mid: 4659.6 })).toBe(4659.8);
  });

  it('does not invent thesis failure on RANGE/COMPRESSION/UNKNOWN', () => {
    expect(thesisFailureReason('BUY', 'RANGE')).toBeNull();
    expect(thesisFailureReason('BUY', 'COMPRESSION')).toBeNull();
    expect(thesisFailureReason('SELL', 'UNKNOWN')).toBeNull();
    expect(thesisFailureReason('BUY', 'TREND_UP')).toBeNull();
    expect(thesisFailureReason('SELL', 'TREND_DOWN')).toBeNull();
  });

  it('thesis failure is opposite-regime only — each side independent', () => {
    expect(thesisFailureReason('BUY', 'TREND_DOWN')).toMatch(/ThesisFailure/);
    expect(thesisFailureReason('BUY', 'BREAKOUT_DOWN')).toMatch(/ThesisFailure/);
    expect(thesisFailureReason('SELL', 'TREND_UP')).toMatch(/ThesisFailure/);
    expect(thesisFailureReason('SELL', 'BREAKOUT_UP')).toMatch(/ThesisFailure/);
    expect(thesisFailureReason('BUY', 'TREND_UP')).toBeNull();
    expect(thesisFailureReason('SELL', 'TREND_DOWN')).toBeNull();
  });
});

describe('decideBestOutcomeExit (Aug 13 setup)', () => {
  it('holds a young BUY in TREND_UP with small noise', () => {
    const d = decideBestOutcomeExit(snap({ open_side: 'BUY', entry_price: 2000, mfe: 0.4 }), 2000.5);
    expect(d.exit).toBe(false);
  });

  it('exits BUY on TREND_DOWN thesis failure even if still green', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_DOWN', mfe: 2 }),
      2001
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/ThesisFailure/);
  });

  it('exits SELL on TREND_UP without affecting BUY rules', () => {
    const sell = decideBestOutcomeExit(
      snap({ open_side: 'SELL', entry_price: 2000, regime: 'TREND_UP' }),
      1999
    );
    const buy = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_UP' }),
      1999
    );
    expect(sell.exit).toBe(true);
    expect(buy.exit).toBe(false);
  });

  it('hard invalidation on ~0.22% adverse', () => {
    const d = decideBestOutcomeExit(snap({ open_side: 'BUY', entry_price: 2000, regime: 'RANGE' }), 1994);
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
  });

  it('peak protection after meaningful MFE giveback (ret < 30%)', () => {
    const entry = 2000;
    const mfe = 8;
    const floor = boMfeFloor(entry);
    expect(mfe).toBeGreaterThanOrEqual(floor);
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        regime: 'TREND_UP',
        mfe,
        peak_retention: 0.2,
      }),
      2001.6
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/PeakProtection/);
  });

  it('does NOT exit near BE when MFE was small (no GivebackBE chop)', () => {
    const entry = 4660;
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        regime: 'TREND_UP',
        mfe: 0.86,
        peak_retention: 0.01,
        broker_upl: 0.01,
      }),
      entry + 0.01
    );
    expect(d.exit).toBe(false);
  });

  it('target at ~0.35%', () => {
    const entry = 2000;
    const tp = boTpDistance(entry);
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: entry, regime: 'TREND_UP', mfe: tp }),
      entry + tp
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Target/);
  });

  it('BestOutcome harvest when green after MFE floor and ret < 40%', () => {
    const entry = 2000;
    const mfe = 6;
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        regime: 'TREND_UP',
        mfe,
        peak_retention: 0.35,
      }),
      entry + 2
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/BestOutcome harvest/);
  });

  it('describe shows BO HOLD state', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 2, regime: 'TREND_UP' }),
      4601
    );
    expect(s.hold).toMatch(/BO HOLD/);
    expect(s.hold).toMatch(/peak MFE/);
  });
});
