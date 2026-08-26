import { describe, expect, it } from 'vitest';
import {
  BEST_OUTCOME_LOCK_RETENTION,
  BEST_OUTCOME_LOCK_TRIGGER,
  bestOutcomeMfeFloor,
  decideBestOutcomeExit,
  describeBestOutcomeState,
  hardInvalidationDistance,
  manageExitPrice,
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

describe('decideBestOutcomeExit — PeakProtect 75%', () => {
  it('HardInv 2.0pt Gold', () => {
    expect(hardInvalidationDistance(4660)).toBe(2.0);
  });

  it('manageExitPrice uses bid for BUY / ask for SELL', () => {
    expect(manageExitPrice('BUY', { bid: 4659.4, ask: 4659.8, mid: 4659.6 })).toBe(4659.4);
    expect(manageExitPrice('SELL', { bid: 4659.4, ask: 4659.8, mid: 4659.6 })).toBe(4659.8);
  });

  it('HardInv fires at ~2.0pt adverse', () => {
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4660, mfe: 0 }),
      4657.9
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/HardInvalidation/);
  });

  it('short dump/rally thesis only at ~3pt', () => {
    const hold = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4660, mfe: 0, short_net_pct: -2.3 / 4660 }),
      4659.5
    );
    expect(hold.exit).toBe(false);
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4660, mfe: 0, short_net_pct: -3 / 4660 }),
      4659.5
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/short dump.*~3pt/);
  });

  it('lock is 75% with trigger 78%', () => {
    expect(BEST_OUTCOME_LOCK_RETENTION).toBe(0.75);
    expect(BEST_OUTCOME_LOCK_TRIGGER).toBe(0.78);
  });

  it('MFE floor arms at ~1.0pt (no micro £0 spam)', () => {
    expect(bestOutcomeMfeFloor(4640)).toBeGreaterThanOrEqual(1.0);
    expect(bestOutcomeMfeFloor(4640)).toBeLessThan(1.1);
  });

  it('PeakProtect @75% cuts deep giveback even with continuation', () => {
    // MFE 4pt, now 2.5pt left → ret=62.5% < 78% → cut
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4640,
        mfe: 4.0,
        peak_retention: 2.5 / 4.0,
      }),
      4642.5,
      { continuationSameSide: true }
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/PeakProtection/);
    expect(cut.reason).toMatch(/75%/);
  });

  it('PeakProtect holds while still ≥78% of MFE (below TP)', () => {
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4640,
        mfe: 1.5,
        peak_retention: 0.9,
      }),
      4641.2
    );
    expect(hold.exit).toBe(false);
  });

  it('TP fires at 2pt before extended hold', () => {
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4640,
        mfe: 4.0,
        peak_retention: 0.9,
      }),
      4643.2
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/Target \/ best outcome/);
  });

  it('does not arm PeakProtect below 1.0pt MFE', () => {
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4640,
        mfe: 0.5,
        peak_retention: 0.1,
      }),
      4640.05
    );
    expect(hold.exit).toBe(false);
  });

  it('armed peak → flat cuts before minus', () => {
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4640, mfe: 2.0, peak_retention: 0 }),
      4640.0
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/gave back MFE|lock before minus/);
  });

  it('exits on opposite entry signal', () => {
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4640, mfe: 1.5 }),
      4641.2,
      { oppositeEntrySignal: true, oppositeReason: 'TAPE DOWN · 1m=-1.0 5m=-2.0' }
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/OppositeSignal/);
  });

  it('continuation does not skip PeakProtect or HardInv', () => {
    const pp = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 20, peak_retention: 0.35 }),
      4608,
      { continuationSameSide: true }
    );
    expect(pp.exit).toBe(true);
    expect(pp.reason).toMatch(/PeakProtection/);

    const hi = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 10, peak_retention: 0.9 }),
      4580,
      { continuationSameSide: true }
    );
    expect(hi.exit).toBe(true);
    expect(hi.reason).toMatch(/HardInvalidation/);
  });

  it('describe shows PROFIT lock@75%', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 1.5, peak_retention: 0.85 }),
      4601.2,
      { continuationReason: 'continuation · TAPE UP' }
    );
    expect(s.hold).toMatch(/PROFIT/);
    expect(s.hold).toMatch(/lock@75%/);
  });

  it('TP at 2pt Gold closes green', () => {
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4660, mfe: 2.5 }),
      4662.1
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/Target \/ best outcome/);
  });

  it('TimeDecay at 3min banks green when retention still high', () => {
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4660,
        mfe: 1.5,
        peak_retention: 0.85,
        entry_at: new Date(Date.now() - 181_000).toISOString(),
      }),
      4661.2
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/TimeDecay/);
  });
});
