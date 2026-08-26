import { describe, expect, it } from 'vitest';
import {
  BEST_OUTCOME_LOCK_RETENTION,
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

describe('decideBestOutcomeExit — close only on flip', () => {
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

  it('PeakProtect alone does NOT close (would cause BUY→BUY)', () => {
    expect(BEST_OUTCOME_LOCK_RETENTION).toBe(0.75);
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4640,
        mfe: 4.0,
        peak_retention: 2.5 / 4.0,
      }),
      4642.5,
      { continuationSameSide: true }
    );
    expect(hold.exit).toBe(false);
  });

  it('armed peak → flat does NOT close without flip', () => {
    const hold = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4640, mfe: 2.0, peak_retention: 0 }),
      4640.0
    );
    expect(hold.exit).toBe(false);
  });

  it('exits on opposite entry signal (next ≠ same)', () => {
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4640, mfe: 2.0 }),
      4641.5,
      { oppositeEntrySignal: true, oppositeReason: 'SETUP SELL · early' }
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/OppositeSignal/);
    expect(cut.reason).toMatch(/next ≠ same/);
  });

  it('soft TP / timeDecay path gone — green hold without flip', () => {
    const hold = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 30, peak_retention: 0.9 }),
      4630
    );
    expect(hold.exit).toBe(false);
  });

  it('describe shows HOLD until flip', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 15, peak_retention: 0.9 }),
      4612,
      { continuationReason: 'continuation · TAPE UP' }
    );
    expect(s.hold).toMatch(/HOLD until flip/i);
  });
});
