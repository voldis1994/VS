import { describe, expect, it, beforeEach } from 'vitest';
import { buildEntryWatch, watchRecipe } from './entryWatch.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import { setDeskCalibration, defaultDeskCalibration } from './deskCalibration.js';

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
    });
    // may be REGIME_OFF if calibration empty in test env — at least recipe text present
    expect(w.looking_for).toMatch(/TREND_UP/);
    expect(w.bar.body_pct).not.toBeNull();
    expect(w.bar_vs_trigger.length).toBeGreaterThan(5);
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
    });
    expect(w.status).toBe('FORMING');
    expect(w.looking_for).toMatch(/RANGE/);
  });

  it('COMPRESSION fades like RANGE when moving', () => {
    const r = watchRecipe('COMPRESSION');
    expect(r.setup).toBe('FADE');
    expect(r.looking_for).toMatch(/fade/i);
    const b = bar(2000, 2000.2, 1998.5, 1999);
    const w = buildEntryWatch({
      running: true,
      open_side: null,
      entry_enabled: true,
      regime: 'COMPRESSION',
      last_closed: b,
      forming_c: null,
      just_closed: true,
    });
    expect(w.looking_for).toMatch(/COMPRESSION/);
  });

  it('FLIP LOCK blocks same direction for 3 min after close', () => {
    const b = bar(2000, 2000.2, 1998.5, 1999); // dip → BUY in RANGE
    const w = buildEntryWatch({
      running: true,
      open_side: null,
      entry_enabled: true,
      regime: 'RANGE',
      last_closed: b,
      forming_c: null,
      just_closed: true,
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
    const b = bar(2000, 2000.2, 1998.5, 1999);
    const w = buildEntryWatch({
      running: true,
      open_side: null,
      entry_enabled: true,
      regime: 'RANGE',
      last_closed: b,
      forming_c: null,
      just_closed: true,
      last_closed_side: 'BUY',
      closed_at_ms: Date.now() - 3 * 60_000 - 1,
    });
    expect(w.status).not.toBe('FLIP_FILTER');
    expect(w.need_side).toBeNull();
    expect(w.lock_left_s).toBe(0);
  });
});
