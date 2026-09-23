import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as structureEntry from './structureEntry.js';
import { softExitMarketGate } from './softExitMarketGate.js';
import type { TenSecBar } from './tenSecondOhlc.js';

const stubBar: TenSecBar = {
  open_time_ms: 1_700_000_000_000,
  open: 2650,
  high: 2652,
  low: 2648,
  close: 2651,
  ticks: 8,
};

describe('softExitMarketGate — next entry + full candle', () => {
  let peek: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    peek = vi.spyOn(structureEntry, 'decideEntryWithStructure');
  });

  afterEach(() => {
    peek.mockRestore();
  });

  it('HOLDs soft exit while closed 1m continues with SELL (decline still on)', () => {
    peek.mockReturnValue(null);
    const g = softExitMarketGate({
      openSide: 'SELL',
      regime: 'TREND_DOWN',
      closed1m: { open: 2650, close: 2646 },
    });
    expect(g.allow).toBe(false);
    expect(g.minute_policy).toBe('continue');
    expect(g.hold_reason).toMatch(/1m continue SELL/);
  });

  it('HOLDs soft exit while closed 1m continues with BUY', () => {
    peek.mockReturnValue(null);
    const g = softExitMarketGate({
      openSide: 'BUY',
      regime: 'TREND_UP',
      closed1m: { open: 2650, close: 2654 },
    });
    expect(g.allow).toBe(false);
    expect(g.minute_policy).toBe('continue');
  });

  it('allows soft exit on reverse 1m when no same-side next entry', () => {
    peek.mockReturnValue(null);
    const g = softExitMarketGate({
      openSide: 'SELL',
      regime: 'TREND_DOWN',
      closedBars: [],
      closed1m: { open: 2640, close: 2645 },
    });
    expect(g.minute_policy).toBe('reverse');
    expect(g.allow).toBe(true);
    expect(g.hold_reason).toBe('');
  });

  it('HOLDs when next entry on full 10s candle is still same side', () => {
    peek.mockReturnValue({
      direction: 'SELL',
      setup: 'PULLBACK',
      reason: 'TREND_DOWN rally-sell',
    });
    const g = softExitMarketGate({
      openSide: 'SELL',
      regime: 'TREND_DOWN',
      closedBars: [stubBar],
      closed1m: { open: 2648, close: 2648 },
    });
    expect(g.allow).toBe(false);
    expect(g.next_entry_side).toBe('SELL');
    expect(g.next_entry_setup).toBe('PULLBACK');
    expect(g.hold_reason).toMatch(/next entry still SELL/);
  });

  it('allows soft exit when next entry flips opposite on full candle', () => {
    peek.mockReturnValue({
      direction: 'BUY',
      setup: 'PULLBACK',
      reason: 'TREND_UP dip-buy',
    });
    const g = softExitMarketGate({
      openSide: 'SELL',
      regime: 'TREND_UP',
      closedBars: [stubBar],
      closed1m: { open: 2645, close: 2645 },
    });
    expect(g.allow).toBe(true);
    expect(g.next_entry_side).toBe('BUY');
  });

  it('HOLDs when 1m wait and no next entry (unclear — do not take tiny slice)', () => {
    peek.mockReturnValue(null);
    const g = softExitMarketGate({
      openSide: 'BUY',
      regime: 'COMPRESSION',
      closedBars: [],
      closed1m: { open: 2650, close: 2650 },
    });
    expect(g.allow).toBe(false);
    expect(g.minute_policy).toBe('wait');
    expect(g.hold_reason).toMatch(/no market change/);
  });

  it('1m continue wins over opposite next-entry peek (full leg first)', () => {
    peek.mockReturnValue({
      direction: 'BUY',
      setup: 'PULLBACK',
      reason: 'opposite',
    });
    const g = softExitMarketGate({
      openSide: 'SELL',
      regime: 'TREND_UP',
      closedBars: [stubBar],
      closed1m: { open: 2650, close: 2640 },
    });
    expect(g.allow).toBe(false);
    expect(g.minute_policy).toBe('continue');
  });
});
