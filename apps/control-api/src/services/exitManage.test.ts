import { describe, expect, it } from 'vitest';
import {
  decideBestOutcomeExit,
  favorableMove,
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

  it('PeakProtect arms after ~1.2pt MFE (not waiting for old 2.5 floor)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 4380,
        mfe: 1.5,
        playbook: 'SCALP',
        entry_setup: 'BREAKOUT',
      }),
      4379.2 // fav 0.8 → ret 53%
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/PeakProtection/);
  });

  it('soft HardInv capped ~1.0pt on Gold CONTINUATION', () => {
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4400,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
        entry_at: ago(10_000),
        regime: 'TREND_UP',
      }),
      4399.2
    );
    expect(hold.exit).toBe(false);
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4400,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
        entry_at: ago(10_000),
        regime: 'TREND_UP',
      }),
      4398.8
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
