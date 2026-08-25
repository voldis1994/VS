import { describe, expect, it, beforeEach } from 'vitest';
import {
  RISK_WINDOW_MS,
  allowRiskEntry,
  evaluateRiskWindow,
  noteRiskTradePnl,
  resetRiskWindows,
  setRiskEquity,
} from './riskWindow.js';

describe('10min risk window', () => {
  beforeEach(() => resetRiskWindows());

  it('blocks entry until equity is seeded (no SEEDING hole)', () => {
    const t0 = 1_000_000;
    expect(allowRiskEntry(1, 0, t0).ok).toBe(false);
    expect(allowRiskEntry(1, 0, t0).snapshot.status).toBe('SEEDING');
    setRiskEquity(1, 100, t0);
    expect(allowRiskEntry(1, 0, t0).ok).toBe(true);
  });

  it('tracks realized % after equity seed', () => {
    const t0 = 1_100_000;
    setRiskEquity(1, 100, t0);
    noteRiskTradePnl(1, 5, t0 + 1000);
    const { snapshot } = evaluateRiskWindow(1, 0, t0 + 1000);
    expect(snapshot.realized_pct).toBeCloseTo(0.05, 5);
    expect(snapshot.status).toBe('ACTIVE');
  });

  it('−10% live (incl open UPL) → cooldown 10min', () => {
    const t0 = 2_000_000;
    setRiskEquity(2, 100, t0);
    const r = allowRiskEntry(2, -10, t0 + 5000);
    expect(r.ok).toBe(false);
    expect(r.snapshot.status).toBe('STOPPED_LOSS');
    expect(allowRiskEntry(2, 0, t0 + 5000 + 60_000).ok).toBe(false);
  });

  it('end of 10min without +7% realized → cooldown', () => {
    const t0 = 3_000_000;
    setRiskEquity(3, 100, t0);
    noteRiskTradePnl(3, 2, t0 + 1000);
    const r = allowRiskEntry(3, 0, t0 + RISK_WINDOW_MS);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/< \+7%/);
  });

  it('floating +8% UPL does NOT pass the 10min target — need realized', () => {
    const t0 = 3_500_000;
    setRiskEquity(9, 100, t0);
    const r = allowRiskEntry(9, 8, t0 + RISK_WINDOW_MS);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/< \+7%/);
  });

  it('end of 10min with ≥7% realized → new window, keep trading', () => {
    const t0 = 4_000_000;
    setRiskEquity(4, 100, t0);
    noteRiskTradePnl(4, 8, t0 + 1000);
    const r = allowRiskEntry(4, 0, t0 + RISK_WINDOW_MS);
    expect(r.ok).toBe(true);
    expect(r.snapshot.status).toBe('ACTIVE');
    expect(r.snapshot.equity_start).toBe(100);
  });

  it('+10% early (realized OR live) banks → cooldown netirgo', () => {
    const t0 = 5_000_000;
    setRiskEquity(5, 100, t0);
    // Floating +10% mid-window → bank early
    const live = allowRiskEntry(5, 10, t0 + 60_000);
    expect(live.ok).toBe(false);
    expect(live.snapshot.status).toBe('BANKED');
    expect(live.reason).toMatch(/bank early|≥ \+10%/);

    resetRiskWindows();
    setRiskEquity(55, 100, t0);
    noteRiskTradePnl(55, 10, t0 + 30_000);
    const closed = allowRiskEntry(55, 0, t0 + 30_000);
    expect(closed.ok).toBe(false);
    expect(closed.snapshot.status).toBe('BANKED');
  });

  it('window clock does not run before equity seed', () => {
    const t0 = 6_000_000;
    // 9 minutes of SEEDING must not burn the window
    expect(allowRiskEntry(6, 0, t0 + 9 * 60_000).ok).toBe(false);
    setRiskEquity(6, 100, t0 + 9 * 60_000);
    const snap = evaluateRiskWindow(6, 0, t0 + 9 * 60_000).snapshot;
    expect(snap.status).toBe('ACTIVE');
    expect(snap.window_remaining_sec).toBeGreaterThan(500);
  });
});
