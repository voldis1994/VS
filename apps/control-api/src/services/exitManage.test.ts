import { describe, expect, it } from 'vitest';
import {
  BEST_OUTCOME_LOCK_RETENTION,
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

  it('cuts when peak was real and giveback hits flat/red — never wait HardInv', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        regime: 'TREND_UP',
        mfe: 5,
        peak_retention: 0.01,
      }),
      4599.9
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/BestOutcome cut|gave back/);
  });

  it('locks majority of MFE while still green (~65% retention)', () => {
    expect(BEST_OUTCOME_LOCK_RETENTION).toBe(0.65);
    // MFE 5pt, fav ~3.0 → ret 0.60 < 0.65 → lock
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        regime: 'TREND_UP',
        mfe: 5,
        peak_retention: 0.6,
      }),
      4603
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/PeakProtection/);
  });

  it('holds near peak (ret 90%)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        regime: 'TREND_UP',
        mfe: 5,
        peak_retention: 0.9,
      }),
      4604.5
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

  it('hard invalidation at ~0.11% adverse (micro ~£0.60 not £0.89 on Gold 0.15)', () => {
    const sl = hardInvalidationDistance(2000);
    expect(sl).toBeGreaterThanOrEqual(2.2);
    expect(sl).toBeLessThan(2.5);
    // Gold ~4640: ~5.2pt HardInv (was ~7.4pt at 0.16%)
    expect(hardInvalidationDistance(4640)).toBeLessThan(5.3);
    expect(hardInvalidationDistance(4640)).toBeGreaterThan(5.0);
    const d = decideBestOutcomeExit(snap({ open_side: 'BUY', entry_price: 2000, regime: 'RANGE' }), 1997);
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
  });

  it('arms from ~1.0pt MFE on Gold', () => {
    const floor = bestOutcomeMfeFloor(4600);
    expect(floor).toBeLessThanOrEqual(1.1);
    expect(floor).toBeGreaterThanOrEqual(0.8);
  });

  it('target at ~0.22%', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_UP', mfe: 8 }),
      2004.5
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Target/);
  });

  it('describeBestOutcomeState shows lock threshold', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4519, mfe: 1.5, peak_retention: 0.9 }),
      4519.5
    );
    expect(s.exit).toBe(false);
    expect(s.hold).toMatch(/lock@65%/);
  });
});
