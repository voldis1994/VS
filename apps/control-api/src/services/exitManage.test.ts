import { describe, expect, it } from 'vitest';
import {
  BEST_OUTCOME_LOCK_RETENTION,
  bestOutcomeMfeFloor,
  bestOutcomeMinGreen,
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
  it('holds micro green noise (+£0.01 style) — no soft exit', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4640, mfe: 0.5, peak_retention: 0.5 }),
      4640.3
    );
    expect(d.exit).toBe(false);
    expect(bestOutcomeMinGreen(4640)).toBeGreaterThanOrEqual(1.0);
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

  it('locks majority of MFE while still meaningful green (~70%)', () => {
    expect(BEST_OUTCOME_LOCK_RETENTION).toBe(0.7);
    // MFE 5pt, fav 3.2 → ret 0.64 < 0.70 and fav >= minGreen → lock
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        regime: 'TREND_UP',
        mfe: 5,
        peak_retention: 0.64,
      }),
      4603.2
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

  it('exits BUY on TREND_DOWN thesis failure when still meaningful green', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_DOWN', mfe: 3 }),
      2001.5
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/ThesisFailure/);
  });

  it('exits SELL on TREND_UP without affecting BUY rules', () => {
    const sell = decideBestOutcomeExit(
      snap({ open_side: 'SELL', entry_price: 2000, regime: 'TREND_UP' }),
      1998.5
    );
    const buy = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_UP' }),
      1999
    );
    expect(sell.exit).toBe(true);
    expect(buy.exit).toBe(false);
  });

  it('hard invalidation at ~0.08% (Gold ~3.7pt ≈ ~£0.40 on 0.14)', () => {
    expect(hardInvalidationDistance(2000)).toBeCloseTo(1.6, 5);
    expect(hardInvalidationDistance(4640)).toBeLessThan(3.8);
    expect(hardInvalidationDistance(4640)).toBeGreaterThan(3.5);
    const d = decideBestOutcomeExit(snap({ open_side: 'BUY', entry_price: 2000, regime: 'RANGE' }), 1998);
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
  });

  it('arms peak only after ~2.2pt MFE on Gold (not 1pt noise)', () => {
    const floor = bestOutcomeMfeFloor(4600);
    expect(floor).toBeGreaterThanOrEqual(1.8);
    expect(floor).toBeLessThanOrEqual(2.3);
  });

  it('target at ~0.28%', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_UP', mfe: 8 }),
      2006
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Target/);
  });

  it('describeBestOutcomeState shows min green + lock', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4519, mfe: 3, peak_retention: 0.9 }),
      4521
    );
    expect(s.exit).toBe(false);
    expect(s.hold).toMatch(/lock@70%/);
    expect(s.hold).toMatch(/min\+/);
  });
});
