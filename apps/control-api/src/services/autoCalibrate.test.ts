import { describe, expect, it, beforeEach } from 'vitest';
import {
  AUTO_CALIBRATE_EVERY_N,
  MIN_ENABLED_REGIMES,
  _resetAutoCalibrateForTests,
  beginAutoCalibrateSession,
  getAutoCalibrateStatus,
  noteClosedTradeForAutoCalibrate,
  proposeAutoCalibration,
} from './autoCalibrate.js';
import { defaultDeskCalibration, setDeskCalibration } from './deskCalibration.js';

function trade(partial: {
  pnl_pts: number;
  regime?: string;
  exit_reason?: string;
  mfe?: number;
  mae?: number;
}) {
  return {
    pnl_pts: partial.pnl_pts,
    regime: partial.regime ?? 'TREND_UP',
    setup_type: 'PULLBACK',
    exit_reason: partial.exit_reason ?? 'PeakProtection',
    mfe: partial.mfe ?? Math.max(partial.pnl_pts, 0),
    mae: partial.mae ?? Math.min(partial.pnl_pts, 0),
    at: new Date().toISOString(),
  };
}

describe('autoCalibrate', () => {
  beforeEach(() => {
    _resetAutoCalibrateForTests();
    setDeskCalibration(defaultDeskCalibration());
  });

  it('resets watch on robot START and counts until next cycle', () => {
    const st = beginAutoCalibrateSession('test');
    expect(st.closes_in_session).toBe(0);
    expect(st.closes_until_next).toBe(AUTO_CALIBRATE_EVERY_N);
    expect(st.session_started_at).toBeTruthy();
  });

  it('calibrates every 5 closes — raises Peak/Target when micro-wins vs Soft losses', () => {
    beginAutoCalibrateSession('test');
    const before = defaultDeskCalibration();
    // 4 closes — no cycle yet
    for (let i = 0; i < 4; i++) {
      const r = noteClosedTradeForAutoCalibrate(
        trade({ pnl_pts: 0.4, exit_reason: 'PeakProtection' })
      );
      expect(r).toBeNull();
    }
    expect(getAutoCalibrateStatus().closes_in_session).toBe(4);

    // 5th — Soft losses + micro wins → let winners run
    const cycle = noteClosedTradeForAutoCalibrate(
      trade({ pnl_pts: -2.2, exit_reason: 'HardInvalidation · Soft', regime: 'RANGE' })
    );
    expect(cycle).toBeTruthy();
    expect(cycle!.changes.length).toBeGreaterThan(0);
    expect(cycle!.next.peak_mfe_abs).toBeGreaterThan(before.peak_mfe_abs);
    expect(cycle!.next.target_abs).toBeGreaterThanOrEqual(before.target_abs);
    expect(getAutoCalibrateStatus().cycles_run).toBe(1);
  });

  it('soft-demotes worst regime but keeps ≥ MIN_ENABLED_REGIMES', () => {
    const current = defaultDeskCalibration();
    const window = [
      trade({ pnl_pts: -1.5, regime: 'RANGE', exit_reason: 'HardInvalidation' }),
      trade({ pnl_pts: -1.2, regime: 'RANGE', exit_reason: 'HardInvalidation' }),
      trade({ pnl_pts: 2.0, regime: 'TREND_UP', exit_reason: 'PeakProtection' }),
      trade({ pnl_pts: 2.5, regime: 'TREND_UP', exit_reason: 'Target' }),
      trade({ pnl_pts: 1.0, regime: 'PULLBACK_UPTREND', exit_reason: 'PeakProtection' }),
    ];
    const demoted = new Set<string>();
    const result = proposeAutoCalibration(current, window, demoted);
    expect(result.next.enabled_regimes.length).toBeGreaterThanOrEqual(MIN_ENABLED_REGIMES);
    expect(result.next.enabled_regimes.includes('RANGE' as never)).toBe(false);
    expect(result.next.enabled_regimes.includes('TREND_UP' as never)).toBe(true);
    expect(result.changes.some((c) => c.includes('regime OFF RANGE'))).toBe(true);
  });

  it('never empties allowlist even if all window regimes lose', () => {
    const current = {
      ...defaultDeskCalibration(),
      enabled_regimes: ['RANGE', 'TREND_UP', 'TREND_DOWN', 'BREAKOUT_UP', 'EXPANSION'] as never,
    };
    const window = [
      trade({ pnl_pts: -2, regime: 'RANGE' }),
      trade({ pnl_pts: -2, regime: 'RANGE' }),
      trade({ pnl_pts: -1, regime: 'TREND_UP' }),
      trade({ pnl_pts: -1, regime: 'TREND_UP' }),
      trade({ pnl_pts: -0.5, regime: 'BREAKOUT_UP' }),
    ];
    const result = proposeAutoCalibration(current, window, new Set());
    expect(result.next.enabled_regimes.length).toBeGreaterThanOrEqual(MIN_ENABLED_REGIMES);
  });

  it('does not block — lot/knobs only; propose leaves trading possible', () => {
    const r = proposeAutoCalibration(defaultDeskCalibration(), [
      trade({ pnl_pts: 3 }),
      trade({ pnl_pts: 3 }),
      trade({ pnl_pts: 2 }),
      trade({ pnl_pts: -1 }),
      trade({ pnl_pts: 2 }),
    ]);
    expect(r.next.enabled_regimes.length).toBeGreaterThanOrEqual(MIN_ENABLED_REGIMES);
  });
});
