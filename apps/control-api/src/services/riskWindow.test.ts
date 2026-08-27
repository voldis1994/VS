import { describe, expect, it, beforeEach } from 'vitest';
import {
  RISK_WINDOW_MS,
  allowRiskEntry,
  evaluateRiskWindow,
  noteRiskTradeOpen,
  noteRiskTradePnl,
  resetRiskWindows,
  setRiskEquity,
} from './riskWindow.js';

describe('60min risk window', () => {
  beforeEach(() => resetRiskWindows());

  it('UNKNOWN equity does not block entry (manual lot_size path)', () => {
    const t0 = 1_000_000;
    const r = allowRiskEntry(1, 0, t0);
    expect(r.ok).toBe(true);
    expect(r.snapshot.status).toBe('SEEDING');
    expect(r.snapshot.equity_start).toBeNull();
    expect(r.reason).not.toMatch(/no entry until/i);
    expect(r.reason).toMatch(/manual lot_size/i);
    setRiskEquity(1, 100, t0);
    expect(allowRiskEntry(1, 0, t0).ok).toBe(true);
    expect(allowRiskEntry(1, 0, t0).snapshot.status).toBe('IDLE');
  });

  it('IDLE waiting for setup does not burn clock or cooldown after 60min', () => {
    const t0 = 1_100_000;
    setRiskEquity(1, 100, t0);
    expect(allowRiskEntry(1, 0, t0).snapshot.status).toBe('IDLE');
    const later = allowRiskEntry(1, 0, t0 + RISK_WINDOW_MS + 60_000);
    expect(later.ok).toBe(true);
    expect(later.snapshot.status).toBe('IDLE');
    expect(later.snapshot.cooldown_remaining_sec).toBe(0);
  });

  it('clock starts on first trade; then tracks realized %', () => {
    const t0 = 1_200_000;
    setRiskEquity(1, 100, t0);
    noteRiskTradeOpen(1, t0);
    noteRiskTradePnl(1, 5, t0 + 1000);
    const { snapshot } = evaluateRiskWindow(1, 0, t0 + 1000);
    expect(snapshot.status).toBe('ACTIVE');
    expect(snapshot.realized_pct).toBeCloseTo(0.05, 5);
    expect(snapshot.window_remaining_sec).toBeGreaterThan(500);
  });

  it('−10% live → cooldown', () => {
    const t0 = 2_000_000;
    setRiskEquity(2, 100, t0);
    noteRiskTradeOpen(2, t0);
    const r = allowRiskEntry(2, -10, t0 + 5000);
    expect(r.ok).toBe(false);
    expect(r.snapshot.status).toBe('STOPPED_LOSS');
  });

  it('traded but <+7% at end → cooldown', () => {
    const t0 = 3_000_000;
    setRiskEquity(3, 100, t0);
    noteRiskTradeOpen(3, t0);
    noteRiskTradePnl(3, 2, t0 + 1000);
    const r = allowRiskEntry(3, 0, t0 + RISK_WINDOW_MS);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/< \+7%/);
  });

  it('floating UPL alone at end without closes still needs realized for pass', () => {
    const t0 = 3_500_000;
    setRiskEquity(9, 100, t0);
    noteRiskTradeOpen(9, t0);
    // open UPL +8% but no close — at window end realized 0 → cooldown (did trade)
    const r = allowRiskEntry(9, 8, t0 + RISK_WINDOW_MS);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/< \+7%/);
  });

  it('≥7% realized at end → idle, keep trading allowed', () => {
    const t0 = 4_000_000;
    setRiskEquity(4, 100, t0);
    noteRiskTradeOpen(4, t0);
    noteRiskTradePnl(4, 8, t0 + 1000);
    const r = allowRiskEntry(4, 0, t0 + RISK_WINDOW_MS);
    expect(r.ok).toBe(true);
    expect(r.snapshot.status).toBe('IDLE');
  });

  it('+10% early banks → cooldown', () => {
    const t0 = 5_000_000;
    setRiskEquity(5, 100, t0);
    noteRiskTradeOpen(5, t0);
    const live = allowRiskEntry(5, 10, t0 + 60_000);
    expect(live.ok).toBe(false);
    expect(live.snapshot.status).toBe('BANKED');
  });
});
