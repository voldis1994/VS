import { describe, expect, it, beforeEach } from 'vitest';
import {
  closed1mProfitPolicy,
  decideBestOutcomeExit,
  beLockMinExec,
  executableFavorable,
  favorableMove,
  hardInvStopDistance,
  safetyTakeProfitDistance,
  safetyTakeProfitDistancePts,
  safetyTakeProfitLevel,
  scaleDeskAbs,
  softLossLine,
  targetTakeProfitDistance,
  minProfitBank,
  BE_LOCK_FRAC,
  DESK_REF_MID,
  HARDINV_ABS_CAP,
  HARDINV_ABS_FLOOR,
  HARDINV_CONFIRM_MS,
  HARDINV_GRACE_MS,
  PEAK_MFE_ABS_FLOOR,
  SAFETY_TP_MIN_RR,
  TARGET_ABS_FLOOR,
  TIMEDECAY_MIN_FAV_ABS,
  thesisFailureReason,
  regimeExitProfile,
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

  it('softLossLine is always −Soft — never flat BE after Soft MFE (Funds scratch bug)', () => {
    const sl = 2.0;
    expect(softLossLine(sl, 0.5)).toBe(-sl);
    expect(softLossLine(sl, 2.0)).toBe(-sl);
    expect(softLossLine(sl, 10)).toBe(-sl);
    expect(BE_LOCK_FRAC).toBe(0);
    expect(minProfitBank(sl)).toBe(sl);
    const oilSl = hardInvStopDistance(2.15, 'TREND_UP');
    expect(softLossLine(oilSl, oilSl + 0.001)).toBe(-oilSl);
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

  it('Soft does NOT cut at flat after Soft MFE — Peak owns winners (no Funds scratch)', () => {
    const now = Date.now();
    const sl = hardInvStopDistance(2000, 'TREND_UP');
    // Mid flat / slightly red after Soft-sized MFE — Soft holds (lossLine = −Soft)
    const mid = 1999.98;
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
      { bid: 1999.9, ask: mid + 0.3 }
    );
    expect(d.exit).toBe(false);
  });

  it('Soft still cuts true Soft-sized losers after Soft MFE (full −Soft)', () => {
    const now = Date.now();
    const sl = hardInvStopDistance(4330, 'TREND_UP');
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4330,
        regime: 'TREND_UP',
        mfe: sl + 0.5,
        entry_at: new Date(now - 60_000).toISOString(),
        hardinv_breach_since_ms: now - (HARDINV_CONFIRM_MS + 500),
      }),
      4330 - sl - 0.2,
      'live_loss',
      now,
      { bid: 4330 - sl - 0.3, ask: 4330 - sl }
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
    expect(d.reason).not.toMatch(/BE-lock/);
  });

  it('PeakProtect does NOT bank below Soft HardInv (Funds +£0.01 vs −£0.06)', () => {
    const entry = 4330;
    const sl = hardInvStopDistance(entry, 'TREND_UP');
    const mfeNeed = scaleDeskAbs(PEAK_MFE_ABS_FLOOR, entry);
    // Tiny green after reverse — below Soft — must HOLD
    const tiny = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: entry,
        regime: 'TREND_DOWN',
        mfe: mfeNeed + 0.5,
        peak_retention: 0.5,
        entry_at: new Date(Date.now() - 120_000).toISOString(),
      }),
      entry - Math.min(sl * 0.4, 1.0),
      'peak_protect_only',
      Date.now(),
      { bid: entry - Math.min(sl * 0.4, 1.0) - 0.1, ask: entry - Math.min(sl * 0.4, 1.0) }
    );
    expect(tiny.exit).toBe(false);
    // Exec ≥ Soft → Peak may cut
    const mid = entry - (sl + 0.2);
    const ok = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: entry,
        regime: 'TREND_DOWN',
        mfe: mfeNeed + 0.5,
        peak_retention: 0.5,
        entry_at: new Date(Date.now() - 120_000).toISOString(),
      }),
      mid,
      'peak_protect_only',
      Date.now(),
      { bid: mid - 0.1, ask: mid }
    );
    expect(minProfitBank(sl)).toBe(sl);
    expect(ok.exit).toBe(true);
  });

  it('Soft does NOT scratch mid-green after Soft MFE (Peak owns banking)', () => {
    const now = Date.now();
    const sl = hardInvStopDistance(2000, 'TREND_UP');
    const mid = 2000.15;
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
      { bid: 1999.7, ask: mid + 0.3 }
    );
    expect(d.exit).toBe(false);
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

    // Real lock on TREND (RANGE hits Target earlier — by design for fades)
    const entry = 4352.73;
    const sl = hardInvStopDistance(entry, 'TREND_DOWN');
    const minFav = Math.max(
      scaleDeskAbs(TIMEDECAY_MIN_FAV_ABS, entry),
      sl * 0.9,
      scaleDeskAbs(TARGET_ABS_FLOOR, entry) * 0.4
    );
    const mfeNeed = scaleDeskAbs(PEAK_MFE_ABS_FLOOR, entry);
    const trendTp =
      Math.max(
        scaleDeskAbs(TARGET_ABS_FLOOR, entry),
        entry * defaultDeskCalibration().target_pct
      ) * regimeExitProfile('TREND_DOWN').target_mult;
    const lockFav = Math.min(Math.max(minFav + 0.15, mfeNeed), trendTp - 0.4);
    const realLock = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: entry,
        entry_regime: 'TREND_DOWN',
        regime: 'TREND_DOWN',
        mfe: Math.max(lockFav + 1, mfeNeed + 1),
        peak_retention: 1,
        entry_at: new Date(now - 15 * 60_000).toISOString(),
      }),
      entry - lockFav,
      'target_time',
      now
    );
    expect(realLock.exit).toBe(true);
    expect(realLock.reason).toMatch(/TimeDecay|Target/);
  });

  it('RANGE Target/TimeDecay tighter than TREND (fade ≠ trend run)', () => {
    const now = Date.now();
    const aged = new Date(now - 8 * 60_000).toISOString();
    // RANGE: target ~0.55× → fires earlier on same mid move
    const rangeTp = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        entry_regime: 'RANGE',
        regime: 'RANGE',
        mfe: 3,
        peak_retention: 1,
        entry_at: aged,
      }),
      2002.5, // +2.5 — below TREND TP (~4.6) but near RANGE TP (~2.5)
      'target_time',
      now
    );
    const trendTp = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        entry_regime: 'TREND_UP',
        regime: 'TREND_UP',
        mfe: 3,
        peak_retention: 1,
        entry_at: aged,
      }),
      2002.5,
      'target_time',
      now
    );
    expect(rangeTp.exit).toBe(true);
    expect(rangeTp.reason).toMatch(/fade|Target/);
    expect(trendTp.exit).toBe(false);
  });

  it('BREAKOUT structure kill when price back under hi (entry_zone frozen)', () => {
    const now = Date.now();
    const zone = { hi: 4340, lo: 4320, mid: 4330, width: 20 };
    const pending = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4341,
        entry_regime: 'BREAKOUT_UP',
        regime: 'BREAKOUT_UP',
        entry_zone: zone,
        entry_at: new Date(now - 60_000).toISOString(),
        structure_breach_since_ms: 0,
        mfe: 1,
      }),
      4338,
      'live_loss',
      now
    );
    expect(pending.exit).toBe(false);
    expect(pending.structure_breaching).toBe(true);

    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4341,
        entry_regime: 'BREAKOUT_UP',
        regime: 'BREAKOUT_UP',
        entry_zone: zone,
        entry_at: new Date(now - 60_000).toISOString(),
        structure_breach_since_ms: now - 4_000,
        mfe: 1,
      }),
      4338,
      'live_loss',
      now
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/StructureInvalidation|back under/);
  });

  it('structure does NOT scratch micro-green below Soft (same-minute £0.xx bug)', () => {
    const now = Date.now();
    const entry = 4330;
    // Narrow zone — through_mid fires at tiny green past mid
    const zone = { hi: 4332, lo: 4328, mid: 4330, width: 4 };
    const soft = hardInvStopDistance(entry, 'RANGE');
    // RANGE fade BUY through mid at +0.3 — below Soft — must HOLD
    const tinyMid = entry + 0.3;
    expect(tinyMid).toBeGreaterThan(zone.mid + zone.width * 0.05);
    expect(0.3).toBeLessThan(soft);
    const tiny = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        entry_regime: 'RANGE',
        regime: 'RANGE',
        entry_zone: zone,
        entry_at: new Date(now - 60_000).toISOString(),
        structure_breach_since_ms: now - 4_000,
        mfe: 0.35,
      }),
      tinyMid,
      'live_loss',
      now,
      { bid: tinyMid - 0.05, ask: tinyMid + 0.05 }
    );
    expect(tiny.exit).toBe(false);
    expect(tiny.structure_breaching).toBeFalsy();

    // Soft-sized green through mid → structure may bank
    const bankMid = entry + soft + 0.3;
    const bank = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        entry_regime: 'RANGE',
        regime: 'RANGE',
        entry_zone: zone,
        entry_at: new Date(now - 60_000).toISOString(),
        structure_breach_since_ms: now - 4_000,
        mfe: soft + 0.5,
      }),
      bankMid,
      'live_loss',
      now,
      { bid: bankMid - 0.05, ask: bankMid + 0.05 }
    );
    expect(bank.exit).toBe(true);
    expect(bank.reason).toMatch(/StructureInvalidation/);
  });

  it('entry_regime freeze — live COMPRESSION does not rewrite TREND Soft thesis', () => {
    const trendSl = hardInvStopDistance(2000, 'TREND_UP');
    const liveFlip = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        entry_regime: 'TREND_UP',
        regime: 'COMPRESSION', // live flicker
        mfe: 0.2,
      }),
      2000.1,
      'live_loss'
    );
    expect(liveFlip.exit).toBe(false);
    // Soft distance follows entry_regime TREND, not live COMPRESSION
    expect(hardInvStopDistance(2000, 'TREND_UP')).toBe(trendSl);
    expect(hardInvStopDistance(2000, 'COMPRESSION')).not.toBe(trendSl);
  });
});

describe('broker SAFETY TP (opposite of Soft HardInv)', () => {
  it('safety_tp_rr moves broker TP while SL ref fixed', () => {
    const entry = 4300;
    const stopPts = entry * 0.002; // ~8.6
    setDeskCalibration({ ...defaultDeskCalibration(), safety_tp_rr: 1.5 });
    const narrow = safetyTakeProfitDistance(entry, 'RANGE', { stopDistancePrice: stopPts });
    setDeskCalibration({ ...defaultDeskCalibration(), safety_tp_rr: 2.5 });
    const wide = safetyTakeProfitDistance(entry, 'RANGE', { stopDistancePrice: stopPts });
    expect(wide).toBeGreaterThan(narrow + 1);
    expect(Math.abs(wide - stopPts * 2.5)).toBeLessThan(0.05);
  });

  it('BUY TP above entry; SELL below — always ≥ 1.5× SAFETY SL', () => {
    const entry = 2650;
    const safetySl = entry * 0.002; // same cushion % as broker SAFETY SL
    const buyTp = safetyTakeProfitLevel('BUY', entry, 'RANGE', null, safetySl);
    const sellTp = safetyTakeProfitLevel('SELL', entry, 'RANGE', null, safetySl);
    expect(buyTp).toBeGreaterThan(entry);
    expect(sellTp).toBeLessThan(entry);
    expect(buyTp - entry).toBeGreaterThanOrEqual(safetySl * 1.5 - 0.15);
    expect(entry - sellTp).toBeGreaterThanOrEqual(safetySl * 1.5 - 0.15);
  });

  it('RANGE manage Target ≥ Soft HardInv; broker SAFETY TP still ≥ 1.5× SL', () => {
    const entry = 2650;
    const safetySl = entry * 0.002;
    const softTarget = targetTakeProfitDistance(entry, 'RANGE');
    const softSl = hardInvStopDistance(entry, 'RANGE');
    expect(softTarget).toBeGreaterThanOrEqual(softSl);
    const brokerTpDist = safetyTakeProfitDistance(entry, 'RANGE', {
      stopDistancePrice: safetySl,
    });
    expect(brokerTpDist).toBeGreaterThanOrEqual(safetySl * 1.5 - 1e-9);
  });

  it('profitDistance pts ≥ 1.5× stopDistance pts', () => {
    const entry = 2650;
    const stopPts = 50;
    const pointSize = 0.1;
    const tpPts = safetyTakeProfitDistancePts(entry, 'RANGE', 10, pointSize, stopPts);
    expect(tpPts).toBeGreaterThanOrEqual(stopPts * 1.5);
  });

  it('respects broker min stop/profit distance floor', () => {
    const entry = 2650;
    const wide = safetyTakeProfitLevel('BUY', entry, 'RANGE', 20, 5);
    expect(wide - entry).toBeGreaterThanOrEqual(20 * 1.05 - 1e-9);
  });
});
