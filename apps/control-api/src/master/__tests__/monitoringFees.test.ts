import { describe, expect, it } from 'vitest';
import { applyCloseFees, estimateTradeFees } from '../moneyExit.js';
import { CycleMonitor } from '../monitoring.js';

describe('close fee honesty (replay parity)', () => {
  it('estimates commission from MASTER_COMMISSION_PER_LOT', () => {
    const prev = process.env.MASTER_COMMISSION_PER_LOT;
    process.env.MASTER_COMMISSION_PER_LOT = '0.05';
    expect(estimateTradeFees(2)).toBeCloseTo(0.1, 8);
    if (prev === undefined) delete process.env.MASTER_COMMISSION_PER_LOT;
    else process.env.MASTER_COMMISSION_PER_LOT = prev;
  });

  it('subtracts fees for mark PnL but not broker fill_pnl', () => {
    const mark = applyCloseFees({ pnl: 10, volume: 1, from_broker: false });
    expect(mark.fees).toBeGreaterThan(0);
    expect(mark.pnl).toBeLessThan(10);
    const broker = applyCloseFees({ pnl: 10, volume: 1, from_broker: true });
    expect(broker.fees).toBe(0);
    expect(broker.pnl).toBe(10);
  });
});

describe('CycleMonitor', () => {
  it('records cycle ms and relative spread', () => {
    const m = new CycleMonitor();
    m.noteCycle(12.4);
    m.noteRelativeSpread(1.25);
    const snap = m.snapshot(500);
    expect(snap.last_cycle_ms).toBe(12);
    expect(snap.cycles).toBe(1);
    expect(snap.relative_spread).toBe(1.25);
    expect(snap.data_freshness_ms).toBe(500);
  });
});
