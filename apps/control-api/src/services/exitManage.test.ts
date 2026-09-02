import { describe, expect, it } from 'vitest';
import {
  decideBestOutcomeExit,
  executableFavorableMove,
  favorableMove,
  thesisFailureReason,
  type ExitSnapshot,
} from './exitManage.js';

function q(mid: number, bid?: number, ask?: number) {
  return { mid, bid: bid ?? null, ask: ask ?? null };
}

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

  it('executableFavorableMove uses bid for BUY and ask for SELL', () => {
    expect(executableFavorableMove('BUY', 4310, q(4312, 4311.5, 4312))).toBe(1.5);
    expect(executableFavorableMove('SELL', 4310, q(4308, 4307.5, 4308))).toBe(2);
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
      q(2000.5)
    );
    expect(d.exit).toBe(false);
  });

  it('LONG hard invalidation ~0.25%', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, regime: 'RANGE', playbook: 'LONG' }),
      q(1994)
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
  });

  it('LONG peak protect below 40% retention', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 2000,
        mfe: 8,
        peak_retention: 0.3,
        playbook: 'LONG',
      }),
      q(2002.4)
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/ProfitGiveback|PeakProtection/);
  });

  it('target uses playbook TP', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 2000, mfe: 8, playbook: 'LONG' }),
      q(2008)
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
        peak_retention: 0.7,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      q(4420.68)
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
      q(4432)
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Target/);
  });

  it('BREAKOUT impulse holds past +1.5pt — not default SCALP tpFloor 0.22', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'SELL',
        entry_price: 4370,
        entry_at: ago(120_000),
        mfe: 2.0,
        peak_retention: 0.7,
        playbook: 'SCALP',
        entry_setup: 'BREAKOUT',
        regime: 'BREAKOUT_DOWN',
      }),
      q(4368.5)
    );
    expect(d.exit).toBe(false);
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
      q(4420.68)
    );
    expect(d.exit).toBe(false);
  });

  it('ReversalStop fires instead of holding to full SL after MFE lost', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4310,
        entry_at: ago(130_000),
        mfe: 2.5,
        peak_retention: 0,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      q(4309.5, 4309.2, 4309.7)
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/ReversalStop/);
  });

  it('mid looked green but bid is red — does not harvest', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4310,
        entry_at: ago(130_000),
        mfe: 2.0,
        peak_retention: 0.15,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      q(4310.3, 4309.8, 4310.8)
    );
    expect(d.exit).toBe(false);
  });

  it('ProfitGiveback exits after half the leg is returned while still green', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4322.51,
        entry_at: ago(300_000),
        mfe: 6.5,
        peak_retention: 0.42,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      q(4325.2, 4325.0, 4325.5)
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/ProfitGiveback/);
  });

  it('ReversalStop cuts when proven MFE trade goes underwater', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4322.51,
        entry_at: ago(480_000),
        mfe: 6.5,
        peak_retention: 0,
        playbook: 'LONG',
        entry_setup: 'CONTINUATION',
      }),
      q(4318.5, 4318.34, 4318.84)
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/ReversalStop/);
  });
});
