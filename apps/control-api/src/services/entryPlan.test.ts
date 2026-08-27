import { describe, expect, it } from 'vitest';
import {
  buildLiveEntryPlan,
  formatArmedTriggerDiag,
  holdTriggeredForDecidePath,
  mapArmedPhaseToUi,
} from './entryPlan.js';
import { advanceEarlyEntryArmed, idleArmedState } from './earlyEntryArmed.js';
import type { MultiTfState } from './timeframeBooks.js';
import type { StructureBar } from './marketStructure.js';

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

  it('formatArmedTriggerDiag exposes NEED_MICRO when score < 2', () => {
    const line = formatArmedTriggerDiag(
      {
        ...idleArmedState(),
        phase: 'ARMED',
        direction: 'BUY',
        zone_low: 4608.39,
        zone_high: 4612.08,
        invalidation: 4607.59,
        micro_score: 0,
        confirms: [],
        detail: 'ARMED',
      },
      4612.27
    );
    expect(line).toMatch(/ARMED_DIAG/);
    expect(line).toMatch(/NEED_MICRO 0\/2/);
  });

  it('holdTriggeredForDecidePath demotes TRIGGERED (UI refresh must not consume fire)', () => {
    const triggered = {
      ...idleArmedState(),
      phase: 'TRIGGERED' as const,
      direction: 'BUY' as const,
      zone_low: 100,
      zone_high: 101,
      invalidation: 99.5,
      micro_score: 2,
      confirms: ['rejection', 'reclaim'],
      last_bar_ms: 50_000,
      detail: 'TRIGGERED · BUY',
    };
    const held = holdTriggeredForDecidePath(triggered, {
      direction: 'BUY',
    });
    expect(held.phase).toBe('ARMED');
    expect(held.micro_score).toBe(2);

    // Raw TRIGGERED prev → advance resets to SETUP and drops the fire (the live bug).
    const bars: StructureBar[] = [];
    for (let i = 0; i < 12; i++) {
      const o = 100 + i * 0.2;
      bars.push({
        open_time_ms: i * 300_000,
        open: o,
        high: o + 0.3,
        low: o - 0.3,
        close: o + 0.1,
        ticks: 8,
        provenance: 'REAL',
      });
    }
    const lost = advanceEarlyEntryArmed(triggered, {
      now_ms: Date.now(),
      price: 100.5,
      bars5m: bars,
      bars1m: bars,
      bars10s: bars.map((b, i) => ({ ...b, open_time_ms: 10_000_000 + i * 10_000 })),
      htf: { trend: 'UP', near_support: true },
    });
    expect(lost.signal).toBeNull();
    expect(lost.state.phase).not.toBe('TRIGGERED');
  });
});
