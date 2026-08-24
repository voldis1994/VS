import { describe, expect, it } from 'vitest';
import {
  bestOutcomeMfeFloor,
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
  it('favorableMove is side-correct (BUY vs SELL do not share PnL sign)', () => {
    expect(favorableMove('BUY', 2000, 2005)).toBe(5);
    expect(favorableMove('SELL', 2000, 2005)).toBe(-5);
    expect(favorableMove('SELL', 2000, 1995)).toBe(5);
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

describe('decideBestOutcomeExit', () => {
  it('holds a young BUY in TREND_UP with small noise', () => {
    const d = decideBestOutcomeExit(snap({ open_side: 'BUY', entry_price: 2000, mfe: 0.4 }), 2000.05);
    expect(d.exit).toBe(false);
  });

  it('does not soft-exit flat after giveback', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        mfe: 5,
        peak_retention: 0.05,
      }),
      2000.05
    );
    expect(d.exit).toBe(false);
  });

  it('exits BUY on TREND_DOWN thesis failure when still green', () => {
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
      1999.5
    );
    const buy = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_UP' }),
      1999
    );
    expect(sell.exit).toBe(true);
    expect(buy.exit).toBe(false);
  });

  it('hard invalidation at ~0.32% adverse (before broker disaster SL)', () => {
    const sl = hardInvalidationDistance(2000);
    expect(sl).toBeGreaterThanOrEqual(6.4);
    const d = decideBestOutcomeExit(snap({ open_side: 'BUY', entry_price: 2000, regime: 'RANGE' }), 1993);
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
  });

  it('peak protection after meaningful MFE giveback (~1.4pt floor)', () => {
    const floor = bestOutcomeMfeFloor(4600);
    expect(floor).toBeLessThan(2);
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        regime: 'TREND_UP',
        mfe: 2.0,
        peak_retention: 0.3,
      }),
      4600.6
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/PeakProtection/);
  });

  it('target at ~0.28%', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_UP', mfe: 8 }),
      2006
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Target/);
  });

  it('describeBestOutcomeState shows BO hold line when not exiting', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4519, mfe: 1.5, peak_retention: 0.8 }),
      4519.5
    );
    expect(s.exit).toBe(false);
    expect(s.hold).toMatch(/BO · UPL/);
    expect(s.hold).toMatch(/MFE/);
  });
});
