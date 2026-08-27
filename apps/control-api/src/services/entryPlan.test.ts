import { describe, expect, it } from 'vitest';
import {
  buildLiveEntryPlan,
  classifyPriceVsZone,
  mapArmedPhaseToUi,
} from './entryPlan.js';
import { idleArmedState } from './earlyEntryArmed.js';
import type { MultiTfState } from './timeframeBooks.js';

const emptyTf = {
  ready: false,
  detail: 'seed',
  seeded_at_ms: null,
  seed_next_allowed_ms: 0,
  books: {
    '4H': { ready: false, bars: [], atr: null, detail: '' },
    '1H': { ready: false, bars: [], atr: null, detail: '' },
    '15m': { ready: false, bars: [], atr: null, detail: '' },
    '5m': { ready: false, bars: [], atr: null, detail: '' },
    '1m': { ready: false, bars: [], atr: null, detail: '' },
  },
} as unknown as MultiTfState;

describe('entryPlan', () => {
  it('maps armed phases to UI states', () => {
    expect(mapArmedPhaseToUi('IDLE')).toBe('WATCHING');
    expect(mapArmedPhaseToUi('SETUP')).toBe('WATCHING');
    expect(mapArmedPhaseToUi('ARMED')).toBe('ARMED');
    expect(mapArmedPhaseToUi('TRIGGERED')).toBe('TRIGGERED');
    expect(mapArmedPhaseToUi('INVALIDATED')).toBe('INVALIDATED');
  });

  it('classifyPriceVsZone ABOVE/IN/BELOW', () => {
    expect(classifyPriceVsZone(4612.82, 4608.39, 4612.08)).toBe('ABOVE');
    expect(classifyPriceVsZone(4610, 4608.39, 4612.08)).toBe('IN');
    expect(classifyPriceVsZone(4607, 4608.39, 4612.08)).toBe('BELOW');
  });

  it('buildLiveEntryPlan returns null when in trade', () => {
    expect(
      buildLiveEntryPlan({
        price: 100,
        armed: idleArmedState(),
        open_side: 'BUY',
        running: true,
      })
    ).toBeNull();
  });

  it('price ABOVE zone → PRICE_ABOVE_ZONE, not implied fill', () => {
    const armed = {
      ...idleArmedState(),
      phase: 'SETUP' as const,
      direction: 'BUY' as const,
      zone_low: 4608.39,
      zone_high: 4612.08,
      invalidation: 4607.59,
      detail: 'SETUP',
    };
    const plan = buildLiveEntryPlan({
      price: 4612.82,
      armed,
      multiTf: emptyTf,
      closedBars: [],
      running: true,
    });
    expect(plan).not.toBeNull();
    expect(plan!.price_vs_zone).toBe('ABOVE');
    expect(plan!.block_reason).toBe('PRICE_ABOVE_ZONE');
    expect(plan!.waiting_for).toMatch(/ABOVE zone/i);
    expect(plan!.waiting_for).toMatch(/band ≠ fill|band ≠ fill|≠ fill/i);
  });

  it('ARMED with micro 0 → NEED_MICRO explicit 0/2', () => {
    const armed = {
      ...idleArmedState(),
      phase: 'ARMED' as const,
      direction: 'BUY' as const,
      zone_low: 99,
      zone_high: 100,
      invalidation: 98.5,
      micro_score: 0,
      confirms: [],
      detail: 'ARMED · support',
    };
    const plan = buildLiveEntryPlan({
      price: 99.5,
      armed,
      multiTf: emptyTf,
      closedBars: [],
      running: true,
    });
    expect(plan).not.toBeNull();
    expect(plan!.state).toBe('ARMED');
    expect(plan!.block_reason).toBe('NEED_MICRO');
    expect(plan!.waiting_for).toMatch(/0\/2/);
    expect(plan!.waiting_for).toMatch(/zone touch ≠ ENTRY/i);
  });
});
