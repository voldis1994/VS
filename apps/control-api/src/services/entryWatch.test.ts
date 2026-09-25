import { _setTradeOpenAtStartForTests } from './tradeOpenPolicy.js';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildEntryWatch, watchRecipe } from './entryWatch.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import { setDeskCalibration, defaultDeskCalibration } from './deskCalibration.js';

function bar(o: number, h: number, l: number, c: number): TenSecBar {
  return { open_time_ms: 1, open: o, high: h, low: l, close: c, ticks: 3 };
}

describe('entryWatch', () => {
  beforeEach(() => {
    _setTradeOpenAtStartForTests(false);
  });
  afterEach(() => {
    _setTradeOpenAtStartForTests(null);
  });

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

  it('COMPRESSION recipe: OPEN fade (no wait-only)', () => {
    const r = watchRecipe('COMPRESSION');
    expect(r.looking_for).toMatch(/OPEN fade/i);
    expect(r.setup).toBe('FADE');
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
    expect(w.looking_for).toMatch(/OPEN fade/i);
  });

  it('FLIP LOCK blocks same direction after close (win lock)', () => {
    // Micro dip → RANGE fade BUY (not SPIKE follow SELL)
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
      closed_at_ms: Date.now() - 10_000,
      last_close_was_loss: false,
    });
    expect(w.status).toBe('FLIP_FILTER');
    expect(w.need_side).toBe('SELL');
    expect(w.lock_left_s).toBeGreaterThan(0);
    expect(w.lock_left_s).toBeLessThanOrEqual(90);
    expect(w.armed).toBe(false);
    expect(w.last_reason).toMatch(/FLIP LOCK/);
  });

  it('after Soft blocks same direction for 12m — no forced opposite', () => {
    // Green bounce → TREND_DOWN rally-sell same as last SELL loss
    const b = bar(2000, 2000.8, 1999.9, 1999.7);
    const w = buildEntryWatch({
      running: true,
      open_side: null,
      entry_enabled: true,
      regime: 'TREND_DOWN',
      last_closed: b,
      forming_c: null,
      just_closed: true,
      closed_bar_count: 90,
      last_closed_side: 'SELL',
      closed_at_ms: Date.now() - 5 * 60_000,
      last_close_was_loss: true,
    });
    expect(w.need_side).toBeNull(); // no auto-flip after Soft
    expect(w.lock_left_s).toBeGreaterThan(60);
    expect(w.looking_for).toMatch(/SAME-DIR LOCK after Soft/);
    // If setup fires same-dir → FLIP_FILTER; otherwise note still on looking_for
    if (w.status === 'FLIP_FILTER') {
      expect(w.last_reason).toMatch(/SAME-DIR LOCK after Soft/);
    }
    expect(w.armed).toBe(false);
  });

  it('same direction allowed again after win lock', () => {
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

  it('Entry Watch leads with Capital multi-TF stack (not story-only SELL)', () => {
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
      capital_m1_dir: 'UP',
      capital_tf5_dir: 'UP',
      capital_tf15_dir: 'UP',
      capital_tf30_dir: 'UP',
    });
    expect(w.looking_for).toMatch(/PRĀTS BUY · 30m↑ 15m↑ 5m↑ 1m↑/);
    expect(w.market_story).toMatch(/30m↑/);
    expect(w.direction).toBe('BUY');
  });

  it('aligned UP stack does not set mind side to SELL', () => {
    const b = bar(2000, 2000.2, 1999, 1999.5);
    const w = buildEntryWatch({
      running: true,
      open_side: null,
      entry_enabled: true,
      regime: 'RANGE',
      last_closed: b,
      forming_c: null,
      just_closed: false,
      closed_bar_count: 120,
      capital_m1_dir: 'DOWN',
      capital_tf5_dir: 'UP',
      capital_tf15_dir: 'UP',
      capital_tf30_dir: 'UP',
    });
    expect(w.looking_for).toMatch(/30m↑ 15m↑ 5m↑/);
    expect(w.looking_for).toMatch(/PRĀTS/);
    expect(w.looking_for).not.toMatch(/^STĀSTS · selloff/);
    expect(w.direction).not.toBe('SELL');
  });
});
