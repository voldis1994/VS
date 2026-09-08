import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyCloseFees, estimateTradeFees } from '../moneyExit.js';
import { CycleMonitor } from '../monitoring.js';

describe('usableBrokerUpl', () => {
  it('treats 0/null as missing so mark PnL can run', async () => {
    const { usableBrokerUpl } = await import('../moneyExit.js');
    expect(usableBrokerUpl(null)).toBeNull();
    expect(usableBrokerUpl(undefined)).toBeNull();
    expect(usableBrokerUpl(0)).toBeNull();
    expect(usableBrokerUpl(1.25)).toBe(1.25);
    expect(usableBrokerUpl(-2)).toBe(-2);
  });
});

describe('preferCloseFillPnl', () => {
  it('prefers confirm profit, else scales non-zero broker UPL', async () => {
    const { preferCloseFillPnl } = await import('../moneyExit.js');
    expect(preferCloseFillPnl({ fill_pnl: -1.09, broker_upl: -8 })).toBe(-1.09);
    expect(preferCloseFillPnl({ fill_pnl: 0, broker_upl: -8 })).toBe(0);
    expect(preferCloseFillPnl({ fill_pnl: null, broker_upl: -8.5 })).toBe(-8.5);
    expect(preferCloseFillPnl({ fill_pnl: null, broker_upl: 0 })).toBeNull();
    expect(
      preferCloseFillPnl({ fill_pnl: null, broker_upl: 10, size_ratio: 0.5 })
    ).toBeCloseTo(5, 8);
  });
});

describe('Capital LIVE close money fail-close', () => {
  it('refuses pts×size as realized when capitalLive and fill_pnl missing', async () => {
    const { resolveCloseMoneyPnl, priceResolvedCloseMoney } = await import(
      '../moneyExit.js'
    );
    const forged = resolveCloseMoneyPnl({
      side: 'BUY',
      entry: 4410,
      fill: 4400, // STOP proxy
      size: 0.1,
      value_per_point_per_lot: 1,
      fill_pnl: null,
      capitalLive: true,
    });
    expect(forged.pnl_proven).toBe(false);
    expect(forged.pnl).toBe(0);
    const priced = priceResolvedCloseMoney({ ...forged, volume: 0.1 });
    expect(priced.fees).toBe(0);
    expect(priced.pnl).toBe(0);

    const paper = resolveCloseMoneyPnl({
      side: 'BUY',
      entry: 4410,
      fill: 4400,
      size: 0.1,
      value_per_point_per_lot: 1,
      fill_pnl: null,
      capitalLive: false,
    });
    expect(paper.pnl_proven).toBe(true);
    expect(paper.pnl).toBeCloseTo(-1.0, 8);
  });
});

describe('close fee honesty (replay parity)', () => {
  it('estimates commission from MASTER_COMMISSION_PER_LOT', () => {
    const prev = process.env.MASTER_COMMISSION_PER_LOT;
    process.env.MASTER_COMMISSION_PER_LOT = '0.05';
    expect(estimateTradeFees(2)).toBeCloseTo(0.1, 8);
    if (prev === undefined) delete process.env.MASTER_COMMISSION_PER_LOT;
    else process.env.MASTER_COMMISSION_PER_LOT = prev;
  });

  it('subtracts fees for mark PnL; broker fill_pnl keeps pnl, records fee estimate', () => {
    const mark = applyCloseFees({ pnl: 10, volume: 1, from_broker: false });
    expect(mark.fees).toBeGreaterThan(0);
    expect(mark.pnl).toBeLessThan(10);
    const broker = applyCloseFees({ pnl: 10, volume: 1, from_broker: true });
    expect(broker.fees).toBeGreaterThan(0);
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

  it('hydrateFromDisk restores alerts and cycle latency after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-mon-hyd-'));
    process.env.MASTER_STATE_DIR = dir;
    const m = new CycleMonitor();
    m.noteCycle(42);
    m.noteRelativeSpread(1.1);
    const { ALERT_DATA_STALE } = await import('../cycleAlerts.js');
    m.noteAlerts(
      [
        {
          code: ALERT_DATA_STALE,
          level: 'WARNING',
          message: 'stale',
          ts: new Date().toISOString(),
        },
      ],
      `alert:${ALERT_DATA_STALE}`
    );
    m.snapshot(9000);
    const m2 = new CycleMonitor();
    expect(m2.hydrateFromDisk()).toBe(true);
    expect(m2.last_cycle_ms).toBe(42);
    expect(m2.relative_spread).toBe(1.1);
    const snap = m2.snapshot(null);
    expect(snap.entry_block_reason).toBe(`alert:${ALERT_DATA_STALE}`);
    expect(snap.active_alerts.some((a) => a.code === ALERT_DATA_STALE)).toBe(true);
    expect(snap.instance_health).not.toBe('OK');
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
