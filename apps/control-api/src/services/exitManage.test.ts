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

const GOLD_META = { tick_size: 0.01 };

function snap(partial: Partial<ExitSnapshot> & { open_side: 'BUY' | 'SELL'; entry_price: number }): ExitSnapshot {
  return {
    mfe: 0,
    mae: 0,
    peak_retention: null,
    entry_at: new Date().toISOString(),
    regime: 'TREND_UP',
    tick_size: GOLD_META.tick_size,
    ...partial,
  };
}

describe('decideBestOutcomeExit — PeakProtect 75%', () => {
  it('HardInv ~0.043% of Gold mid', () => {
    expect(hardInvalidationDistance(4660, null, GOLD_META)).toBeCloseTo(4660 * 0.00043, 2);
  });

  it('manageExitPrice uses bid for BUY / ask for SELL', () => {
    expect(manageExitPrice('BUY', { bid: 4659.4, ask: 4659.8, mid: 4659.6 })).toBe(4659.4);
    expect(manageExitPrice('SELL', { bid: 4659.4, ask: 4659.8, mid: 4659.6 })).toBe(4659.8);
  });

  it('HardInv fires at adverse beyond threshold', () => {
    const sl = hardInvalidationDistance(4660, null, GOLD_META)!;
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4660, mfe: 0 }),
      4660 - sl - 0.01
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/HardInvalidation/);
  });

  it('short dump/rally thesis scales with entry', () => {
    const entry = 4660;
    const hold = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: entry, mfe: 0, short_net_pct: -0.0004 }),
      4659.5
    );
    expect(hold.exit).toBe(false);
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: entry, mfe: 0, short_net_pct: -0.001 }),
      4659.5
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/short dump/);
  });

  it('lock is 75% with trigger 78%', () => {
    expect(BEST_OUTCOME_LOCK_RETENTION).toBe(0.75);
    expect(BEST_OUTCOME_LOCK_TRIGGER).toBe(0.78);
  });

  it('MFE floor is half HardInv', () => {
    expect(bestOutcomeMfeFloor(4640, null, GOLD_META)).toBeCloseTo(
      hardInvalidationDistance(4640, null, GOLD_META)! * 0.5,
      5
    );
  });

  it('PeakProtect @75% cuts deep giveback even with continuation', () => {
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

  it('TP fires at HardInv-distance target', () => {
    const entry = 4640;
    const tp = hardInvalidationDistance(entry, null, GOLD_META)!;
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: entry,
        mfe: tp,
        peak_retention: 0.95,
      }),
      entry + tp
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/Target \/ best outcome/);
  });

  it('does not arm PeakProtect below MFE floor', () => {
    const floor = bestOutcomeMfeFloor(4640, null, GOLD_META)!;
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4640,
        mfe: floor * 0.4,
        peak_retention: 0.1,
      }),
      4640.05
    );
    expect(hold.exit).toBe(false);
  });

  it('armed peak → flat cuts before minus', () => {
    const floor = bestOutcomeMfeFloor(4640, null, GOLD_META)!;
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4640, mfe: floor + 0.5, peak_retention: 0 }),
      4640.0
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/gave back MFE|lock before minus/);
  });

  it('exits on opposite entry signal when not strongly armed', () => {
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4640, mfe: 0.2 }),
      4640.1,
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

  it('describe shows BO lock@75%', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 1.5, peak_retention: 0.85 }),
      4601.2,
      { continuationReason: 'continuation · TAPE UP' }
    );
    expect(s.hold).toMatch(/BO/);
    expect(s.hold).toMatch(/lock@75%/);
  });

  it('TimeDecay at 15min banks green when retention still high', () => {
    const floor = bestOutcomeMfeFloor(4660, null, GOLD_META)!;
    const mfe = floor + 0.2;
    const cut = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4660,
        mfe,
        peak_retention: 0.95,
        entry_at: new Date(Date.now() - 16 * 60_000).toISOString(),
      }),
      4660 + mfe * 0.9
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/TimeDecay/);
  });
});
