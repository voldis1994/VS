import { describe, expect, it } from 'vitest';
import {
  decideBestOutcomeExit,
  favorableMove,
  hardInvOppositeScalpSide,
  hardInvFlipBrokerAction,
  thesisFailureReason,
  type ExitSnapshot,
} from './exitManage.js';

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function snap(
  partial: Partial<ExitSnapshot> & { open_side: 'BUY' | 'SELL'; entry_price: number }
): ExitSnapshot {
  return {
    mfe: 0,
    mae: 0,
    peak_retention: null,
    entry_at: ago(130_000),
    regime: 'TREND_UP',
    playbook: 'LONG',
    ...partial,
  };
}

describe('per-client exit isolation helpers', () => {
  it('favorableMove is side-correct', () => {
    expect(favorableMove('BUY', 2000, 2005)).toBe(5);
    expect(favorableMove('SELL', 2000, 2005)).toBe(-5);
  });

  it('legacy thesisFailureReason stays SCALP-style', () => {
    expect(thesisFailureReason('BUY', 'TREND_DOWN')).toMatch(/ThesisFailure/);
    expect(thesisFailureReason('BUY', 'RANGE')).toBeNull();
  });
});

describe('decideBestOutcomeExit playbook-aware', () => {
  it('holds young LONG BUY in TREND_UP', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, mfe: 0.4, entry_at: ago(10_000) }),
      2000.5
    );
    expect(d.exit).toBe(false);
  });

  it('LONG hard invalidation ~0.25%', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'RANGE', playbook: 'LONG' }),
      1994
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
  });

  it('LONG peak protect below 75% retention (max 25% giveback)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe: 8,
        peak_retention: 0.5,
        playbook: 'LONG',
      }),
      2004
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/PeakProtection/);
  });

  it('holds while retention still ≥75%', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe: 7,
        peak_retention: 0.5, // stale — live fav at 2005.3 is ~76% of MFE, below TP
        playbook: 'LONG',
      }),
      2005.3
    );
    expect(d.exit).toBe(false);
  });

  it('user Gold SELL example: PeakProtect at ~55% giveback (entry 4380.22 → peak ~4.3pt → close 4377.84)', () => {
    // Capital: SELL 4380.22, floating +£0.86 (~4.3pt), closed 4377.84 (+2.38pt / ~55% of MFE)
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 4380.22,
        mfe: 4.3,
        peak_retention: 0.9,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
        entry_at: ago(40_000),
      }),
      4380.22 - 4.3 * 0.8 // still 80% retention
    );
    expect(hold.exit).toBe(false);
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 4380.22,
        mfe: 4.3,
        peak_retention: 0.9, // stale snapshot — live fav must win
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
        entry_at: ago(60_000),
      }),
      4377.84
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/PeakProtection/);
  });

  it('PeakProtect arms after ~2.5pt MFE on CONTINUATION (not 1.2 noise)', () => {
    const early = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 4380,
        mfe: 1.5,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      4379.2 // fav 0.8 — below CONTINUATION floor
    );
    expect(early.exit).toBe(false);
    const armed = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 4380,
        mfe: 3.0,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      4378.5 // fav 1.5 → ret 50%
    );
    expect(armed.exit).toBe(true);
    expect(armed.reason).toMatch(/PeakProtection/);
  });

  it('Target beats PeakProtect when fav ≥ TP', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe: 20,
        peak_retention: 0.5,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      2007 // fav 7 ≥ tpFloor 6.5 (pct×2000=5 → floor wins)
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Target/);
  });

  it('thesis uses entry_regime not live flicker', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4400,
        mfe: 0.5,
        entry_at: ago(200_000),
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
        entry_regime: 'TREND_UP', // locked at fill — still valid
        regime: 'TREND_DOWN', // live flicker must not scratch
      }),
      4399.5 // slightly red
    );
    expect(d.exit).toBe(false);
  });

  it('BreakevenFail disabled — BE→red holds until HardInv', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 4380.22,
        mfe: 0.05, // only BE / +£0.01 class
        be_seen: true,
        profit_seen: false,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
        entry_at: ago(30_000),
      }),
      4380.22 + 0.4 // SELL: price up → fav -0.4 — must NOT scratch-exit
    );
    expect(d.exit).toBe(false);
  });

  it('post-BE with real profit still holds until HardInv', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 4380.22,
        mfe: 2.0,
        be_seen: true,
        profit_seen: true,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
        entry_at: ago(30_000),
      }),
      4380.22 + 0.4 // fav -0.4 — still hold until HardInv ~1.5pt
    );
    expect(d.exit).toBe(false);
  });

  it('never touched BE → no early exit at −0.4 (wait HardInv)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4380,
        mfe: 0,
        be_seen: false,
        profit_seen: false,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
        entry_at: ago(30_000),
      }),
      4379.6 // fav -0.4
    );
    expect(d.exit).toBe(false);
  });

  it('live_loss gate fires HardInv; closed_1m_profit gate ignores live red', () => {
    const snapLoss = snap({
      open_side: 'BUY',
      entry_price: 4400,
      playbook: 'LONG',
      entry_setup: 'CONTINUATION',
      entry_at: ago(20_000),
    });
    expect(decideBestOutcomeExit(snapLoss, 4398.4, 'live_loss').reason).toMatch(/HardInvalidation/);
    expect(decideBestOutcomeExit(snapLoss, 4398.4, 'closed_1m_profit').exit).toBe(false);
  });

  it('closed_1m_profit gate fires PeakProtect; live_loss ignores green giveback', () => {
    const snapGreen = snap({
      open_side: 'SELL',
      entry_price: 4380.22,
      mfe: 4.3,
      profit_seen: true,
      playbook: 'LONG',
      entry_setup: 'CONTINUATION',
      entry_at: ago(60_000),
    });
    expect(decideBestOutcomeExit(snapGreen, 4377.84, 'closed_1m_profit').reason).toMatch(
      /PeakProtection/
    );
    expect(decideBestOutcomeExit(snapGreen, 4377.84, 'live_loss').exit).toBe(false);
  });

  it('soft HardInv capped ~1.5pt on Gold CONTINUATION (tight for flip SCALP)', () => {
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4400,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
        entry_at: ago(10_000),
        regime: 'TREND_UP',
      }),
      4398.7 // -1.3 — still inside 1.5
    );
    expect(hold.exit).toBe(false);
    const stillHold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4400,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
        entry_at: ago(10_000),
        regime: 'TREND_UP',
      }),
      4398.55 // -1.45 — just inside 1.5
    );
    expect(stillHold.exit).toBe(false);
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4400,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
        entry_at: ago(10_000),
        regime: 'TREND_UP',
      }),
      4398.4 // -1.6 ≥ cap 1.5
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/HardInvalidation/);
  });

  it('target uses playbook TP', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, mfe: 8, playbook: 'LONG' }),
      2008
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Target/);
  });

  it('CONTINUATION bounce holds past +1.5pt — does not FADE-scalp at tpFloor 0.18', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4419,
        entry_at: ago(120_000),
        mfe: 2.0,
        peak_retention: 0.9,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      4420.68
    );
    expect(d.exit).toBe(false);
  });

  it('CONTINUATION exits on real target ~12pt rally', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4419,
        entry_at: ago(200_000),
        mfe: 14,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      4432
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Target/);
  });

  it('FADE bounce holds past +1.5pt — tpFloor 3 not 0.18', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4419,
        entry_at: ago(90_000),
        mfe: 1.8,
        playbook: 'FADE',
        entry_setup: 'FADE',
      }),
      4420.68
    );
    expect(d.exit).toBe(false);
  });
});

describe('hardInvOppositeScalpSide', () => {
  it('arms opposite after HardInv', () => {
    expect(hardInvOppositeScalpSide('HardInvalidation · LONG · UPL', 'BUY')).toBe('SELL');
    expect(hardInvOppositeScalpSide('HardInvalidation · SCALP', 'SELL')).toBe('BUY');
  });

  it('does not arm on PeakProtect / BreakevenFail', () => {
    expect(hardInvOppositeScalpSide('PeakProtection · LONG · live', 'BUY')).toBeNull();
    expect(hardInvOppositeScalpSide('BreakevenFail · SCALP', 'SELL')).toBeNull();
  });

  it('does not chain — no flip of a HARDINV_FLIP scalp', () => {
    expect(
      hardInvOppositeScalpSide('HardInvalidation · SCALP', 'BUY', 'HARDINV_FLIP')
    ).toBeNull();
  });
});

describe('hardInvFlipBrokerAction', () => {
  it('enters when broker flat', () => {
    expect(hardInvFlipBrokerAction('SELL', null)).toBe('enter');
  });

  it('waits while old HardInv leg still listed', () => {
    expect(hardInvFlipBrokerAction('SELL', 'BUY')).toBe('wait_clear');
  });

  it('adopts when opposite SCALP already live', () => {
    expect(hardInvFlipBrokerAction('SELL', 'SELL')).toBe('adopt_flip');
  });

  it('none without pending flip', () => {
    expect(hardInvFlipBrokerAction(null, 'BUY')).toBe('none');
  });
});
