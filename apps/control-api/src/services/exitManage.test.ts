import { describe, expect, it } from 'vitest';
import {
  decideBestOutcomeExit,
  favorableMove,
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

  it('does not invent thesis failure on RANGE/COMPRESSION/UNKNOWN/TREND (OFF)', () => {
    expect(thesisFailureReason('BUY', 'RANGE')).toBeNull();
    expect(thesisFailureReason('BUY', 'COMPRESSION')).toBeNull();
    expect(thesisFailureReason('SELL', 'UNKNOWN')).toBeNull();
    expect(thesisFailureReason('BUY', 'TREND_UP')).toBeNull();
    expect(thesisFailureReason('BUY', 'TREND_DOWN')).toBeNull();
    expect(thesisFailureReason('SELL', 'TREND_DOWN')).toBeNull();
  });

  it('thesis failure only on opposite BREAKOUT (other regimes OFF)', () => {
    expect(thesisFailureReason('BUY', 'BREAKOUT_DOWN')).toMatch(/ThesisFailure/);
    expect(thesisFailureReason('SELL', 'BREAKOUT_UP')).toMatch(/ThesisFailure/);
    expect(thesisFailureReason('BUY', 'TREND_DOWN')).toBeNull();
    expect(thesisFailureReason('SELL', 'TREND_UP')).toBeNull();
    expect(thesisFailureReason('BUY', 'BREAKOUT_UP')).toBeNull();
    expect(thesisFailureReason('SELL', 'BREAKOUT_DOWN')).toBeNull();
  });
});

describe('decideBestOutcomeExit', () => {
  it('holds a young BUY in TREND_UP with small noise', () => {
    const d = decideBestOutcomeExit(snap({ open_side: 'BUY', entry_price: 2000, mfe: 0.4 }), 2000.5);
    expect(d.exit).toBe(false);
  });

  it('exits BUY on BREAKOUT_DOWN thesis failure only while still green', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'BREAKOUT_DOWN', mfe: 2 }),
      2001
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/ThesisFailure/);
  });

  it('TREND_DOWN no longer thesis-exits (regime OFF)', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_DOWN', mfe: 2 }),
      2001
    );
    expect(d.exit).toBe(false);
  });

  it('does not thesis-exit underwater at −0.01 / flat', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 4567,
        regime: 'TREND_UP',
        mfe: 3,
        peak_retention: 0.0,
      }),
      4567.05 // tiny red for SELL
    );
    expect(d.exit).toBe(false);
  });

  it('does not PeakProtect into flat / tiny red after giveback', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 4567.39,
        regime: 'TREND_DOWN',
        mfe: 4,
        peak_retention: 0.05,
      }),
      4567.4 // slightly against SELL → ~−0.01
    );
    expect(d.exit).toBe(false);
  });

  it('exits SELL on BREAKOUT_UP without affecting BUY rules', () => {
    const sell = decideBestOutcomeExit(
      snap({ open_side: 'SELL', entry_price: 2000, regime: 'BREAKOUT_UP' }),
      1999
    );
    const buy = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'BREAKOUT_UP' }),
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

  it('peak protection after meaningful MFE giveback', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        mfe: 8,
        peak_retention: 0.2,
      }),
      2001.6
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/PeakProtection/);
  });

  it('arms peak protection from ~2.2pt MFE on Gold-scale price', () => {
    // 4519 * 0.00049 ≈ 2.21 — small impulse plus now protected after giveback
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4519,
        regime: 'TREND_UP',
        mfe: 2.25,
        peak_retention: 0.25,
      }),
      4519.55
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/PeakProtection/);
  });

  it('still holds sub-floor MFE noise on Gold (~1.5pt)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4519,
        regime: 'TREND_UP',
        mfe: 1.5,
        peak_retention: 0.1,
      }),
      4519.15
    );
    expect(d.exit).toBe(false);
  });

  it('target at ~0.35%', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_UP', mfe: 8 }),
      2008
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Target/);
  });
});
