import { describe, expect, it } from 'vitest';
import {
  closed1mProfitPolicy,
  decideBestOutcomeExit,
  favorableMove,
  hardInvFlipBrokerAction,
  hardInvOppositeScalpSide,
  PEAK_PROTECT_ARM_MFE,
  shouldArmPeakProtect,
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
        mfe: 8,
        peak_retention: 0.8,
        playbook: 'LONG',
      }),
      2004
    );
    expect(d.exit).toBe(false);
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
      4398.6 // -1.4 — still inside 1.5
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
      4398.4 // -1.6 — past 1.5
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

describe('closed1mProfitPolicy', () => {
  it('continues when BUY still gets green 1m — desk HOLDs (PeakProtect off)', () => {
    expect(
      closed1mProfitPolicy('BUY', { open: 2000, close: 2003 }, { open: 1998, close: 2000 })
    ).toBe('continue');
  });

  it('reverses when next 1m flips against BUY', () => {
    expect(
      closed1mProfitPolicy('BUY', { open: 2003, close: 2000 }, { open: 2000, close: 2003 })
    ).toBe('reverse');
  });

  it('reverses when next 1m flips against SELL', () => {
    expect(
      closed1mProfitPolicy('SELL', { open: 2000, close: 2003 }, { open: 2003, close: 2000 })
    ).toBe('reverse');
  });

  it('wait on doji', () => {
    expect(closed1mProfitPolicy('BUY', { open: 2000, close: 2000 }, null)).toBe('wait');
  });
});

describe('peak_protect_only gate', () => {
  it('exits on live giveback after MFE when retention < 75%', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe: 8,
        peak_retention: 0.5,
        playbook: 'LONG',
      }),
      2004,
      'peak_protect_only'
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/PeakProtection/);
  });

  it('does not Target on peak_protect_only even if TP hit', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe: 1,
        peak_retention: 0.95,
        playbook: 'LONG',
      }),
      2025, // deep green ≥ TP — peak_protect_only must NOT Target
      'peak_protect_only'
    );
    expect(d.exit).toBe(false);
  });

  it('live_loss still HardInvs without waiting for 1m', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4400, playbook: 'LONG', entry_setup: 'CONTINUATION' }),
      4398.4,
      'live_loss'
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
  });

  it('holds peak_protect_only until MFE floor 1.5 even if retention low', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4400,
        mfe: 1.2,
        peak_retention: 0.4,
        playbook: 'SCALP',
      }),
      4400.5,
      'peak_protect_only'
    );
    expect(d.exit).toBe(false);
  });
});

describe('PeakProtect arms live at +1.5 MFE (no 1m wait)', () => {
  it('arms at exactly 1.5 MFE', () => {
    expect(PEAK_PROTECT_ARM_MFE).toBe(1.5);
    expect(shouldArmPeakProtect(1.5, false)).toBe(true);
  });

  it('does not arm below 1.5', () => {
    expect(shouldArmPeakProtect(1.49, false)).toBe(false);
  });

  it('does not re-arm when already ON', () => {
    expect(shouldArmPeakProtect(5, true)).toBe(false);
  });
});

describe('HardInv only — no micro-red / thesis scratch', () => {
  it('does NOT exit at -0.19 noise (next 1m can still profit)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4400,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
        entry_at: ago(130_000),
        regime: 'TREND_DOWN', // would have been thesis before
      }),
      4399.81, // -0.19
      'live_loss'
    );
    expect(d.exit).toBe(false);
  });

  it('HardInv fires only at ~1.5pt live loss', () => {
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4400,
        playbook: 'SCALP',
        entry_setup: 'CONTINUATION',
      }),
      4398.6, // -1.4
      'live_loss'
    );
    expect(hold.exit).toBe(false);
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4400,
        playbook: 'SCALP',
        entry_setup: 'CONTINUATION',
      }),
      4398.4, // -1.6
      'live_loss'
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/HardInvalidation/);
  });

  it('regime flip while slightly red does NOT thesis-scratch', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        playbook: 'LONG',
        entry_at: ago(200_000),
        regime: 'TREND_DOWN',
      }),
      1999.7,
      'live_loss'
    );
    expect(d.exit).toBe(false);
  });
});
