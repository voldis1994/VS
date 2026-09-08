import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

  it('PaperBroker close omits fill_pnl so journal can record model fees', async () => {
    const prev = process.env.MASTER_COMMISSION_PER_LOT;
    process.env.MASTER_COMMISSION_PER_LOT = '0.05';
    const { PaperBroker } = await import('../broker.js');
    const { resolveCloseMoneyPnl, applyCloseFees: price } = await import('../moneyExit.js');
    const broker = new PaperBroker();
    await broker.connect();
    broker.setQuote({
      bid: 4400,
      ask: 4400.2,
      mid: 4400.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'paper-fee-aaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: 4390,
      profit_level: 4410,
    });
    broker.setQuote({
      bid: 4410,
      ask: 4410.2,
      mid: 4410.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const closed = await broker.closePosition(placed.position_id!);
    expect(closed.ok).toBe(true);
    expect(closed.fill_pnl).toBeNull();
    expect(closed.fill_price).toBe(4410);
    // BUY open @ ask 4400.2, close @ bid 4410 → +9.8 − 0.05 fees
    expect(broker.equity).toBeCloseTo(10_000 + 9.8 - 0.05, 6);
    const resolved = resolveCloseMoneyPnl({
      side: 'BUY',
      entry: placed.fill_price!,
      fill: closed.fill_price!,
      size: 1,
      value_per_point_per_lot: 1,
      fill_pnl: closed.fill_pnl,
    });
    expect(resolved.from_broker).toBe(false);
    const priced = price({
      pnl: resolved.pnl,
      volume: 1,
      from_broker: resolved.from_broker,
    });
    expect(priced.fees).toBeCloseTo(0.05, 8);
    expect(priced.pnl).toBeCloseTo(9.8 - 0.05, 8);
    if (prev === undefined) delete process.env.MASTER_COMMISSION_PER_LOT;
    else process.env.MASTER_COMMISSION_PER_LOT = prev;
  });
});

describe('soft trail scalp gate', () => {
  it('decideSoftTrailArm blocks when scalp_enabled=false', async () => {
    const { decideSoftTrailArm } = await import('../moneyExit.js');
    expect(
      decideSoftTrailArm({
        money_pnl: 1,
        money_arm: 0.05,
        already_armed: false,
        scalp_enabled: false,
      }).reason
    ).toBe('not_scalping');
    expect(
      decideSoftTrailArm({
        money_pnl: 1,
        money_arm: 0.05,
        already_armed: false,
        scalp_enabled: true,
      }).reason
    ).toBe('profit_hit');
  });
});

describe('CycleMonitor', () => {
  it('records cycle ms and relative spread', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-mon-'));
    process.env.MASTER_STATE_DIR = dir;
    const m = new CycleMonitor();
    m.noteCycle(12.4);
    m.noteRelativeSpread(1.25);
    const snap = m.snapshot(500);
    expect(snap.last_cycle_ms).toBe(12);
    expect(snap.cycles).toBe(1);
    expect(snap.relative_spread).toBe(1.25);
    expect(snap.data_freshness_ms).toBe(500);
    expect(snap.instance_health).toBe('OK');
    expect(snap.error_rate_per_min).toBe(0);
    expect(existsSync(join(dir, 'monitoring_snapshot.json'))).toBe(true);
  });
});

describe('cycle alerts entry gate', () => {
  it('blocks entries on DATA_STALE / ACCOUNT_NOT_TRADEABLE / ACK_TIMEOUT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-alert-'));
    process.env.MASTER_STATE_DIR = dir;
    const {
      dispatchCycleAlerts,
      alertsBlockEntries,
      healthFromAlerts,
      ALERT_DATA_STALE,
      ALERT_ACCOUNT_NOT_TRADEABLE,
      ALERT_ACK_TIMEOUT,
    } = await import('../cycleAlerts.js');
    const { logMasterError } = await import('../errorJournal.js');

    const stale = dispatchCycleAlerts({
      data_stale: true,
      freshness_ms: 20_000,
      stale_threshold_ms: 15_000,
      account_not_tradeable: false,
    });
    expect(stale.some((a) => a.code === ALERT_DATA_STALE)).toBe(true);
    expect(alertsBlockEntries(stale)).toBe(`alert:${ALERT_DATA_STALE}`);
    expect(healthFromAlerts(stale)).toBe('DEGRADED');

    const locked = dispatchCycleAlerts({
      data_stale: false,
      freshness_ms: 100,
      stale_threshold_ms: 15_000,
      account_not_tradeable: true,
    });
    expect(alertsBlockEntries(locked)).toBe(`alert:${ALERT_ACCOUNT_NOT_TRADEABLE}`);
    expect(healthFromAlerts(locked)).toBe('CRITICAL');

    logMasterError({
      module: 'mt4.placeOrder',
      error_type: 'ACK_TIMEOUT',
      message: 'OPEN ACK_TIMEOUT',
    });
    const ack = dispatchCycleAlerts({
      data_stale: false,
      freshness_ms: 100,
      stale_threshold_ms: 15_000,
      account_not_tradeable: false,
    });
    expect(ack.some((a) => a.code === ALERT_ACK_TIMEOUT)).toBe(true);
    expect(alertsBlockEntries(ack)).toBe(`alert:${ALERT_ACK_TIMEOUT}`);
  });
});
