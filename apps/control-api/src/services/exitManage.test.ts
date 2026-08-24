import { describe, expect, it } from 'vitest';
import {
  decideBestOutcomeExit,
  describeBestOutcomeState,
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

  it('hard invalidation at ≈3pt adverse on Gold-scale (not ~15pt)', () => {
    // entry 4638 → HI @ −3 → mid 4635
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4638, regime: 'RANGE' }),
      4635
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
  });

  it('holds small red under 3pt HardInv (room for Best Outcome green)', () => {
    // −1.29 style noise must NOT cut
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4638, regime: 'RANGE' }),
      4636.5
    );
    expect(d.exit).toBe(false);
  });

  it('still hard-invalidates deep adverse on mid-price instruments', () => {
    const d = decideBestOutcomeExit(snap({ open_side: 'BUY', entry_price: 2000, regime: 'RANGE' }), 1993);
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
  });

  it('peak protection after meaningful MFE giveback (past min hold)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        mfe: 8,
        peak_retention: 0.2,
        entry_at: new Date(Date.now() - 90_000).toISOString(),
      }),
      2001.6
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/PeakProtection/);
  });

  it('does not peak-exit before min hold even with giveback', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        mfe: 8,
        peak_retention: 0.2,
        entry_at: new Date(Date.now() - 15_000).toISOString(),
      }),
      2001.6
    );
    expect(d.exit).toBe(false);
  });

  it('arms peak protection from ~2.5pt MFE on Gold-scale price', () => {
    // 4519 * 0.00055 ≈ 2.49
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4519,
        regime: 'TREND_UP',
        mfe: 2.6,
        peak_retention: 0.2,
        entry_at: new Date(Date.now() - 90_000).toISOString(),
      }),
      4519.5
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/PeakProtection/);
  });

  it('holds ~1.5pt Gold MFE (under new floor) even with giveback', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4519,
        regime: 'TREND_UP',
        mfe: 1.5,
        peak_retention: 0.25,
        entry_at: new Date(Date.now() - 90_000).toISOString(),
      }),
      4519.4
    );
    expect(d.exit).toBe(false);
  });

  it('still holds sub-floor MFE noise on Gold (~0.5pt)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4519,
        regime: 'TREND_UP',
        mfe: 0.5,
        peak_retention: 0.1,
        entry_at: new Date(Date.now() - 90_000).toISOString(),
      }),
      4519.05
    );
    expect(d.exit).toBe(false);
  });

  it('target at ~0.45%', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        mfe: 10,
        entry_at: new Date(Date.now() - 90_000).toISOString(),
      }),
      2009.1
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Target/);
  });

  it('holds under old 0.28% target until new TP', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        mfe: 8,
        entry_at: new Date(Date.now() - 90_000).toISOString(),
      }),
      2005.7
    );
    expect(d.exit).toBe(false);
  });
});

describe('describeBestOutcomeState', () => {
  it('reports blocked when entry_price missing', () => {
    const d = describeBestOutcomeState(
      { open_side: 'BUY', entry_price: null, mfe: 0, mae: 0, peak_retention: null, entry_at: null },
      4519
    );
    expect(d.exit).toBe(false);
    expect(d.hold).toMatch(/blocked/);
  });

  it('reports idle when underwater below minGreen', () => {
    const d = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4519, mfe: 0.2, regime: 'BREAKOUT_UP' }),
      4518.5
    );
    expect(d.exit).toBe(false);
    expect(d.hold).toMatch(/BO idle/);
  });

  it('reports BO hold countdown while green under min hold', () => {
    const d = describeBestOutcomeState(
      snap({
        open_side: 'BUY',
        entry_price: 4519,
        mfe: 1,
        regime: 'BREAKOUT_UP',
        entry_at: new Date(Date.now() - 10_000).toISOString(),
      }),
      4520
    );
    expect(d.exit).toBe(false);
    expect(d.hold).toMatch(/BO hold/);
  });
});
