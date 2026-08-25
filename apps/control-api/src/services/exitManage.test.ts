import { describe, expect, it } from 'vitest';
import {
  BEST_OUTCOME_LOCK_RETENTION,
  bestOutcomeMfeFloor,
  bestOutcomeMinGreen,
  bestOutcomeTarget,
  decideBestOutcomeExit,
  describeBestOutcomeState,
  favorableMove,
  hardInvalidationDistance,
  thesisFailureReason,
  type ExitSnapshot,
} from './exitManage.js';

function snap(partial: Partial<ExitSnapshot> & { open_side: 'BUY' | 'SELL'; entry_price: number }): ExitSnapshot {
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
  it('favorableMove is side-correct', () => {
    expect(favorableMove('BUY', 2000, 2005)).toBe(5);
    expect(favorableMove('SELL', 2000, 2005)).toBe(-5);
  });

  it('thesis failure is opposite-regime only', () => {
    expect(thesisFailureReason('BUY', 'TREND_DOWN')).toMatch(/ThesisFailure/);
    expect(thesisFailureReason('SELL', 'TREND_UP')).toMatch(/ThesisFailure/);
    expect(thesisFailureReason('BUY', 'TREND_UP')).toBeNull();
  });
});

describe('decideBestOutcomeExit 5m hold-longer', () => {
  it('holds micro green below minGreen (~5pt)', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4640, mfe: 2, peak_retention: 0.5 }),
      4641
    );
    expect(d.exit).toBe(false);
    expect(bestOutcomeMinGreen(4640)).toBeGreaterThanOrEqual(5);
  });

  it('does not PeakProtect on small MFE (below arm floor)', () => {
    // Old bug: ~6pt peak + 35% pullback → early bank while move continues
    const floor = bestOutcomeMfeFloor(4600);
    expect(floor).toBeGreaterThanOrEqual(12);
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        mfe: 6,
        peak_retention: 0.64,
      }),
      4603.8
    );
    expect(d.exit).toBe(false);
  });

  it('cuts when peak was real and giveback hits flat/red', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        mfe: 15,
        peak_retention: 0.01,
      }),
      4599.9
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/BestOutcome cut|gave back/);
  });

  it('PeakProtect only after deep giveback (~50%) while green', () => {
    expect(BEST_OUTCOME_LOCK_RETENTION).toBe(0.5);
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        mfe: 20,
        peak_retention: 0.64,
      }),
      4612.8
    );
    expect(hold.exit).toBe(false);

    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4600,
        mfe: 20,
        peak_retention: 0.45,
      }),
      4609
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/PeakProtection/);
  });

  it('hard invalidation at ~0.22%', () => {
    expect(hardInvalidationDistance(4600)).toBeCloseTo(10.12, 1);
    const d = decideBestOutcomeExit(snap({ open_side: 'BUY', entry_price: 4600, regime: 'RANGE' }), 4589);
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
  });

  it('arms peak after ~13pt MFE on Gold', () => {
    const floor = bestOutcomeMfeFloor(4600);
    expect(floor).toBeGreaterThanOrEqual(12);
    expect(floor).toBeLessThanOrEqual(14);
  });

  it('target at ~1.20%', () => {
    expect(bestOutcomeTarget(4600)).toBeCloseTo(55.2, 0);
    const early = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4600, regime: 'TREND_UP', mfe: 30 }),
      4630
    );
    expect(early.exit).toBe(false);

    const hit = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4600, regime: 'TREND_UP', mfe: 56 }),
      4656
    );
    expect(hit.exit).toBe(true);
    expect(hit.reason).toMatch(/Target/);
  });

  it('cuts BUY when short window is dumping even if regime still UP', () => {
    const d = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4647,
        regime: 'TREND_UP',
        short_net_pct: -0.004,
        mfe: 1,
      }),
      4640
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/ThesisFailure · short dump/);
  });

  it('describeBestOutcomeState shows BO5m lock@50%', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 15, peak_retention: 0.9 }),
      4612
    );
    expect(s.exit).toBe(false);
    expect(s.hold).toMatch(/BO5m/);
    expect(s.hold).toMatch(/lock@50%/);
  });
});
