import { describe, expect, it } from 'vitest';
import {
  buildMarketContext,
  compactMarketContext,
  pressureFightsSide,
  storyFightsSide,
} from './marketContext.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import { proposeAutoCalibration } from './autoCalibrate.js';
import { defaultDeskCalibration } from './deskCalibration.js';
import { scoreManageAction } from './manageBrain.js';

function bar(
  t: number,
  o: number,
  h: number,
  l: number,
  c: number,
  ticks = 6
): TenSecBar {
  return {
    open_time_ms: t,
    open: o,
    high: h,
    low: l,
    close: c,
    ticks,
  };
}

/** ~30m of mild rally 10s bars so story/zone can form */
function rallyBook(): TenSecBar[] {
  const out: TenSecBar[] = [];
  const start = Date.now() - 40 * 60_000;
  let px = 4300;
  for (let i = 0; i < 200; i++) {
    const up = i % 3 !== 0;
    const o = px;
    const c = up ? px + 0.4 : px - 0.15;
    out.push(
      bar(
        start + i * 10_000,
        o,
        Math.max(o, c) + 0.1,
        Math.min(o, c) - 0.1,
        c,
        5 + (i % 4)
      )
    );
    px = c;
  }
  return out;
}

describe('marketContext', () => {
  it('builds 30m zone + pressure + velocity summary', () => {
    const snap = buildMarketContext(rallyBook(), 'TREND_UP', {
      mid: 4320,
      contributing: 3,
      sender_count: 3,
      agreement: 'STRONG',
      anchored_to_capital: true,
    });
    expect(snap.summary).toMatch(/G\d+\/R\d+/);
    expect(snap.pressure.green_1m + snap.pressure.red_1m).toBeGreaterThan(0);
    expect(snap.feed?.agreement).toBe('STRONG');
    const compact = compactMarketContext(snap);
    expect(compact?.green_share).toBeGreaterThanOrEqual(0);
  });

  it('story/pressure fight helpers', () => {
    expect(storyFightsSide('SELL', 'BUY')).toBe(true);
    expect(storyFightsSide('BUY', 'BUY')).toBe(false);
    expect(pressureFightsSide(0.3, 'BUY')).toBe(true);
    expect(pressureFightsSide(0.7, 'SELL')).toBe(true);
  });
});

describe('manageBrain + market context', () => {
  it('leans protect when story fights open side', () => {
    const book = rallyBook();
    const market = buildMarketContext(book, 'TREND_DOWN', null);
    // Force adverse story allow via override-ish: if story allows BUY and we are SELL
    const r = scoreManageAction({
      open_side: 'SELL',
      entry_price: 4320,
      mid: 4318,
      mfe: 5,
      mae: 0.5,
      unrealized: 2,
      peak_retention: 0.4,
      peak_protect_armed: true,
      entry_regime: 'TREND_DOWN',
      live_regime: 'TREND_UP',
      entry_setup: 'PULLBACK',
      soft_sl: 3.5,
      peak_mfe_floor: 6,
      peak_retention_cfg: 0.72,
      target_dist: 10,
      minute_policy: 'reverse',
      soft_gate_allow: true,
      soft_gate_hold_reason: '',
      next_entry_side: 'BUY',
      session_expectancy_pts: -0.3,
      last_window_expectancy: -0.4,
      closes_in_session: 5,
      held_ms: 90_000,
      market: {
        ...market,
        story: market.story
          ? { ...market.story, allow: 'BUY', chapter: 'RALLY' }
          : {
              chapter: 'RALLY',
              allow: 'BUY',
              red_1m: 5,
              green_1m: 20,
              swing: 'HH_HL',
              conf: 0.7,
              net_pts: 8,
            },
        pressure: { ...market.pressure, green_share: 0.75, green_1m: 20, red_1m: 5 },
      },
    });
    expect(['CUT', 'BANK']).toContain(r.action);
    expect(r.reason).toMatch(/story|pressure|RALLY|BRAIN/i);
  });
});

describe('autoCalibrate human outcome review', () => {
  it('writes PRĀTS/MĀCĪBA and keeps filters OPEN — Peak protect-sooner on knife Soft', () => {
    const base = defaultDeskCalibration();
    const r = proposeAutoCalibration(base, [
      {
        pnl_pts: -2.2,
        regime: 'TREND_UP',
        setup_type: 'PULLBACK',
        exit_reason: 'HardInvalidation · Soft',
        mfe: 0.5,
        mae: 2.2,
        at: new Date().toISOString(),
        entry_ctx: {
          chapter: 'BOUNCE_IN_SELL',
          zone_band: 'MID_HI',
          green_share: 0.3,
          expanding: false,
          feed_agreement: 'OK',
          body_pct: 0.0001,
        },
      },
      {
        pnl_pts: -2.1,
        regime: 'TREND_UP',
        setup_type: 'PULLBACK',
        exit_reason: 'HardInvalidation',
        mfe: 0.4,
        mae: 2.1,
        at: new Date().toISOString(),
        entry_ctx: {
          chapter: 'RANGE_CHOP',
          zone_band: 'MID',
          green_share: 0.5,
          expanding: false,
          feed_agreement: 'OK',
          body_pct: 0.0001,
        },
      },
      {
        pnl_pts: -0.3,
        regime: 'RANGE',
        setup_type: 'FADE',
        exit_reason: 'HardInvalidation',
        mfe: 0.2,
        mae: 1.8,
        at: new Date().toISOString(),
        entry_ctx: {
          chapter: 'DIP_IN_RALLY',
          zone_band: 'LO',
          green_share: 0.6,
          expanding: true,
          feed_agreement: 'DIVERGENT',
          body_pct: 0.0002,
        },
      },
      {
        pnl_pts: 0.4,
        regime: 'TREND_UP',
        setup_type: 'PULLBACK',
        exit_reason: 'PeakProtection',
        mfe: 3.5,
        mae: 0.5,
        at: new Date().toISOString(),
        entry_ctx: {
          chapter: 'RALLY',
          zone_band: 'MID_LO',
          green_share: 0.7,
          expanding: true,
          feed_agreement: 'STRONG',
          body_pct: 0.0003,
        },
      },
      {
        pnl_pts: -1.9,
        regime: 'TREND_UP',
        setup_type: 'PULLBACK',
        exit_reason: 'HardInvalidation',
        mfe: 0.3,
        mae: 2.0,
        at: new Date().toISOString(),
        entry_ctx: {
          chapter: 'BOUNCE_IN_SELL',
          zone_band: 'HI',
          green_share: 0.25,
          expanding: false,
          feed_agreement: 'DIVERGENT',
          body_pct: 0.0001,
        },
      },
    ]);
    expect(r.next.entry_filter_level).toBe(0);
    expect(r.changes.some((c) => c.includes('PRĀTS'))).toBe(true);
    expect(r.changes.some((c) => c.includes('MĀCĪBA'))).toBe(true);
    expect(r.changes.some((c) => /adverse story|DIVERGENT losses/.test(c))).toBe(false);
  });
});
