import { describe, expect, it } from 'vitest';
import {
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

describe('decideBestOutcomeExit — hold until opposite', () => {
  it('HardInv 2.0pt Gold', () => {
    const hard = hardInvalidationDistance(4660);
    expect(hard).toBe(2.0);
  });

  it('manageExitPrice uses bid for BUY / ask for SELL (not mid)', () => {
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

  it('short dump/rally thesis only at ~3pt (not at ~2.3pt)', () => {
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

  it('does NOT exit on PeakProtect / flat giveback — holds for opposite', () => {
    const hold = decideBestOutcomeExit(
      snap({
        open_side: 'BUY',
        entry_price: 4640,
        mfe: 3.5,
        peak_retention: 0.2,
      }),
      4640.5,
      { continuationSameSide: true }
    );
    expect(hold.exit).toBe(false);
  });

  it('exits on opposite entry signal', () => {
    const cut = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4640, mfe: 1.0 }),
      4641.0,
      { oppositeEntrySignal: true, oppositeReason: 'TAPE DOWN · 1m=-1.0 5m=-2.0' }
    );
    expect(cut.exit).toBe(true);
    expect(cut.reason).toMatch(/OppositeSignal/);
    expect(cut.reason).toMatch(/TAPE DOWN/);
  });

  it('holds green without opposite signal', () => {
    const hold = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4640, mfe: 5 }),
      4645
    );
    expect(hold.exit).toBe(false);
  });

  it('continuation does not skip HardInvalidation', () => {
    const d = decideBestOutcomeExit(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 10, peak_retention: 0.9 }),
      4580,
      { continuationSameSide: true }
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/HardInvalidation/);
  });

  it('describe shows HOLD until opposite', () => {
    const s = describeBestOutcomeState(
      snap({ open_side: 'BUY', entry_price: 4600, mfe: 15, peak_retention: 0.9 }),
      4612,
      { continuationReason: 'continuation · TAPE UP' }
    );
    expect(s.hold).toMatch(/BO10s/);
    expect(s.hold).toMatch(/HOLD until opposite/i);
  });
});
