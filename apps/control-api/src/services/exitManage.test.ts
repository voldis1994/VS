import { describe, expect, it, beforeEach } from 'vitest';
import {
  closed1mProfitPolicy,
  decideBestOutcomeExit,
  favorableMove,
  HARDINV_ABS_FLOOR,
  PEAK_MIN_GIVEBACK_ABS,
  thesisFailureReason,
  type ExitSnapshot,
} from './exitManage.js';
import { defaultDeskCalibration, setDeskCalibration } from './deskCalibration.js';

beforeEach(() => {
  setDeskCalibration(defaultDeskCalibration());
});

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

  it('does NOT scratch green OR micro-red on thesis flicker', () => {
    const green = decideBestOutcomeExit(
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
    const microRed = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_DOWN',
        mfe: 0.5,
        entry_at: new Date(Date.now() - 120_000).toISOString(),
      }),
      1999.7,
      'live_loss'
    );
    expect(green.exit).toBe(false);
    expect(microRed.exit).toBe(false);
  });

  it('HardInv only after soft SL (≥1.5pt floor; ~0.15% on Gold)', () => {
    // entry 2000 → SL = max(3.0, 1.5) = 3.0
    const hold = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_DOWN' }),
      1997.2,
      'live_loss'
    );
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'RANGE' }),
      1996.9,
      'live_loss'
    );
    expect(hold.exit).toBe(false);
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/HardInvalidation/);
  });

  it('PeakProtect never cuts red after reverse (screenshot micro-loss bug)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe: 2.5,
        peak_retention: 0,
      }),
      1999.8,
      'peak_protect_only'
    );
    expect(d.exit).toBe(false);
  });

  it('PeakProtect needs ≥0.75pt giveback after real MFE', () => {
    const tinyGiveback = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe: 8,
        peak_retention: 0.7,
      }),
      2000 + 8 - (PEAK_MIN_GIVEBACK_ABS - 0.1),
      'peak_protect_only'
    );
    const enough = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe: 8,
        peak_retention: 0.7,
      }),
      2000 + 8 * 0.7,
      'peak_protect_only'
    );
    expect(tinyGiveback.exit).toBe(false);
    expect(enough.exit).toBe(true);
    expect(enough.reason).toMatch(/PeakProtection/);
  });

  it('peak_protect_only gate ignores HardInv / Target', () => {
    const hold = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, mfe: 8, peak_retention: 0.9 }),
      1990,
      'peak_protect_only'
    );
    expect(hold.exit).toBe(false);
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

  it('target at ≥ max(0.35%, 4pt) so wins can outsize HardInv', () => {
    // entry 2000 → TP = max(7, 4) = 7
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        mfe: 7.1,
        peak_retention: 1,
      }),
      2007.1
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Target/);
  });
});
