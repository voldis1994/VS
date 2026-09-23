import { describe, expect, it, beforeEach } from 'vitest';
import {
  closed1mProfitPolicy,
  decideBestOutcomeExit,
  beLockMinExec,
  executableFavorable,
  favorableMove,
  hardInvStopDistance,
  scaleDeskAbs,
  softLossLine,
  BE_LOCK_FRAC,
  DESK_REF_MID,
  HARDINV_ABS_CAP,
  HARDINV_ABS_FLOOR,
  HARDINV_CONFIRM_MS,
  HARDINV_GRACE_MS,
  PEAK_MFE_ABS_FLOOR,
  TARGET_ABS_FLOOR,
  TIMEDECAY_MIN_FAV_ABS,
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

describe('positive R:R Soft HardInv', () => {
  it('caps Soft HardInv near ~2.2 on Gold (not 4–6pt % runaway)', () => {
    const trend = hardInvStopDistance(2650, 'TREND_UP');
    const range = hardInvStopDistance(2650, 'RANGE');
    const capAt = scaleDeskAbs(HARDINV_ABS_CAP, 2650);
    expect(trend).toBeLessThanOrEqual(capAt + 0.01);
    expect(trend).toBeGreaterThanOrEqual(scaleDeskAbs(HARDINV_ABS_FLOOR, 2650) - 0.01);
    expect(range).toBeLessThanOrEqual(capAt * 1.25 + 0.01);
    expect(range).toBeGreaterThan(trend - 0.01);
  });

  it('same Soft % R:R on any mid (scale abs — one cal for all markets)', () => {
    const atRef = hardInvStopDistance(DESK_REF_MID, 'TREND_UP');
    const cheap = hardInvStopDistance(2.15, 'TREND_UP');
    const rich = hardInvStopDistance(4350, 'TREND_UP');
    expect(cheap / 2.15).toBeCloseTo(atRef / DESK_REF_MID, 5);
    expect(rich / 4350).toBeCloseTo(atRef / DESK_REF_MID, 5);
    expect(cheap).toBeLessThan(0.05);
  });

  it('softLossLine BE-lock is a fraction of Soft SL (scale-free)', () => {
    const sl = 2.0;
    expect(softLossLine(sl, 0.5)).toBe(-sl);
    expect(softLossLine(sl, 2.0)).toBeCloseTo(sl * BE_LOCK_FRAC, 5);
    const oilSl = hardInvStopDistance(2.15, 'TREND_UP');
    expect(softLossLine(oilSl, oilSl + 0.001)).toBeCloseTo(oilSl * BE_LOCK_FRAC, 8);
  });

  it('Peak MFE floor ≥ Soft HardInv so winners are not micro-scalped', () => {
    const cal = defaultDeskCalibration();
    expect(cal.peak_mfe_abs).toBeGreaterThanOrEqual(PEAK_MFE_ABS_FLOOR);
    expect(cal.peak_mfe_abs).toBeGreaterThan(cal.hardinv_abs);
    expect(cal.target_abs).toBeGreaterThan(cal.hardinv_abs);
    expect(TARGET_ABS_FLOOR).toBeGreaterThan(cal.hardinv_abs);
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

  it('HardInv needs grace + confirm; RANGE only slightly wider', () => {
    const now = Date.now();
    const aged = {
      entry_at: new Date(now - 60_000).toISOString(),
      hardinv_breach_since_ms: now - (HARDINV_CONFIRM_MS + 1_000),
    };
    const slTrend = hardInvStopDistance(2000, 'TREND_UP');
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        ...aged,
      }),
      2000 - slTrend + 0.3,
      'live_loss',
      now
    );
    expect(hold.exit).toBe(false);

    const pending = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        entry_at: aged.entry_at,
        hardinv_breach_since_ms: 0,
      }),
      2000 - slTrend - 0.2,
      'live_loss',
      now
    );
    expect(pending.exit).toBe(false);
    expect(pending.hardinv_breaching).toBe(true);

    const cutTrend = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'TREND_UP', ...aged }),
      2000 - slTrend - 0.2,
      'live_loss',
      now
    );
    expect(cutTrend.exit).toBe(true);
    expect(cutTrend.reason).toMatch(/HardInvalidation/);

    const shallow = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'RANGE', ...aged }),
      1996.5,
      'live_loss',
      now
    );
    expect(shallow.exit).toBe(true);
  });

  it('HardInv grace skips soft cut in first seconds (SAFETY SL still live)', () => {
    const now = Date.now();
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        entry_at: new Date(now - Math.floor(HARDINV_GRACE_MS / 2)).toISOString(),
        hardinv_breach_since_ms: now - Math.floor(HARDINV_GRACE_MS / 2),
      }),
      1990,
      'live_loss',
      now
    );
    expect(d.exit).toBe(false);
    expect(d.hardinv_breaching).toBe(false);
  });

  it('BE-lock cuts when MFE reached Soft SL then price returns near lock with exec edge', () => {
    const now = Date.now();
    const sl = hardInvStopDistance(2000, 'TREND_UP');
    const lock = softLossLine(sl, sl + 0.5);
    const minExec = beLockMinExec(sl);
    // Slightly under lock so fav ≤ lossLine (avoid float equality miss)
    const mid = 2000 + lock - 0.02;
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        mfe: sl + 0.5,
        entry_at: new Date(now - 60_000).toISOString(),
        hardinv_breach_since_ms: now - (HARDINV_CONFIRM_MS + 500),
      }),
      mid,
      'live_loss',
      now,
      { bid: 2000 + minExec + 0.05, ask: mid + 0.3 }
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/BE-lock/);
  });

  it('BE-lock does NOT scratch mid-flat when bid/ask would be cash-red (Funds magic-minus)', () => {
    const now = Date.now();
    const sl = hardInvStopDistance(2000, 'TREND_UP');
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        regime: 'TREND_UP',
        mfe: sl + 0.5,
        entry_at: new Date(now - 60_000).toISOString(),
        hardinv_breach_since_ms: now - (HARDINV_CONFIRM_MS + 500),
      }),
      2000.1,
      'live_loss',
      now,
      { bid: 1999.7, ask: 2000.4 }
    );
    expect(d.exit).toBe(false);
    expect(executableFavorable('BUY', 2000, 1999.7, 2000.4, 2000.1)).toBeLessThan(
      beLockMinExec(sl)
    );
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

  it('PeakProtect ignores sub-floor MFE (no micro-scalp winners)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe: 1.2,
        peak_retention: 0.5,
      }),
      2000.6,
      'peak_protect_only'
    );
    expect(d.exit).toBe(false);
  });

  it('PeakProtect needs real giveback after MFE', () => {
    const minGb = defaultDeskCalibration().peak_min_giveback_abs;
    const mfe = 8;
    const tinyGiveback = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe,
        peak_retention: 0.5,
      }),
      2000 + mfe - (minGb - 0.1),
      'peak_protect_only'
    );
    const enough = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe,
        peak_retention: 0.5,
      }),
      2000 + mfe * 0.5,
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

  it('target banks wins at ≥ TARGET_ABS_FLOOR (positive R:R)', () => {
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

  it('TimeDecay does NOT scratch fav≈0 after hold (broker spread magic-minus)', () => {
    const now = Date.now();
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

    const tooSmall = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 4352.73,
        regime: 'RANGE',
        mfe: 3.5,
        peak_retention: 1,
        entry_at: new Date(now - 13 * 60_000).toISOString(),
      }),
      4351.5,
      'target_time',
      now
    );
    expect(tooSmall.exit).toBe(false);
    expect(TIMEDECAY_MIN_FAV_ABS).toBeGreaterThanOrEqual(2);

    // Real lock: fav ≥ scaled TimeDecay min + Soft SL fraction; mfe ≥ Peak floor
    const entry = 4352.73;
    const sl = hardInvStopDistance(entry, 'RANGE');
    const minFav = Math.max(
      scaleDeskAbs(TIMEDECAY_MIN_FAV_ABS, entry),
      sl * 0.9,
      scaleDeskAbs(TARGET_ABS_FLOOR, entry) * 0.4
    );
    const mfeNeed = scaleDeskAbs(PEAK_MFE_ABS_FLOOR, entry);
    const lockFav = Math.max(minFav + 0.2, mfeNeed);
    const realLock = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: entry,
        regime: 'RANGE',
        mfe: Math.max(lockFav + 1, mfeNeed + 1),
        peak_retention: 1,
        entry_at: new Date(now - 13 * 60_000).toISOString(),
      }),
      entry - lockFav,
      'target_time',
      now
    );
    expect(realLock.exit).toBe(true);
    expect(realLock.reason).toMatch(/TimeDecay/);
  });

  it('asymmetry proof: Peak lock ≥ Soft HardInv (no 80%-win net-minus profile)', () => {
    const entry = 2650;
    const sl = hardInvStopDistance(entry, 'TREND_UP');
    const cal = defaultDeskCalibration();
    const peakFloor = scaleDeskAbs(cal.peak_mfe_abs, entry);
    const minGb = scaleDeskAbs(cal.peak_min_giveback_abs, entry);
    const earliestPeakLock = peakFloor - minGb;
    expect(peakFloor).toBeGreaterThan(sl);
    expect(earliestPeakLock).toBeGreaterThan(sl * 0.7);
  });
});
