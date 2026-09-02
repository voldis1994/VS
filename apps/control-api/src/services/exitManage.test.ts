import { describe, expect, it } from 'vitest';
import {
  decideBestOutcomeExit,
  executableFavorableMove,
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

  it('executableFavorableMove uses bid for BUY / ask for SELL', () => {
    expect(executableFavorableMove('BUY', 2000, { mid: 2005, bid: 2004, ask: 2006 })).toBe(4);
    expect(executableFavorableMove('SELL', 2000, { mid: 1995, bid: 1994, ask: 1996 })).toBe(4);
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

  it('holds live green move past first TP touch', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4430,
        entry_at: ago(60_000),
        mfe: 5,
        peak_retention: 0.9,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      4434.5
    );
    expect(d.exit).toBe(false);
  });

  it('ReversalStop cuts after protected MFE goes red', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4430,
        entry_at: ago(60_000),
        mfe: 2.0,
        peak_retention: 0,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      4429.5
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/ReversalStop/);
  });

  it('EarlyCut soft-SL before max when no protected MFE', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4430,
        entry_at: ago(40_000),
        mfe: 0.1,
        playbook: 'LONG',
      }),
      4430 - 4430 * 0.0025 * 0.6
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/EarlyCut|HardInvalidation/);
  });

  it('never PeakProtect into a red closeable P&L', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4430,
        entry_at: ago(60_000),
        mfe: 2.5,
        peak_retention: 0.2,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      { mid: 4431, bid: 4429.5, ask: 4431.2 }
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/ReversalStop/);
  });

  it('CONTINUATION bounce holds past +1.5pt — does not FADE-scalp at tpFloor 0.18', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4419,
        entry_at: ago(120_000),
        mfe: 2.0,
        peak_retention: 0.7,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      4420.68
    );
    expect(d.exit).toBe(false);
  });

  it('ProfitGiveback locks ≥65% of MFE (US100 +0.43 must not close at +0.18)', () => {
    // Peak ~42 pts from 28932 → closeable 16.5 pts ≈ 39% retention → must exit
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 28932.6,
        entry_at: ago(60_000),
        mfe: 42,
        peak_retention: 0.39,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      { mid: 28949.1, bid: 28949.1, ask: 28950.9 }
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/PeakProtection|ProfitGiveback/);
  });

  it('holds when retention still ≥65% (35% giveback allowed)', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 28932.6,
        entry_at: ago(60_000),
        mfe: 42,
        peak_retention: 0.66,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      { mid: 28960.3, bid: 28960.3, ask: 28961.5 }
    );
    // closeable ≈ 27.7 / 42 ≈ 66% — above floor, no giveback exit
    expect(d.exit).toBe(false);
  });

  it('micro-swing CONTINUATION does not PeakProtect in first 15s on sub-2pt MFE', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4430,
        entry_at: ago(12_000),
        mfe: 1.2,
        peak_retention: 0.4,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      4430.5
    );
    expect(d.exit).toBe(false);
  });
});
