import { describe, expect, it } from 'vitest';
import {
  decideBestOutcomeExit,
  favorableMove,
  thesisFailureReason,
  THESIS_MIN_HOLD_MS,
  type ExitSnapshot,
} from './exitManage.js';

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

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
    const d = decideBestOutcomeExit(snap({ open_side: 'BUY', entry_price: 2000, mfe: 0.4 }), 2000.5);
    expect(d.exit).toBe(false);
  });

  it('ignores ThesisFailure until min hold elapsed', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_DOWN',
        mfe: 2,
        entry_at: ago(10_000),
      }),
      2001
    );
    expect(d.exit).toBe(false);
  });

  it('exits BUY on TREND_DOWN thesis failure after min hold', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_DOWN',
        mfe: 2,
        entry_at: ago(THESIS_MIN_HOLD_MS + 5_000),
      }),
      2001
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/ThesisFailure/);
  });

  it('exits SELL on TREND_UP without affecting BUY rules (after min hold)', () => {
    const aged = ago(THESIS_MIN_HOLD_MS + 5_000);
    const sell = decideBestOutcomeExit(
      snap({ open_side: 'SELL', entry_price: 2000, regime: 'TREND_UP', entry_at: aged }),
      1999
    );
    const buy = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_UP', entry_at: aged }),
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

  it('does not PeakProtect on micro MFE below ~0.18% floor', () => {
    // 0.15 pts << 0.18% of 2000 (= 3.6) — old 0.12 floor would have armed
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        mfe: 0.15,
        peak_retention: 0.2,
      }),
      2000.03
    );
    expect(d.exit).toBe(false);
  });

  it('peak protection after meaningful MFE giveback (ret < 50%)', () => {
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

  it('holds when peak retention still above 50%', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        mfe: 8,
        peak_retention: 0.6,
      }),
      2004.8
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
