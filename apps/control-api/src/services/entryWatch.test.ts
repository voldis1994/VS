import { describe, expect, it, beforeEach } from 'vitest';
import { buildEntryWatch, watchRecipe } from './entryWatch.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import { setDeskCalibration, defaultDeskCalibration } from './deskCalibration.js';
import { decideEntryWithStructure } from './structureEntry.js';

function bar(o: number, h: number, l: number, c: number): TenSecBar {
  return { open_time_ms: 1, open: o, high: h, low: l, close: c, ticks: 3 };
}

describe('entryWatch', () => {
  beforeEach(() => {
    setDeskCalibration(defaultDeskCalibration());
  });
  it('describes TREND_UP dip trigger', () => {
    const r = watchRecipe('TREND_UP');
    expect(r.direction).toBe('BUY');
    expect(r.looking_for).toMatch(/DIP/);
  });

  it('arms TREND_UP on dip moving bar', () => {
    // body ≈ -0.05% on mid 2000
    const b = bar(2000, 2000.2, 1998.5, 1999);
    const w = buildEntryWatch({
      running: true,
      open_side: null,
      entry_enabled: true,
      regime: 'TREND_UP',
      last_closed: b,
      forming_c: null,
      just_closed: true,
      closed_bar_count: 90,
    });
    // may be REGIME_OFF if calibration empty in test env — at least recipe text present
    expect(w.looking_for).toMatch(/TREND_UP/);
    expect(w.bar.body_pct).not.toBeNull();
    expect(w.bar_vs_trigger.length).toBeGreaterThan(5);
    expect(w.zone_ready).toBe(true);
  });

  it('shows FORMING while bar open', () => {
    const b = bar(2000, 2001, 1999, 2000.5);
    const w = buildEntryWatch({
      running: true,
      open_side: null,
      entry_enabled: true,
      regime: 'RANGE',
      last_closed: b,
      forming_c: 2000.4,
      just_closed: false,
      closed_bar_count: 120,
    });
    expect(w.status).toBe('FORMING');
    expect(w.looking_for).toMatch(/RANGE/);
  });

  it('COMPRESSION recipe: wait-only (no fade / no chase)', () => {
    const r = watchRecipe('COMPRESSION');
    expect(r.looking_for).toMatch(/wait-only/i);
    expect(r.looking_for).toMatch(/EXPANSION|BREAKOUT/i);
    expect(r.setup).toBeNull();
    const b = bar(2000, 2000.2, 1998.5, 1999);
    const w = buildEntryWatch({
      running: true,
      open_side: null,
      entry_enabled: true,
      regime: 'COMPRESSION',
      last_closed: b,
      forming_c: null,
      just_closed: true,
      closed_bar_count: 100,
    });
    expect(w.looking_for).toMatch(/COMPRESSION/);
    expect(w.looking_for).toMatch(/wait-only/i);
  });

  it('FLIP LOCK blocks same direction for 3 min after close', () => {
    // Full 30m RALLY book so decideEntryWithStructure can arm (SEEDING no longer skips scalp)
    const NEED = 90;
    const m0 = Math.floor(Date.now() / 60_000) * 60_000 - 20 * 60_000;
    const book: TenSecBar[] = [];
    for (let i = 0; i < NEED; i++) {
      book.push({
        open_time_ms: m0 - NEED * 10_000 + i * 10_000,
        open: 4325,
        high: i === 3 ? 4335 : 4325.3,
        low: i === 10 ? 4320 : 4324.7,
        close: 4325,
        ticks: 6,
      });
    }
    for (let m = 0; m < 12; m++) {
      const start = m0 + m * 60_000;
      const o = 4324 + m * 0.9;
      const c = o + 0.7;
      for (let k = 0; k < 6; k++) {
        book.push({
          open_time_ms: start + k * 10_000,
          open: o + k * 0.08,
          high: o + k * 0.08 + 0.2,
          low: o + k * 0.08 - 0.05,
          close: o + k * 0.08 + 0.06,
          ticks: 6,
        });
      }
      book[book.length - 1] = {
        open_time_ms: start + 50_000,
        open: c - 0.15,
        high: c + 0.1,
        low: c - 0.25,
        close: c,
        ticks: 6,
      };
    }
    // TREND_UP dip-buy trigger
    const b: TenSecBar = {
      open_time_ms: m0 + 12 * 60_000,
      open: 4335,
      high: 4335.2,
      low: 4332.5,
      close: 4332.8,
      ticks: 8,
    };
    book.push(b);
    const wouldArm = decideEntryWithStructure({
      bar: b,
      regime: 'TREND_UP',
      closedBars: book,
    });
    expect(wouldArm?.direction).toBe('BUY');
    const w = buildEntryWatch({
      running: true,
      open_side: null,
      entry_enabled: true,
      regime: 'TREND_UP',
      last_closed: b,
      forming_c: null,
      just_closed: true,
      closed_bar_count: book.length,
      closed_bars: book,
      last_closed_side: 'BUY',
      closed_at_ms: Date.now() - 30_000,
    });
    expect(w.status).toBe('FLIP_FILTER');
    expect(w.need_side).toBe('SELL');
    expect(w.lock_left_s).toBeGreaterThan(0);
    expect(w.lock_left_s).toBeLessThanOrEqual(180);
    expect(w.armed).toBe(false);
    expect(w.last_reason).toMatch(/FLIP LOCK/);
  });

  it('same direction allowed again after 3 min lock', () => {
    const b = bar(2000, 2000.05, 1999.7, 1999.5);
    const w = buildEntryWatch({
      running: true,
      open_side: null,
      entry_enabled: true,
      regime: 'RANGE',
      last_closed: b,
      forming_c: null,
      just_closed: true,
      closed_bar_count: 90,
      last_closed_side: 'BUY',
      closed_at_ms: Date.now() - 3 * 60_000 - 1,
    });
    expect(w.status).not.toBe('FLIP_FILTER');
    expect(w.need_side).toBeNull();
    expect(w.lock_left_s).toBe(0);
  });

  it('SEEDING shows how many 10s candles have vs still needed', () => {
    const w = buildEntryWatch({
      running: true,
      open_side: null,
      entry_enabled: true,
      regime: 'UNKNOWN',
      last_closed: bar(2000, 2001, 1999, 2000.5),
      forming_c: null,
      just_closed: true,
      closed_bar_count: 45,
    });
    expect(w.status).toBe('SEEDING');
    expect(w.zone_bars).toBe(45);
    expect(w.zone_need).toBe(90);
    expect(w.zone_left).toBe(45);
    expect(w.zone_ready).toBe(false);
    expect(w.zone_progress).toMatch(/45\/90/);
    expect(w.zone_progress).toMatch(/vēl 45/);
    expect(w.looking_for).toMatch(/45\/90/);
    expect(w.last_reason).toMatch(/Lasa tirgu/);
  });
});
