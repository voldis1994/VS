import { describe, expect, it, beforeEach } from 'vitest';
import {
  closed1mProfitPolicy,
  decideBestOutcomeExit,
  favorableMove,
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

  it('HardInv needs grace + confirm; RANGE SL is wider (anti magic-minus wick)', () => {
    const now = Date.now();
    const aged = {
      entry_at: new Date(now - 60_000).toISOString(),
      hardinv_breach_since_ms: now - 15_000,
    };
    // TREND: SL = max(3.0, 2.0) = 3.0
    const hold = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_DOWN', ...aged }),
      1997.2,
      'live_loss',
      now
    );
    // First tick beyond SL — stamp breach, do not cut yet
    const pending = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        entry_at: aged.entry_at,
        hardinv_breach_since_ms: 0,
      }),
      1996.5,
      'live_loss',
      now
    );
    expect(pending.exit).toBe(false);
    expect(pending.hardinv_breaching).toBe(true);

    // TREND confirmed cut
    const cutTrend = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_UP', ...aged }),
      1996.5,
      'live_loss',
      now
    );
    expect(hold.exit).toBe(false);
    expect(cutTrend.exit).toBe(true);
    expect(cutTrend.reason).toMatch(/HardInvalidation/);

    // RANGE: SL *= 1.6 → 4.8; same -3.5pt wick must HOLD (the magic-minus case)
    const rangeWick = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'RANGE', ...aged }),
      1996.5,
      'live_loss',
      now
    );
    expect(rangeWick.exit).toBe(false);

    // RANGE deep adverse still cuts after confirm
    const rangeCut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'RANGE', ...aged }),
      1994.5,
      'live_loss',
      now
    );
    expect(rangeCut.exit).toBe(true);
    expect(rangeCut.reason).toMatch(/HardInvalidation/);
  });

  it('HardInv grace skips soft cut in first 25s (SAFETY SL still live)', () => {
    const now = Date.now();
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        entry_at: new Date(now - 5_000).toISOString(),
        hardinv_breach_since_ms: now - 5_000,
      }),
      1990,
      'live_loss',
      now
    );
    expect(d.exit).toBe(false);
    expect(d.hardinv_breaching).toBe(false);
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

  it('PeakProtect needs real giveback after MFE (scalp min giveback)', () => {
    const minGb = defaultDeskCalibration().peak_min_giveback_abs;
    const tinyGiveback = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe: 8,
        peak_retention: 0.7,
      }),
      2000 + 8 - (minGb - 0.1),
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

  it('target banks wins at scalp TP (max pct/abs)', () => {
    // scalp defaults: entry 2000 → TP = max(5, 2.25) = 5
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

  it('TimeDecay does NOT scratch fav≈0 after 8m (broker spread magic-minus)', () => {
    const now = Date.now();
    // Old bug: held >8m + fav>=0 → close; short cover at ask printed −£0.06
    const flat = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 4352.73,
        regime: 'RANGE',
        mfe: 1.2,
        peak_retention: 1,
        entry_at: new Date(now - 8 * 60_000).toISOString(),
      }),
      4352.7,
      'target_time',
      now
    );
    expect(flat.exit).toBe(false);

    const realLock = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 4352.73,
        regime: 'RANGE',
        mfe: 2.5,
        peak_retention: 1,
        entry_at: new Date(now - 13 * 60_000).toISOString(),
      }),
      4351.5,
      'target_time',
      now
    );
    expect(realLock.exit).toBe(true);
    expect(realLock.reason).toMatch(/TimeDecay/);
  });
});
