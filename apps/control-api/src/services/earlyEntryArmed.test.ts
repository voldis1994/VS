/**
 * Early ENTRY: SETUP → ARMED → TRIGGERED before full 5m BOS/CHoCH.
 */
import { describe, expect, it } from 'vitest';
import {
  advanceEarlyEntryArmed,
  idleArmedState,
  isChasedFromZone,
  locateEarlyZone,
  scoreMicroConfirmation,
  type ArmedTriggerState,
} from './earlyEntryArmed.js';
import { analyzeMarketStructure, type StructureBar } from './marketStructure.js';
import { decideFiveMinuteEntry } from './fiveMinuteBrain.js';
import { decideEntryFrom10sRegime } from './entryFromRegime.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function sb(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number
): StructureBar {
  return { open_time_ms: t, open: o, high: h, low: l, close: c, ticks: 8, provenance: 'REAL' };
}

function ten(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number
): TenSecBar {
  return { open_time_ms: t, open: o, high: h, low: l, close: c, ticks: 8, provenance: 'REAL' };
}

/** Sine-wave uptrend — survives default left=2/right=2 pivots, no BOS. */
function supportUptrendNoBos(n = 30): StructureBar[] {
  const bars: StructureBar[] = [];
  for (let i = 0; i < n; i++) {
    const center = 100 + i * 0.6 + 3 * Math.sin((2 * Math.PI * i) / 10);
    bars.push(sb(i * 300_000, center - 0.1, center + 0.5, center - 0.5, center + 0.1));
  }
  return bars;
}

/** Sine-wave downtrend — no bearish BOS displacement. */
function resistDowntrendNoBos(n = 30): StructureBar[] {
  const bars: StructureBar[] = [];
  for (let i = 0; i < n; i++) {
    const center = 200 - i * 0.6 + 3 * Math.sin((2 * Math.PI * i) / 10);
    bars.push(sb(i * 300_000, center + 0.1, center + 0.5, center - 0.5, center - 0.1));
  }
  return bars;
}

function ltfUp(price: number, n = 12): StructureBar[] {
  const out: StructureBar[] = [];
  let t = 9_000_000;
  for (let i = 0; i < n; i++) {
    const o = price - 0.4 + i * 0.05;
    out.push(sb(t, o, o + 0.12, o - 0.05, o + 0.08));
    t += 60_000;
  }
  return out;
}

function ltfDown(price: number, n = 12): StructureBar[] {
  const out: StructureBar[] = [];
  let t = 9_000_000;
  for (let i = 0; i < n; i++) {
    const o = price + 0.4 - i * 0.05;
    out.push(sb(t, o, o + 0.05, o - 0.12, o - 0.08));
    t += 60_000;
  }
  return out;
}

function microReclaimBuy(support: number): StructureBar[] {
  const out: StructureBar[] = [];
  let t = 10_000_000;
  for (let i = 0; i < 8; i++) {
    const o = support + 0.8 - i * 0.1;
    out.push(sb(t, o, o + 0.06, o - 0.12, o - 0.08));
    t += 10_000;
  }
  out.push(sb(t, support + 0.05, support + 0.2, support - 0.4, support + 0.25));
  t += 10_000;
  out.push(sb(t, support + 0.2, support + 0.55, support + 0.12, support + 0.5));
  return out;
}

function microRejectSell(resist: number): StructureBar[] {
  const out: StructureBar[] = [];
  let t = 10_000_000;
  for (let i = 0; i < 8; i++) {
    const o = resist - 0.8 + i * 0.1;
    out.push(sb(t, o, o + 0.12, o - 0.06, o + 0.08));
    t += 10_000;
  }
  out.push(sb(t, resist - 0.1, resist + 0.45, resist - 0.15, resist - 0.25));
  t += 10_000;
  out.push(sb(t, resist - 0.28, resist - 0.05, resist - 0.55, resist - 0.5));
  return out;
}

describe('early ENTRY armed trigger', () => {

  it('blocks EARLY BUY locate when tape SELL / TREND_DOWN', () => {
    const bars5m = supportUptrendNoBos();
    const support = analyzeMarketStructure(bars5m).last_swing_low!.price;
    const blocked = locateEarlyZone({
      now_ms: Date.now(),
      price: support + 0.1,
      bars5m,
      htf: { trend: 'UP', near_support: true },
      tape_dir: 'SELL',
      regime: 'TREND_DOWN',
      tick_size: 0.01,
      spread: 0.05,
    });
    expect(blocked).toBeNull();
  });


  it('1. valid support + micro reclaim → BUY before 5m BOS', () => {
    const bars5m = supportUptrendNoBos();
    const ms = analyzeMarketStructure(bars5m);
    expect(ms.events.some((e) => e.kind === 'BOS' && e.side === 'BULL')).toBe(false);
    expect(ms.last_swing_low).not.toBeNull();
    const support = ms.last_swing_low!.price;
    const bars10s = microReclaimBuy(support);
    const price = bars10s[bars10s.length - 1]!.close;

    let state: ArmedTriggerState = idleArmedState();
    let signal = null as ReturnType<typeof advanceEarlyEntryArmed>['signal'];
    // Stateful advance across ticks — entry may land on reclaim bar
    for (let i = 6; i < bars10s.length; i++) {
      const slice = bars10s.slice(0, i + 1);
      const r = advanceEarlyEntryArmed(state, {
        now_ms: slice[slice.length - 1]!.open_time_ms,
        price: slice[slice.length - 1]!.close,
        bars5m,
        bars1m: ltfUp(support),
        bars10s: slice,
        htf: { trend: 'UP', near_support: true, detail: 'HTF support' },
        spread: 0.05,
        tick_size: 0.01,
      });
      state = r.state;
      if (r.signal) {
        signal = r.signal;
        break;
      }
    }
    expect(signal).not.toBeNull();
    expect(signal!.direction).toBe('BUY');
    expect(signal!.early).toBe(true);
    expect(state.phase).toBe('TRIGGERED');
    expect(signal!.reason).toMatch(/EARLY|TRIGGERED|reclaim|sweep/i);
  });

  it('2. valid resistance + micro rejection → SELL before 5m BOS', () => {
    const bars5m = resistDowntrendNoBos();
    const ms = analyzeMarketStructure(bars5m);
    expect(ms.events.some((e) => e.kind === 'BOS' && e.side === 'BEAR')).toBe(false);
    expect(ms.last_swing_high).not.toBeNull();
    const resist = ms.last_swing_high!.price;
    const bars10s = microRejectSell(resist);

    let state = idleArmedState();
    let signal = null as ReturnType<typeof advanceEarlyEntryArmed>['signal'];
    for (let i = 6; i < bars10s.length; i++) {
      const slice = bars10s.slice(0, i + 1);
      const r = advanceEarlyEntryArmed(state, {
        now_ms: slice[slice.length - 1]!.open_time_ms,
        price: slice[slice.length - 1]!.close,
        bars5m,
        bars1m: ltfDown(resist),
        bars10s: slice,
        htf: { trend: 'DOWN', near_resistance: true },
        spread: 0.05,
        tick_size: 0.01,
      });
      state = r.state;
      if (r.signal) {
        signal = r.signal;
        break;
      }
    }
    expect(signal).not.toBeNull();
    expect(signal!.direction).toBe('SELL');
    expect(state.phase).toBe('TRIGGERED');
  });

  it('3. zone touch without confirmation → NO ENTRY', () => {
    const bars5m = supportUptrendNoBos();
    const support = analyzeMarketStructure(bars5m).last_swing_low!.price;
    // Quiet touch — tiny wicks, no sweep/reject/reclaim geometry
    const bars10s: StructureBar[] = [];
    let t = 10_000_000;
    for (let i = 0; i < 4; i++) {
      const mid = support + 0.25;
      bars10s.push(sb(t, mid, mid + 0.02, mid - 0.02, mid));
      t += 10_000;
    }
    const r = advanceEarlyEntryArmed(idleArmedState(), {
      now_ms: t,
      price: support + 0.25,
      bars5m,
      bars1m: [],
      bars10s,
      htf: { trend: 'UP', near_support: true },
      spread: 0.05,
      tick_size: 0.01,
    });
    expect(r.state.phase).toBe('ARMED');
    expect(r.state.touched).toBe(true);
    expect(r.signal).toBeNull();
    expect(r.state.micro_score).toBeLessThan(2);
    expect(r.state.confirms).toEqual([]);
  });

  it('4. zone invalidation → ARMED cancelled', () => {
    const bars5m = supportUptrendNoBos();
    const located = locateEarlyZone({
      now_ms: Date.now(),
      price: analyzeMarketStructure(bars5m).last_swing_low!.price + 0.1,
      bars5m,
      htf: { trend: 'UP', near_support: true },
      tick_size: 0.01,
      spread: 0.05,
    });
    expect(located).not.toBeNull();

    const broken = located!.invalidation - 0.05;
    const r = advanceEarlyEntryArmed(
      {
        ...idleArmedState(),
        phase: 'ARMED',
        direction: 'BUY',
        zone_low: located!.low,
        zone_high: located!.high,
        invalidation: located!.invalidation,
        armed_at_ms: Date.now(),
        touched: true,
        detail: 'ARMED',
      },
      {
        now_ms: Date.now(),
        price: broken,
        bars5m,
        bars10s: [sb(Date.now(), broken + 0.1, broken + 0.12, broken - 0.02, broken)],
        htf: { trend: 'UP', near_support: true },
        spread: 0.05,
        tick_size: 0.01,
      }
    );
    expect(r.state.phase).toBe('INVALIDATED');
    expect(r.signal).toBeNull();
  });

  it('5. late/chased trigger → NO ENTRY', () => {
    const bars5m = supportUptrendNoBos();
    const ms = analyzeMarketStructure(bars5m);
    const support = ms.last_swing_low!.price;
    const located = locateEarlyZone({
      now_ms: Date.now(),
      price: support + 0.1,
      bars5m,
      htf: { trend: 'UP', near_support: true },
      spread: 0.05,
      tick_size: 0.01,
    })!;
    const chased = located.high + (located.high - located.low) * 2;
    expect(isChasedFromZone('BUY', chased, located.low, located.high, 0.5)).toBe(true);

    const r = advanceEarlyEntryArmed(
      {
        ...idleArmedState(),
        phase: 'ARMED',
        direction: 'BUY',
        zone_low: located.low,
        zone_high: located.high,
        invalidation: located.invalidation,
        armed_at_ms: Date.now(),
        touched: true,
        micro_score: 5,
        confirms: ['sweep_reclaim', 'micro_shift'],
        detail: 'ARMED',
      },
      {
        now_ms: Date.now(),
        price: chased,
        bars5m,
        bars10s: microReclaimBuy(support),
        htf: { trend: 'UP', near_support: true },
        spread: 0.05,
        tick_size: 0.01,
      }
    );
    expect(r.signal).toBeNull();
    expect(r.state.detail).toMatch(/chased/i);
  });

  it('micro score works with 1m LTF when bars10s empty (10s OHLC OFF)', () => {
    const bars5m = supportUptrendNoBos(24);
    const ms = analyzeMarketStructure(bars5m);
    const low = ms.last_swing_low!.price;
    const high = low + 1.2;
    const bars1m: StructureBar[] = [];
    const t0 = 1_000_000;
    for (let i = 0; i < 8; i++) {
      bars1m.push(sb(t0 + i * 60_000, low + 0.4, low + 0.8, low + 0.2, low + 0.5));
    }
    bars1m.push(sb(t0 + 8 * 60_000, low + 0.2, low + 0.6, low - 0.3, low + 0.4));
    const state: ArmedTriggerState = {
      ...idleArmedState(),
      phase: 'ARMED',
      direction: 'BUY',
      zone_low: low,
      zone_high: high,
      micro_score: 0,
      confirms: [],
    };
    const scored = scoreMicroConfirmation(state, {
      now_ms: Date.now(),
      price: low + 0.4,
      bars5m,
      bars1m,
      bars10s: [],
      htf: { trend: 'UP', near_support: true },
      tape_dir: 'BUY',
      regime: 'TREND_UP',
    });
    expect(scored.detail).not.toMatch(/no 10s/);
    expect(scored.score).toBeGreaterThan(0);
  });

  it('6. full 5m BOS/CHoCH still yields confirmation entry', () => {
    const base = supportUptrendNoBos(30);
    const ms0 = analyzeMarketStructure(base);
    const sh = ms0.last_swing_high!.price;
    const breakout = sb(
      base[base.length - 1]!.open_time_ms + 300_000,
      sh - 0.3,
      sh + 2.5,
      sh - 0.4,
      sh + 2.2
    );
    const bars5m = [...base, breakout];
    const price = breakout.close;
    const d = decideFiveMinuteEntry({
      bars5m,
      bars1m: ltfUp(price),
      bars10s: ltfUp(price),
      regime: 'TREND_UP',
      price,
      spread: 0.05,
      feed_agreement: 0.9,
      htf: { trend: 'UP', near_support: true },
      tick_size: 0.01,
    });
    expect(d.entry).toBe(true);
    expect(d.direction).toBe('BUY');
    expect(d.structure.events.map((e) => e.kind)).toContain('BOS');

    const signalBar = ten(breakout.open_time_ms, breakout.open, breakout.high, breakout.low, breakout.close);
    const closed: TenSecBar[] = bars5m.map((b) =>
      ten(b.open_time_ms, b.open, b.high, b.low, b.close)
    );
    const entry = decideEntryFrom10sRegime(signalBar, 'TREND_UP', closed, {
      multiTfReady: true,
      analysis_price: price,
      bars5m,
      bars1m: ltfUp(price),
      spread: 0.05,
      feed_agreement: 0.9,
      htf: { trend: 'UP', near_support: true },
      tick_size: 0.01,
      broker_min_stop: 0.1,
    });
    expect(entry).not.toBeNull();
    expect(entry!.direction).toBe('BUY');
    expect(entry!.reason).not.toMatch(/^EARLY/);
  });
});
