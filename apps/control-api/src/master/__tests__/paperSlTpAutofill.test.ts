import { describe, expect, it } from 'vitest';
import { PaperBroker } from '../broker.js';

describe('PaperBroker VS-System SL/TP auto-fill on setQuote', () => {
  it('auto-fills STOP_HIT on quote without manageTick', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry,
      ask: entry + 0.2,
      mid: entry + 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'paper-sl-autofill-aaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: entry - 2,
      profit_level: entry + 10,
    });
    expect(placed.ok).toBe(true);
    const eqBefore = broker.equity;

    // Cross SL on bid — venue fills without PositionManager
    broker.setQuote({
      bid: entry - 2.5,
      ask: entry - 2.3,
      mid: entry - 2.4,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const open = await broker.listOpenPositions('GOLD');
    expect(open.positions.length).toBe(0);
    expect(broker.equity).toBeLessThan(eqBefore);

    // manageTick-style close stays idempotent with the auto fill
    const closed = await broker.closePosition(placed.position_id!);
    expect(closed.ok).toBe(true);
    expect(closed.fill_price).toBe(entry - 2.5);
    expect(String(closed.detail)).toMatch(/paper_auto_stop_hit/);
  });

  it('auto-fills TP_HIT on quote for SELL', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    broker.setQuote({
      bid: entry - 0.2,
      ask: entry,
      mid: entry - 0.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'paper-tp-autofill-aaaaaaaa',
      epic: 'GOLD',
      side: 'SELL',
      size: 1,
      stop_level: entry + 5,
      profit_level: entry - 3,
    });
    expect(placed.ok).toBe(true);

    broker.setQuote({
      bid: entry - 3.2,
      ask: entry - 3.0,
      mid: entry - 3.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const open = await broker.listOpenPositions();
    expect(open.positions.length).toBe(0);
    const closed = await broker.closePosition(placed.position_id!);
    expect(closed.ok).toBe(true);
    expect(String(closed.detail)).toMatch(/paper_auto_tp_hit/);
  });

  it('does not auto-close non-matching epic on GOLD quote', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    broker.setQuote({
      bid: 30,
      ask: 30.1,
      mid: 30.05,
      spread: 0.1,
      epic: 'SILVER',
      ts_ms: Date.now(),
    });
    const silver = await broker.placeOrder({
      intent_id: 'paper-sl-silver-aaaaaaaaaa',
      epic: 'SILVER',
      side: 'BUY',
      size: 1,
      stop_level: 28,
    });
    broker.setQuote({
      bid: 4400,
      ask: 4400.2,
      mid: 4400.1,
      spread: 0.2,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    // Hostile GOLD print must not flatten SILVER
    const open = await broker.listOpenPositions();
    expect(open.positions.map((p) => p.position_id)).toContain(silver.position_id);
  });

  it('markToMarket updates UPL on protective mark per epic', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    broker.setQuote({
      bid: 4400,
      ask: 4400.4,
      mid: 4400.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'paper-mtm-aaaaaaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 1,
      stop_level: 4300,
    });
    broker.setQuote({
      bid: 4410,
      ask: 4410.4,
      mid: 4410.2,
      spread: 0.4,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const open = await broker.listOpenPositions();
    const pos = open.positions.find((p) => p.position_id === placed.position_id);
    expect(pos).toBeTruthy();
    expect(pos!.upl).not.toBeNull();
    expect(Number(pos!.upl)).toBeGreaterThan(0);
  });
});
