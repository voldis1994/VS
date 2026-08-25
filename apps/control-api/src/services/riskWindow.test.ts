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

  it('seeds equity then tracks pnl %', () => {
    const t0 = 1_000_000;
    setRiskEquity(1, 100, t0);
    noteRiskTradePnl(1, 5, t0 + 1000); // +5%
    const { snapshot } = evaluateRiskWindow(1, 0, t0 + 1000);
    expect(snapshot.pnl_pct).toBeCloseTo(0.05, 5);
    expect(snapshot.status).toBe('ACTIVE');
    expect(allowRiskEntry(1, 0, t0 + 1000).ok).toBe(true);
  });

  it('−10% live → cooldown 10min', () => {
    const t0 = 2_000_000;
    setRiskEquity(2, 100, t0);
    noteRiskTradePnl(2, -10, t0 + 5000);
    const r = allowRiskEntry(2, 0, t0 + 5000);
    expect(r.ok).toBe(false);
    expect(r.snapshot.status).toBe('STOPPED_LOSS');
    expect(r.snapshot.cooldown_remaining_sec).toBeGreaterThan(500);
    // still blocked mid cooldown
    expect(allowRiskEntry(2, 0, t0 + 5000 + 60_000).ok).toBe(false);
  });

  it('end of 10min without +7% → cooldown', () => {
    const t0 = 3_000_000;
    setRiskEquity(3, 100, t0);
    noteRiskTradePnl(3, 2, t0 + 1000); // +2%
    const r = allowRiskEntry(3, 0, t0 + RISK_WINDOW_MS);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/< \+7%/);
  });

  it('end of 10min with ≥7% → new window, keep trading', () => {
    const t0 = 4_000_000;
    setRiskEquity(4, 100, t0);
    noteRiskTradePnl(4, 8, t0 + 1000); // +8%
    const r = allowRiskEntry(4, 0, t0 + RISK_WINDOW_MS);
    expect(r.ok).toBe(true);
    expect(r.snapshot.status).toBe('ACTIVE');
  });

  it('+10% banks → cooldown', () => {
    const t0 = 5_000_000;
    setRiskEquity(5, 100, t0);
    noteRiskTradePnl(5, 10, t0 + 2000);
    const r = allowRiskEntry(5, 0, t0 + 2000);
    expect(r.ok).toBe(false);
    expect(r.snapshot.status).toBe('BANKED');
  });
});
