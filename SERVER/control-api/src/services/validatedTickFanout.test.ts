/**
 * Event-driven TickMicro path: FeedManager LIVE accept → fan-out → micro + OHLC + Entry SM.
 * Proves many ticks between desk cycles advance micro/SM without broker orders.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FeedManager } from '../vs-core/feedManager.js';
import {
  attachValidatedTickFanout,
  getEpicTickBook,
  resetEpicTickBooks,
} from './validatedTickFanout.js';
import {
  getTickMicroBook,
  resetTickMicroBooks,
  estimateMoveStartMid,
} from './tickMicroEngine.js';
import { injectPumpQuote, resetCapitalQuotePumps } from './capitalQuotePump.js';
import {
  advanceEntryMachine,
  getEntryMachine,
  resetEntryMachines,
} from './entryStateMachine.js';
import { regimeEntryPlan } from './regimeEntryPlan.js';
import {
  evaluateEntryEngine,
  resetEntryTickContexts,
} from './entryEngine.js';

describe('validated tick fan-out (event-driven)', () => {
  const prevMode = process.env.VS_ENTRY_ENGINE_MODE;

  beforeEach(() => {
    resetTickMicroBooks();
    resetEpicTickBooks();
    resetCapitalQuotePumps();
    resetEntryMachines();
    resetEntryTickContexts();
    process.env.VS_ENTRY_ENGINE_MODE = 'SHADOW';
  });

  afterEach(() => {
    if (prevMode == null) delete process.env.VS_ENTRY_ENGINE_MODE;
    else process.env.VS_ENTRY_ENGINE_MODE = prevMode;
  });

  it('FeedManager LIVE ingest fans out to TickMicro + OHLC without robotDesk', () => {
    const fm = new FeedManager();
    fm.defineSource('capital', 'PRIMARY');
    attachValidatedTickFanout(fm);

    const t0 = 5_000_000;
    // 20 ticks in 800ms — denser than any 2s desk cycle
    for (let i = 0; i < 20; i++) {
      injectPumpQuote(fm, 'GOLD', 4510 + i * 0.05, 4510.1 + i * 0.05, t0 + i * 40);
    }

    const micro = getTickMicroBook('GOLD');
    expect(micro.ticks.length).toBe(20);
    expect(micro.metrics.tick_count_30s).toBe(20);
    expect(micro.metrics.tick_rate_1s).toBeGreaterThanOrEqual(15);
    expect(micro.metrics.velocity_500ms).not.toBeNull();
    expect(micro.metrics.velocity_1s).not.toBeNull();
    expect(micro.metrics.direction_persistence).not.toBeNull();

    const book = getEpicTickBook('GOLD');
    expect(book?.accepted_count).toBe(20);
    expect(book?.ohlcState.forming?.ticks).toBeGreaterThanOrEqual(1);
  });

  it('onAccepted callback exception increments fan-out errors and marks TickMicro DEGRADED', () => {
    const fm = new FeedManager();
    fm.defineSource('capital', 'PRIMARY');
    attachValidatedTickFanout(fm);
    // Extra listener that throws — must not be silent
    fm.onAccepted(() => {
      throw new Error('fanout boom');
    });

    injectPumpQuote(fm, 'GOLD-ERR', 4500, 4500.1, 6_000_000);

    expect(fm.fanout_error_count).toBeGreaterThanOrEqual(1);
    expect(fm.last_fanout_error).toMatch(/fanout boom/);
    const micro = getTickMicroBook('GOLD-ERR').metrics;
    expect(micro.quality).toBe('DEGRADED');
    expect(micro.fanout_error_count).toBeGreaterThanOrEqual(1);
    expect(micro.last_fanout_error).toMatch(/fanout boom/);
  });

  it('many accepted ticks between two desk cycles advance TickMicro + Entry SM, never broker orders', () => {
    const fm = new FeedManager();
    fm.defineSource('capital', 'PRIMARY');
    attachValidatedTickFanout(fm);

    const epic = 'GOLD-INTER';
    const t0 = 7_000_000;
    const bars10s = Array.from({ length: 12 }, (_, i) => {
      const o = 4505 + i * 0.4;
      return { open: o, high: o + 0.5, low: o - 0.2, close: o + 0.35 };
    });

    // Static guard: per-tick path must not contain broker order calls
    const here = dirname(fileURLToPath(import.meta.url));
    const fanoutSrc = readFileSync(join(here, 'validatedTickFanout.ts'), 'utf8');
    const engSrc = readFileSync(join(here, 'entryEngine.ts'), 'utf8');
    for (const src of [fanoutSrc, engSrc]) {
      expect(src).not.toMatch(/openCapital|placeOrder|enterTrade|createPosition|submitOrder/i);
    }

    // ——— Desk cycle 1: publish context only (no execution) ———
    const desk1 = evaluateEntryEngine({
      instrument: epic,
      regime: 'BREAKOUT_UP',
      bias: 'UP',
      liveMid: 4508,
      feedMid: 4508.1,
      bars10s,
      feedAgreement: 'AGREE',
      marketOpen: true,
      nowMs: t0,
    });
    const stateAfterDesk1 = desk1.machine.state;
    const phaseAfterDesk1 = desk1.machine.phase;
    expect(desk1.shadow_only).toBe(true);
    expect(desk1.allow_entry_ready).toBe(false);

    // ——— Many accepted ticks WITHOUT a desk cycle (~2s gap) ———
    for (let i = 0; i < 30; i++) {
      injectPumpQuote(fm, epic, 4508 + i * 0.15, 4508.1 + i * 0.15, t0 + 100 + i * 40);
    }

    const micro = getTickMicroBook(epic);
    expect(micro.ticks.length).toBe(30);
    expect(micro.metrics.tick_rate_1s).toBeGreaterThanOrEqual(10);

    const book = getEpicTickBook(epic)!;
    expect(book.accepted_count).toBe(30);
    expect(book.sm_advance_count).toBe(30);

    const mid = getEntryMachine(epic);
    expect(mid.updated_at_ms).toBeGreaterThanOrEqual(t0 + 100);
    expect(
      mid.state !== stateAfterDesk1 ||
        mid.phase !== phaseAfterDesk1 ||
        book.last_sm_state != null
    ).toBe(true);
    expect(book.last_sm_state).not.toBeNull();
    expect(book.last_sm_phase).not.toBeNull();

    // ——— Desk cycle 2 ———
    const snap = evaluateEntryEngine({
      instrument: epic,
      regime: 'BREAKOUT_UP',
      bias: 'UP',
      liveMid: micro.metrics.last_mid,
      feedMid: micro.metrics.last_mid,
      bars10s,
      feedAgreement: 'AGREE',
      marketOpen: true,
      nowMs: t0 + 100 + 29 * 40,
    });
    expect(snap.shadow_only).toBe(true);
    expect(snap.allow_entry_ready).toBe(false);
    expect(snap.micro.tick_count_30s).toBe(30);
  });

  it('STALE / ERROR quotes do not enter TickMicro log', () => {
    const fm = new FeedManager(50); // very short stale window
    fm.defineSource('capital', 'PRIMARY');
    attachValidatedTickFanout(fm);

    const now = Date.now();
    fm.ingest({
      source: 'capital',
      epic: 'GOLD',
      bid: 4500,
      ask: 4500.1,
      source_timestamp: new Date(now - 10_000).toISOString(),
      now,
    });
    expect(getTickMicroBook('GOLD').ticks.length).toBe(0);

    fm.ingest({
      source: 'capital',
      epic: 'GOLD',
      bid: null,
      ask: null,
      force_status: 'ERROR',
      now,
    });
    expect(getTickMicroBook('GOLD').ticks.length).toBe(0);
  });

  it('velocity_500ms / 1s / tick_burst / persistence use ALL ticks in the window', () => {
    const fm = new FeedManager();
    fm.defineSource('capital', 'PRIMARY');
    attachValidatedTickFanout(fm);
    const t0 = 9_000_000;
    // Burst: 12 ticks in 400ms climbing
    for (let i = 0; i < 12; i++) {
      injectPumpQuote(fm, 'XAU', 2000 + i * 0.4, 2000.05 + i * 0.4, t0 + i * 30);
    }
    // Quiet pad to fill 1s window
    for (let i = 0; i < 5; i++) {
      injectPumpQuote(fm, 'XAU', 2004.8 + i * 0.02, 2004.85 + i * 0.02, t0 + 400 + i * 100);
    }

    const m = getTickMicroBook('XAU').metrics;
    expect(m.tick_rate_1s).toBe(17);
    expect(m.velocity_1s!).toBeGreaterThan(0);
    expect(m.velocity_500ms!).toBeGreaterThan(0);
    expect(m.direction_persistence!).toBeGreaterThan(0.5);
    expect(m.tick_burst).toBe(true);
    expect(typeof m.reversal_rate_5s).toBe('number');
  });

  it('estimateMoveStartMid is earlier than late IGNITION price (not current mid)', () => {
    const fm = new FeedManager();
    fm.defineSource('capital', 'PRIMARY');
    attachValidatedTickFanout(fm);
    const t0 = 11_000_000;
    // Dip then climb — origin should be near the dip, not the last print
    injectPumpQuote(fm, 'GOLD', 4510, 4510.1, t0);
    injectPumpQuote(fm, 'GOLD', 4508, 4508.1, t0 + 200);
    injectPumpQuote(fm, 'GOLD', 4507.5, 4507.6, t0 + 400);
    for (let i = 0; i < 15; i++) {
      injectPumpQuote(
        fm,
        'GOLD',
        4507.5 + i * 0.3,
        4507.6 + i * 0.3,
        t0 + 500 + i * 80
      );
    }
    const book = getTickMicroBook('GOLD');
    const last = book.metrics.last_mid!;
    const origin = estimateMoveStartMid(book, 'BUY', t0 + 500 + 14 * 80)!;
    expect(origin).toBeLessThan(last - 1);
    expect(origin).toBeLessThanOrEqual(4508.5);
  });

  it('TOO_LATE uses move_start from setup/tick origin, not IGNITION stamp mid', () => {
    const fm = new FeedManager();
    fm.defineSource('capital', 'PRIMARY');
    attachValidatedTickFanout(fm);
    const t0 = Date.now();
    // Build micro climb from 4505
    for (let i = 0; i < 25; i++) {
      injectPumpQuote(fm, 'GOLD-MS', 4505 + i * 0.25, 4505.1 + i * 0.25, t0 + i * 50);
    }
    const plan = regimeEntryPlan({
      regime: 'BREAKOUT_UP',
      bias: 'UP',
      liveMid: 4520,
      feedMid: 4520.2,
      bars10s: Array.from({ length: 12 }, (_, i) => {
        const o = 4505 + i * 0.4;
        return { open: o, high: o + 0.5, low: o - 0.2, close: o + 0.35 };
      }),
    });
    const micro = getTickMicroBook('GOLD-MS').metrics;
    const m = advanceEntryMachine({
      instrument: 'GOLD-MS',
      plan: {
        ...plan,
        direction: 'BUY',
        setup: 'BREAKOUT',
        feed_confirm: 'CONFIRM',
        targets: {
          entry: 4508,
          invalidation: 4503,
          range_high: 4512,
          range_low: 4504,
          break_level: 4512,
          confirm_level: 4512,
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
      mid: 4520,
      micro,
      marketOpen: true,
      nowMs: t0 + 25 * 50,
    });
    expect(m.move_start_mid).not.toBeNull();
    // Must not equal the late mid when origin was available
    expect(m.move_start_mid!).toBeLessThan(4518);
    expect(m.location.extension_atr).not.toBeNull();
    if ((m.location.extension_atr ?? 0) >= 3) {
      expect(m.state).toBe('TOO_LATE');
    }
  });
});
