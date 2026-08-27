import { describe, expect, it } from 'vitest';
import {
  buildLiveEntryPlan,
  mapArmedPhaseToUi,
} from './entryPlan.js';
import { idleArmedState } from './earlyEntryArmed.js';
import type { MultiTfState } from './timeframeBooks.js';

describe('entryPlan', () => {
  it('maps armed phases to UI states', () => {
    expect(mapArmedPhaseToUi('IDLE')).toBe('WATCHING');
    expect(mapArmedPhaseToUi('SETUP')).toBe('WATCHING');
    expect(mapArmedPhaseToUi('ARMED')).toBe('ARMED');
    expect(mapArmedPhaseToUi('TRIGGERED')).toBe('TRIGGERED');
    expect(mapArmedPhaseToUi('INVALIDATED')).toBe('INVALIDATED');
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

  it('buildLiveEntryPlan exposes ARMED waiting_for + zones', () => {
    const armed = {
      ...idleArmedState(),
      phase: 'ARMED' as const,
      direction: 'BUY' as const,
      zone_low: 99,
      zone_high: 100,
      invalidation: 98.5,
      micro_score: 1,
      confirms: ['rejection'],
      detail: 'ARMED · support',
    };
    const multiTf = {
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

    const plan = buildLiveEntryPlan({
      price: 99.5,
      armed,
      multiTf,
      closedBars: [],
      running: true,
    });
    expect(plan).not.toBeNull();
    expect(plan!.state).toBe('ARMED');
    expect(plan!.bias).toBe('BUY');
    expect(plan!.entry_zone).toEqual({ low: 99, high: 100 });
    expect(plan!.invalidation).toBe(98.5);
    expect(plan!.waiting_for).toMatch(/micro/i);
    expect(plan!.micro_score).toBeGreaterThanOrEqual(1);
  });
});
