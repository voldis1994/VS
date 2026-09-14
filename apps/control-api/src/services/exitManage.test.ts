import { describe, expect, it } from 'vitest';
import {
  closed1mProfitPolicy,
  decideBestOutcomeExit,
  favorableMove,
  thesisFailureReason,
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

describe('closed1mProfitPolicy', () => {
  it('continues BUY on green 1m → HOLD', () => {
    expect(closed1mProfitPolicy('BUY', { open: 2000, close: 2002 })).toBe('continue');
  });
  it('reverses BUY on red 1m → PeakProtect arms', () => {
    expect(closed1mProfitPolicy('BUY', { open: 2000, close: 1998 })).toBe('reverse');
  });
  it('continues SELL on red 1m → HOLD', () => {
    expect(closed1mProfitPolicy('SELL', { open: 2000, close: 1997 })).toBe('continue');
  });
  it('waits on doji', () => {
    expect(closed1mProfitPolicy('BUY', { open: 2000, close: 2000 })).toBe('wait');
  });
});

describe('decideBestOutcomeExit', () => {
  it('holds a young BUY in TREND_UP with small noise', () => {
    const d = decideBestOutcomeExit(snap({ open_side: 'BUY', entry_price: 2000, mfe: 0.4 }), 2000.5);
    expect(d.exit).toBe(false);
  });

  it('does NOT scratch a green BUY on TREND_DOWN thesis flicker', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_DOWN',
        mfe: 2,
        peak_retention: 1,
        entry_at: new Date(Date.now() - 120_000).toISOString(),
      }),
      2001,
      'live_loss'
    );
    expect(d.exit).toBe(false);
  });

  it('thesis failure only when underwater after min hold', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_DOWN',
        mfe: 0.5,
        entry_at: new Date(Date.now() - 120_000).toISOString(),
      }),
      1999.5
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/ThesisFailure/);
  });

  it('exits SELL on TREND_UP when underwater without affecting BUY rules', () => {
    const sell = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 2000,
        regime: 'TREND_UP',
        entry_at: new Date(Date.now() - 120_000).toISOString(),
      }),
      2001
    );
    const buy = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        entry_at: new Date(Date.now() - 120_000).toISOString(),
      }),
      1999
    );
    expect(sell.exit).toBe(true);
    expect(buy.exit).toBe(false);
  });

  it('hard invalidation on soft SL (~0.15%)', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'RANGE' }),
      1994
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
  });

  it('peak protection after 25% MFE giveback (retention < 75%)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        mfe: 8,
        peak_retention: 0.7,
      }),
      2005.6
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/PeakProtection/);
  });

  it('peak_protect_only gate ignores HardInv / Target', () => {
    const hold = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, mfe: 8, peak_retention: 0.9 }),
      1990,
      'peak_protect_only'
    );
    expect(hold.exit).toBe(false);
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, mfe: 8, peak_retention: 0.7 }),
      2005.6,
      'peak_protect_only'
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/PeakProtection/);
  });

  it('live_loss gate ignores Peak / Target', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe: 8,
        peak_retention: 0.2,
      }),
      2005,
      'live_loss'
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
