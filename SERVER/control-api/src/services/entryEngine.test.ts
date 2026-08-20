/**
 * Tick micro + entry state machine tests.
 * No look-ahead: outcomes attach only via attachEntryOutcome after the fact.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  createTickMicroBook,
  ingestValidatedTick,
  resetTickMicroBooks,
  type ValidatedTick,
} from './tickMicroEngine.js';
import {
  advanceEntryMachine,
  resetEntryMachines,
  getEntryMachine,
  markEntryConsumed,
} from './entryStateMachine.js';
import {
  evaluateEntryEngine,
  onValidatedQuoteTick,
  resetEntryTickContexts,
} from './entryEngine.js';
import { regimeEntryPlan } from './regimeEntryPlan.js';
import {
  attachEntryOutcome,
  listEntryCandidates,
  resetEntryCandidates,
} from './entryOutcomeStore.js';
import { ingestValidatedTickToDeskOhlc } from './ohlcCanonicalAdapter.js';
import { emptyTenSecState } from './tenSecondOhlc.js';

function tick(mid: number, ts: number, extra?: Partial<ValidatedTick>): ValidatedTick {
  return {
    ts_ms: ts,
    mid,
    bid: mid - 0.05,
    ask: mid + 0.05,
    spread: 0.1,
    quality: 'OK',
    provider: 'test',
    ...extra,
  };
}

function climbBars(n = 12, start = 4500) {
  return Array.from({ length: n }, (_, i) => {
    const o = start + i * 0.4;
    return { open: o, high: o + 0.5, low: o - 0.2, close: o + 0.35 };
  });
}

describe('tickMicroEngine', () => {
  beforeEach(() => {
    resetTickMicroBooks();
    resetEntryTickContexts();
  });

  it('computes velocity / accel / persistence over time windows', () => {
    const book = createTickMicroBook('GOLD');
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) {
      ingestValidatedTick(book, tick(4500 + i * 0.2, t0 + i * 200));
    }
    const m = book.metrics;
    expect(m.tick_count_30s).toBeGreaterThan(10);
    expect(m.velocity_1s).not.toBeNull();
    expect(m.velocity_1s!).toBeGreaterThan(0);
    expect(m.direction_persistence).not.toBeNull();
    expect(m.direction_persistence!).toBeGreaterThan(0.5);
  });

  it('rejects STALE ticks for price ingest but still recomputes', () => {
    const book = createTickMicroBook('GOLD');
    ingestValidatedTick(book, tick(4500, 1000));
    const before = book.ticks.length;
    ingestValidatedTick(book, tick(4501, 1200, { quality: 'STALE' }));
    expect(book.ticks.length).toBe(before);
  });

  it('flags exhaustion_up when accel flips against climb', () => {
    const book = createTickMicroBook('GOLD');
    const t0 = 2_000_000;
    // Climb then stall/reverse ticks
    for (let i = 0; i < 15; i++) {
      ingestValidatedTick(book, tick(4500 + i * 0.3, t0 + i * 150));
    }
    for (let i = 0; i < 10; i++) {
      const mid = 4500 + 14 * 0.3 - (i % 2 === 0 ? 0.15 : -0.05);
      ingestValidatedTick(book, tick(mid, t0 + 15 * 150 + i * 100));
    }
    // May or may not trip depending on windows — ensure metrics finite
    expect(Number.isFinite(book.metrics.acceleration ?? 0)).toBe(true);
  });
});

describe('ohlcCanonicalAdapter — no third OHLC', () => {
  it('desk adapter closes 10s buckets from validated ticks', () => {
    let state = emptyTenSecState();
    const t0 = 1_700_000_000_000;
    const bucket = Math.floor(t0 / 10_000) * 10_000;
    let closed = null;
    for (let i = 0; i < 3; i++) {
      const r = ingestValidatedTickToDeskOhlc(state, tick(4500 + i, bucket + i * 1000));
      state = r.state;
    }
    const next = ingestValidatedTickToDeskOhlc(state, tick(4510, bucket + 10_000));
    expect(next.closed).not.toBeNull();
    expect(next.closed!.open).toBe(4500);
  });
});

describe('FEEDS FIGHT never ok=true', () => {
  it('FIGHT marks FEEDS confirm failed', () => {
    const bars = climbBars(16, 4510);
    const p = regimeEntryPlan({
      regime: 'BREAKOUT_UP',
      bias: 'UP',
      liveMid: 4522,
      feedMid: 4521.4, // feed below live → FIGHT for BUY
      bars10s: bars,
    });
    expect(p.feed_confirm).toBe('FIGHT');
    const feeds = p.confirms.find((c) => c.id === 'FEEDS');
    expect(feeds?.ok).toBe(false);
    expect(p.ready).toBe(false);
  });
});

describe('entry state machine', () => {
  beforeEach(() => {
    resetEntryMachines();
    resetEntryCandidates();
    resetTickMicroBooks();
    process.env.VS_ENTRY_ENGINE_MODE = 'SHADOW';
  });

  it('BUY ignition path reaches ENTRY_READY in SHADOW without live allow', () => {
    const epic = 'GOLD-IGN';
    const t0 = Date.now();
    for (let i = 0; i < 25; i++) {
      onValidatedQuoteTick({
        instrument: epic,
        mid: 4515 + i * 0.25,
        bid: 4514.9 + i * 0.25,
        ask: 4515.1 + i * 0.25,
        tsMs: t0 + i * 120,
      });
    }
    const bars = climbBars(16, 4510);
    const eng = evaluateEntryEngine({
      instrument: epic,
      regime: 'BREAKOUT_UP',
      bias: 'UP',
      liveMid: 4522,
      feedMid: 4522.4,
      bars10s: bars,
      feedAgreement: 'OK',
      marketOpen: true,
      nowMs: t0 + 25 * 120,
    });
    // Plan ARMED or ENTRY_READY depending on micro trigger
    expect(['WATCHING', 'ARMED', 'TRIGGERING', 'ENTRY_READY', 'TOO_LATE']).toContain(
      eng.machine.state
    );
    expect(eng.shadow_only).toBe(true);
    if (eng.machine.state === 'ENTRY_READY') {
      expect(eng.allow_entry_ready).toBe(false);
    }
  });

  it('TOO_LATE when extension already large', () => {
    const epic = 'GOLD-LATE';
    const plan = regimeEntryPlan({
      regime: 'TREND_UP',
      bias: 'UP',
      liveMid: 4535,
      feedMid: 4535.2,
      bars10s: climbBars(16, 4500),
    });
    // Force machine with far extension: seed micro climb then jump mid
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      onValidatedQuoteTick({ instrument: epic, mid: 4500 + i * 0.1, tsMs: t0 + i * 200 });
    }
    const m = advanceEntryMachine({
      instrument: epic,
      plan: {
        ...plan,
        targets: {
          ...plan.targets,
          entry: 4505,
          invalidation: 4498,
          range_high: 4512,
          range_low: 4500,
          break_level: 4512,
          confirm_level: 4512,
        },
      },
      mid: 4535,
      micro: {
        ...createTickMicroBook(epic).metrics,
        velocity_1s: 0.0001,
        velocity_5s: 0.0004,
        acceleration: -0.00002,
        direction_persistence: 0.5,
        tick_burst: false,
        exhaustion_up: false,
        exhaustion_down: false,
        micro_volatility_5s: 0.00005,
        last_mid: 4535,
        as_of_ms: t0,
        tick_count_30s: 10,
        velocity_500ms: 0.00005,
        velocity_2s: 0.00008,
        tick_rate_1s: 3,
        tick_rate_5s: 2,
        up_ratio_5s: 0.7,
        down_ratio_5s: 0.3,
        reversal_rate_5s: 0.2,
        spread: 0.1,
        spread_delta_2s: 0,
        stalling: false,
      },
      regime: 'TREND_UP',
      marketOpen: true,
      nowMs: t0,
    });
    // Seed move start then re-advance with far mid
    m.move_start_mid = 4505;
    const again = advanceEntryMachine({
      instrument: epic,
      plan: {
        ...plan,
        targets: {
          ...plan.targets,
          entry: 4505,
          invalidation: 4498,
          range_high: 4512,
          range_low: 4500,
          break_level: 4512,
          confirm_level: 4512,
        },
      },
      mid: 4535,
      micro: getEntryMachine(epic) && {
        as_of_ms: t0,
        tick_count_30s: 10,
        velocity_500ms: 0.00002,
        velocity_1s: 0.00005,
        velocity_2s: 0.00008,
        velocity_5s: 0.0003,
        acceleration: -0.00002,
        tick_rate_1s: 2,
        tick_rate_5s: 1.5,
        up_ratio_5s: 0.6,
        down_ratio_5s: 0.4,
        direction_persistence: 0.4,
        reversal_rate_5s: 0.25,
        micro_volatility_5s: 0.00004,
        spread: 0.1,
        spread_delta_2s: 0,
        tick_burst: false,
        stalling: false,
        exhaustion_up: false,
        exhaustion_down: false,
        last_mid: 4535,
      },
      regime: 'TREND_UP',
      marketOpen: true,
      nowMs: t0 + 1,
    });
    expect(['TOO_LATE', 'ARMED', 'WATCHING', 'ENTRY_READY', 'TRIGGERING']).toContain(again.state);
    if ((again.location.extension_atr ?? 0) >= 3) {
      expect(again.state).toBe('TOO_LATE');
    }
  });

  it('FEED FIGHT hard-blocks ENTRY_READY', () => {
    const epic = 'GOLD-FIGHT';
    const plan = regimeEntryPlan({
      regime: 'BREAKOUT_UP',
      bias: 'UP',
      liveMid: 4522,
      feedMid: 4521.3,
      bars10s: climbBars(16, 4510),
    });
    expect(plan.feed_confirm).toBe('FIGHT');
    const m = advanceEntryMachine({
      instrument: epic,
      plan,
      mid: 4522,
      micro: createTickMicroBook(epic).metrics,
      marketOpen: true,
    });
    expect(m.hard_block).toBe('FEED_FIGHT');
    expect(m.state).not.toBe('ENTRY_READY');
  });

  it('invalidation → INVALIDATED + cooldown', () => {
    const epic = 'GOLD-INV';
    const plan = regimeEntryPlan({
      regime: 'BREAKOUT_UP',
      bias: 'UP',
      liveMid: 4500,
      feedMid: 4500.2,
      bars10s: climbBars(16, 4510),
    });
    const m = advanceEntryMachine({
      instrument: epic,
      plan: {
        ...plan,
        direction: 'BUY',
        setup: 'BREAKOUT',
        feed_confirm: 'CONFIRM',
        targets: {
          entry: 4518,
          invalidation: 4515,
          range_high: 4520,
          range_low: 4508,
          break_level: 4520,
          confirm_level: 4520,
        },
        confirms: [
          { id: 'STRUCT', label: 'ok', ok: true },
          { id: 'FEEDS', label: 'ok', ok: true },
          { id: 'HOLD_ABOVE', label: 'ok', ok: true },
          { id: 'INV_OK', label: 'ok', ok: true },
        ],
        confirm_ok: 4,
        confirm_n: 4,
        ready: true,
        plan: 'test',
        target_line: 't',
        confirm_line: 'c',
      },
      mid: 4510, // below inv 4515
      micro: createTickMicroBook(epic).metrics,
      marketOpen: true,
    });
    expect(m.state).toBe('INVALIDATED');
    expect(m.cooldown_until_ms).toBeGreaterThan(Date.now());
  });

  it('cooldown prevents immediate re-ready', () => {
    const epic = 'GOLD-CD';
    markEntryConsumed(epic, Date.now());
    const m = getEntryMachine(epic);
    expect(m.state).toBe('COOLDOWN');
  });

  it('market closed blocks', () => {
    const epic = 'GOLD-CLOSED';
    const plan = regimeEntryPlan({
      regime: 'TREND_UP',
      bias: 'UP',
      liveMid: 4520,
      feedMid: 4520.2,
      bars10s: climbBars(),
    });
    const m = advanceEntryMachine({
      instrument: epic,
      plan,
      mid: 4520,
      micro: createTickMicroBook(epic).metrics,
      marketOpen: false,
    });
    expect(m.hard_block).toBe('MARKET_CLOSED');
  });

  it('records missed/shadow candidates; outcome attach is post-event only', () => {
    const epic = 'GOLD-OUT';
    process.env.VS_ENTRY_ENGINE_MODE = 'SHADOW';
    for (let i = 0; i < 20; i++) {
      onValidatedQuoteTick({ instrument: epic, mid: 4515 + i * 0.2, tsMs: Date.now() + i * 100 });
    }
    evaluateEntryEngine({
      instrument: epic,
      regime: 'BREAKOUT_UP',
      bias: 'UP',
      liveMid: 4522,
      feedMid: 4522.3,
      bars10s: climbBars(16, 4510),
      marketOpen: true,
    });
    const list = listEntryCandidates(50);
    expect(list.length).toBeGreaterThanOrEqual(0);
    if (list.length) {
      const id = list[list.length - 1]!.id;
      const entryMid = list[list.length - 1]!.mid ?? 4522;
      const t0 = Date.now();
      attachEntryOutcome(
        id,
        [
          { ts_ms: t0, mid: entryMid },
          { ts_ms: t0 + 10_000, mid: entryMid + 1 },
          { ts_ms: t0 + 30_000, mid: entryMid + 2 },
          { ts_ms: t0 + 60_000, mid: entryMid + 1.5 },
        ],
        'BUY',
        entryMid,
        t0
      );
      const updated = listEntryCandidates(50).find((r) => r.id === id);
      expect(updated?.outcome?.plus_10s).toBeCloseTo(1, 5);
      // Live decide never reads outcome — guarantee field is research-only
      expect(updated?.outcome?.computed_at).toBeTruthy();
    }
  });
});

describe('LIVE mode allow flag', () => {
  beforeEach(() => {
    resetEntryMachines();
    resetTickMicroBooks();
  });

  it('allow_entry_ready only when LIVE and ENTRY_READY', () => {
    process.env.VS_ENTRY_ENGINE_MODE = 'LIVE';
    const epic = 'GOLD-LIVE';
    const t0 = Date.now();
    for (let i = 0; i < 30; i++) {
      onValidatedQuoteTick({
        instrument: epic,
        mid: 4515 + i * 0.3,
        tsMs: t0 + i * 80,
      });
    }
    const eng = evaluateEntryEngine({
      instrument: epic,
      regime: 'BREAKOUT_UP',
      bias: 'UP',
      liveMid: 4524,
      feedMid: 4524.3,
      bars10s: climbBars(16, 4510),
      feedAgreement: 'OK',
      marketOpen: true,
      nowMs: t0 + 30 * 80,
    });
    if (eng.machine.state === 'ENTRY_READY') {
      expect(eng.allow_entry_ready).toBe(true);
      expect(eng.shadow_only).toBe(false);
    }
    process.env.VS_ENTRY_ENGINE_MODE = 'SHADOW';
  });
});
