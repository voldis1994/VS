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

  it('LONG peak protect below 65% retention (max 35% giveback)', () => {
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

  it('holds while retention high and below Target', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe: 8,
        peak_retention: 0.85,
        playbook: 'LONG',
      }),
      2003.5
    );
    expect(d.exit).toBe(false);
  });

  it('soft HardInv is capped (~1.5pt) — not Gold×%≈8pt', () => {
    const stillHold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4400,
        mfe: 0,
        peak_retention: null,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
        entry_at: ago(10_000),
        regime: 'TREND_UP',
      }),
      4399 // −1.0pt — inside 1.5 cap
    );
    expect(stillHold.exit).toBe(false);
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4400,
        mfe: 0,
        peak_retention: null,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
        entry_at: ago(10_000),
        regime: 'TREND_UP',
      }),
      4398.2 // −1.8pt — beyond 1.5 cap
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/HardInvalidation/);
  });

  it('never thesis-kills a green CONTINUATION on TREND_DOWN flicker', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4400,
        entry_at: ago(120_000),
        mfe: 1.2,
        peak_retention: 0.9,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
        regime: 'TREND_DOWN',
      }),
      4400.9
    );
    expect(d.exit).toBe(false);
  });

  it('CONTINUATION does not PeakProtect on tiny +1.5pt MFE (was +£0.17 scalp)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4419,
        entry_at: ago(120_000),
        mfe: 1.5,
        peak_retention: 0.5,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      4419.7
    );
    expect(d.exit).toBe(false);
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

  it('SCALP TimeDecay exits flat mfe=0 after timeDecayMs', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: ago(500_000),
        mfe: 0,
        peak_retention: null,
        playbook: 'SCALP',
        regime: 'RANGE',
      }),
      2000.1
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/TimeDecay/);
  });

  it('SCALP holds when MFE already made the leg (no soft TimeDecay)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        entry_at: ago(500_000),
        mfe: 3.0, // ≥ SCALP mfeFloorAbs 2.8
        peak_retention: 0.9,
        playbook: 'SCALP',
        regime: 'RANGE',
      }),
      2002.5
    );
    expect(d.exit).toBe(false);
  });
});
