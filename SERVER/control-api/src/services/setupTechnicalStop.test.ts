/**
 * Setup-specific technical stop tests.
 * Far regime invalidation must NEVER become the trade SL.
 */

import { describe, expect, it } from 'vitest';
import {
  computeSetupTechnicalStop,
  isFarRegimeInvalidation,
  MAX_STOP_ATR,
  recentSwingHigh,
  recentSwingLow,
  type PlanBar,
} from './setupTechnicalStop.js';
import { emptyTickMicroMetrics, type TickMicroMetrics } from './tickMicroEngine.js';
import type { EntryKind } from './entryStateMachine.js';

function climbBars(n: number, start: number, step = 0.15): PlanBar[] {
  return Array.from({ length: n }, (_, i) => {
    const o = start + i * step;
    return { open: o, high: o + 0.2, low: o - 0.15, close: o + 0.1 };
  });
}

function microAt(mid: number): TickMicroMetrics {
  const m = emptyTickMicroMetrics();
  m.last_mid = mid;
  m.micro_volatility_5s = 0.00035;
  m.spread = 0.1;
  m.velocity_1s = 0.0002;
  m.direction_persistence = 0.6;
  m.tick_burst = true;
  return m;
}

const KINDS: EntryKind[] = [
  'IGNITION_ENTRY',
  'FIRST_PULLBACK',
  'BREAKOUT_RETEST',
  'RANGE_REJECTION',
  'FAILED_BREAKOUT',
  'CONTINUATION_RELOAD',
];

describe('setupTechnicalStop', () => {
  it('computes near structure SL for every entry kind (BUY)', () => {
    const mid = 4524.5;
    // Tight 10s structure immediately under entry (~1–2 pts)
    const bars = climbBars(16, 4522.5, 0.12);
    bars.push({ open: 4523.8, high: 4524.3, low: 4523.1, close: 4524.0 });
    bars.push({ open: 4524.0, high: 4524.7, low: 4523.6, close: 4524.5 });

    for (const kind of KINDS) {
      const plan = computeSetupTechnicalStop({
        side: 'BUY',
        kind,
        mid,
        bid: mid - 0.05,
        ask: mid + 0.05,
        spread: 0.1,
        bars10s: bars,
        micro: microAt(mid),
        move_start_mid: 4523.2,
        plan_entry: 4524,
        plan_invalidation: 4506.1, // far regime LOW — must not win
        range_high: 4526,
        range_low: 4506.1,
        break_level: 4523.5,
        confirm_level: 4524.0,
        baseLot: 1,
      });
      expect(plan.ok, `${kind} ${plan.reason}`).toBe(true);
      expect(plan.entry_price).toBeCloseTo(mid + 0.05, 5); // ASK
      expect(plan.technical_stop!).toBeLessThan(plan.entry_price!);
      expect(plan.stop_distance!).toBeLessThan(8);
      expect(Math.abs(plan.technical_stop! - 4506.1)).toBeGreaterThan(5);
      expect(plan.sl_source).not.toBe('NONE');
      expect(plan.stop_distance_atr).not.toBeNull();
      expect(plan.position_size).not.toBeNull();
    }
  });

  it('SELL uses BID entry and stop above', () => {
    const mid = 4524.5;
    const bars = climbBars(12, 4526.5, -0.12);
    bars.push({ open: 4525.2, high: 4525.8, low: 4524.6, close: 4524.8 });
    const plan = computeSetupTechnicalStop({
      side: 'SELL',
      kind: 'FIRST_PULLBACK',
      mid,
      bid: mid - 0.05,
      ask: mid + 0.05,
      spread: 0.1,
      bars10s: bars,
      micro: microAt(mid),
      move_start_mid: 4525.4,
      range_high: 4535,
      range_low: 4510,
      baseLot: 1,
    });
    expect(plan.ok, plan.reason).toBe(true);
    expect(plan.entry_price).toBeCloseTo(mid - 0.05, 5);
    expect(plan.technical_stop!).toBeGreaterThan(plan.entry_price!);
  });

  it('far regime invalidation must not become trade SL', () => {
    const mid = 4524.5;
    const bars = climbBars(14, 4522.8, 0.1);
    bars.push({ open: 4523.8, high: 4524.6, low: 4523.2, close: 4524.3 });
    const farInv = 4506.1;
    const atrProxy = 1.2;
    expect(isFarRegimeInvalidation(mid, farInv, atrProxy, MAX_STOP_ATR)).toBe(true);

    const plan = computeSetupTechnicalStop({
      side: 'BUY',
      kind: 'CONTINUATION_RELOAD',
      mid,
      bid: 4524.4,
      ask: 4524.6,
      spread: 0.2,
      bars10s: bars,
      micro: microAt(mid),
      plan_invalidation: farInv,
      range_low: farInv,
      range_high: 4530,
      move_start_mid: 4523.3,
      baseLot: 0.5,
    });
    expect(plan.ok, plan.reason).toBe(true);
    expect(plan.technical_stop).not.toBeNull();
    // Must not equal far regime LOW
    expect(Math.abs(plan.technical_stop! - farInv)).toBeGreaterThan(8);
    expect(plan.stop_distance!).toBeLessThan(Math.abs(mid - farInv) * 0.5);
  });

  it('STOP_TOO_WIDE when only far structure exists — never pull SL closer', () => {
    const mid = 4524.5;
    // Flat bars far below — swing will be far
    const bars: PlanBar[] = Array.from({ length: 12 }, (_, i) => ({
      open: 4505 + i * 0.05,
      high: 4505.4 + i * 0.05,
      low: 4504.5 + i * 0.05,
      close: 4505.2 + i * 0.05,
    }));
    // Jump to entry without local structure near price
    bars.push({ open: 4524, high: 4525, low: 4523.8, close: 4524.5 });

    const plan = computeSetupTechnicalStop({
      side: 'BUY',
      kind: 'FIRST_PULLBACK',
      mid,
      bid: 4524.4,
      ask: 4524.6,
      spread: 0.2,
      bars10s: bars,
      micro: microAt(mid),
      plan_invalidation: 4504.5,
      range_low: 4504.5,
      maxStopAtr: 2.0,
      baseLot: 1,
    });
    expect(plan.ok).toBe(false);
    expect(plan.block).toBe('STOP_TOO_WIDE');
    expect(plan.reason).toMatch(/STOP_TOO_WIDE|NO_TRADE/);
    // Must not invent a tighter stop just to allow trade
    if (plan.technical_stop != null) {
      expect(Math.abs(mid - plan.technical_stop)).toBeGreaterThan(10);
    }
  });

  it('IGNITION prefers move_start_mid origin', () => {
    const mid = 4524.5;
    const bars = climbBars(10, 4522.8, 0.15);
    const plan = computeSetupTechnicalStop({
      side: 'BUY',
      kind: 'IGNITION_ENTRY',
      mid,
      bid: 4524.4,
      ask: 4524.6,
      spread: 0.2,
      bars10s: bars,
      micro: microAt(mid),
      move_start_mid: 4523.4,
      plan_invalidation: 4500,
      baseLot: 1,
    });
    expect(plan.ok, plan.reason).toBe(true);
    expect(['IGNITION_ORIGIN', 'IGNITION_10S_STRUCTURE']).toContain(plan.sl_source);
    expect(plan.technical_stop!).toBeLessThan(4523.5);
    expect(plan.technical_stop!).toBeGreaterThan(4521.5);
  });

  it('recentSwingLow/High find local pivots', () => {
    const bars: PlanBar[] = [
      { open: 10, high: 11, low: 9.5, close: 10.5 },
      { open: 10.5, high: 10.8, low: 9.0, close: 9.2 }, // swing low
      { open: 9.2, high: 10.2, low: 9.1, close: 10 },
      { open: 10, high: 12, low: 9.8, close: 11.5 }, // swing high
      { open: 11.5, high: 11.8, low: 10.5, close: 11 },
    ];
    expect(recentSwingLow(bars)).toBe(9.0);
    expect(recentSwingHigh(bars)).toBe(12);
  });
});
