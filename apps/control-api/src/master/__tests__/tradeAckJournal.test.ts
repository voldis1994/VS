import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Mt4FileBroker } from '../broker.js';
import { Mt4BridgeSimulator } from '../mt4Sim.js';
import { PositionManager } from '../positionManager.js';
import { MasterPipeline } from '../pipeline.js';
import { masterRuntime } from '../runtime.js';
import {
  clearTradeAckJournalForTest,
  findOpenSuccessUnbooked,
  loadTradeAckJournal,
  logTradeIntent,
  updateTradeAck,
} from '../tradeAckJournal.js';

describe('INTENT→ACK trade journal (Reader)', () => {
  afterEach(() => {
    clearTradeAckJournalForTest();
    masterRuntime.stop();
  });

  it('logTradeIntent persists PENDING before ack update', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-ack-j-'));
    process.env.MASTER_STATE_DIR = dir;
    expect(
      logTradeIntent({
        command_id: 'cmd1',
        intent_id: 'intent-1',
        action: 'OPEN',
        side: 'BUY',
        volume: 0.1,
        epic: 'XAUUSD',
        sl: 4390,
        tp: 4420,
        reason: 'INTENT',
      })
    ).toBe(true);
    expect(existsSync(join(dir, 'trade_ack_journal.json'))).toBe(true);
    const rows = loadTradeAckJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ack_status).toBe('PENDING');
    expect(updateTradeAck('cmd1', { ack_status: 'SUCCESS', ticket: '1001', fill_price: 4400 })).toBe(
      true
    );
    expect(loadTradeAckJournal()[0]!.ack_status).toBe('SUCCESS');
    expect(loadTradeAckJournal()[0]!.ticket).toBe('1001');
  });

  it('findOpenSuccessUnbooked skips already booked tickets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-ack-u-'));
    process.env.MASTER_STATE_DIR = dir;
    logTradeIntent({
      command_id: 'c2',
      intent_id: 'i2',
      action: 'OPEN',
      side: 'SELL',
      volume: 0.05,
      epic: 'GOLD',
      sl: null,
      tp: null,
      reason: 'INTENT',
    });
    updateTradeAck('c2', { ack_status: 'SUCCESS', ticket: 'T-9', fill_price: 4410 });
    expect(findOpenSuccessUnbooked(new Set()).map((r) => r.ticket)).toEqual(['T-9']);
    expect(findOpenSuccessUnbooked(new Set(['T-9']))).toHaveLength(0);
  });

  it('Mt4 placeOrder writes INTENT then SUCCESS on ack', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vs-mt4-intent-'));
    const state = mkdtempSync(join(tmpdir(), 'vs-ack-state-'));
    process.env.MASTER_STATE_DIR = state;
    const sim = new Mt4BridgeSimulator(root);
    sim.setQuote(4400, 4400.4);
    sim.start(30);
    const broker = new Mt4FileBroker(root);
    await broker.connect();
    try {
      const placed = await broker.placeOrder({
        intent_id: 'intentackjournaltest0001',
        epic: 'XAUUSD',
        side: 'BUY',
        size: 0.05,
        stop_level: 4390,
        profit_level: 4420,
      });
      expect(placed.ok).toBe(true);
      const rows = loadTradeAckJournal();
      expect(rows.some((r) => r.ack_status === 'SUCCESS' && r.action === 'OPEN')).toBe(true);
      expect(rows[0]!.ticket || placed.position_id).toBeTruthy();

      const closed = await broker.closePosition(placed.position_id!);
      expect(closed.ok).toBe(true);
      const after = loadTradeAckJournal();
      expect(after.some((r) => r.action === 'CLOSE' && r.ack_status === 'SUCCESS')).toBe(
        true
      );
    } finally {
      sim.stop();
    }
  });

  it('recover adopts OPEN SUCCESS from journal when local book empty', async () => {
    const state = mkdtempSync(join(tmpdir(), 'vs-ack-rec-'));
    process.env.MASTER_STATE_DIR = state;
    const root = mkdtempSync(join(tmpdir(), 'vs-mt4-rec-'));
    mkdirSync(join(root, 'status'), { recursive: true });
    // Empty/ambiguous status — journal must still adopt
    writeFileSync(join(root, 'status', 'latest.json'), JSON.stringify({ positions: [] }));

    logTradeIntent({
      command_id: 'recopen1',
      intent_id: 'recover-intent-1',
      action: 'OPEN',
      side: 'BUY',
      volume: 0.1,
      epic: 'XAUUSD',
      sl: 4390,
      tp: 4420,
      reason: 'INTENT',
    });
    updateTradeAck('recopen1', {
      ack_status: 'SUCCESS',
      ticket: '777001',
      fill_price: 4405,
      detail: 'ACK_SUCCESS',
    });

    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.cfg = { ...masterRuntime.cfg, mode: 'LIVE' };
    const broker = new Mt4FileBroker(root);
    await broker.connect();
    masterRuntime.attachBroker(broker);
    masterRuntime.recovered = false;
    const r = await masterRuntime.recover();
    expect(r.positions).toBeGreaterThanOrEqual(1);
    expect(masterRuntime.positions.get('777001')).toBeTruthy();
    expect(masterRuntime.positions.get('777001')!.entry).toBe(4405);
    // Ticket not on broker — do not paint journal SL/TP as chart truth
    expect(masterRuntime.positions.get('777001')!.stop_loss).toBeNull();
    expect(masterRuntime.positions.get('777001')!.take_profit).toBeNull();
    // Idempotent
    await masterRuntime.recover();
    expect(masterRuntime.positions.count()).toBe(1);
  });

  it('recover attach-or-fail proves journal SL/TP when ticket live naked', async () => {
    const state = mkdtempSync(join(tmpdir(), 'vs-ack-attach-'));
    process.env.MASTER_STATE_DIR = state;
    clearTradeAckJournalForTest();
    const root = mkdtempSync(join(tmpdir(), 'vs-mt4-attach-rec-'));
    const sim = new Mt4BridgeSimulator(root);
    sim.setQuote(4400, 4400.4);
    sim.start(30);
    const ticket = sim.seedPosition({
      ticket: 888777,
      side: 'BUY',
      lot: 0.05,
      open: 4401,
      sl: 0,
      tp: 0,
    });

    logTradeIntent({
      command_id: 'recattach1',
      intent_id: 'recover-attach-1',
      action: 'OPEN',
      side: 'BUY',
      volume: 0.05,
      epic: 'XAUUSD',
      sl: 4390,
      tp: 4420,
      reason: 'INTENT',
    });
    updateTradeAck('recattach1', {
      ack_status: 'SUCCESS',
      ticket: String(ticket),
      fill_price: 4401,
      detail: 'RECOVER_LATE_FILL',
    });

    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.cfg = { ...masterRuntime.cfg, mode: 'LIVE' };
    const broker = new Mt4FileBroker(root);
    await broker.connect();
    masterRuntime.attachBroker(broker);
    masterRuntime.recovered = false;
    try {
      const r = await masterRuntime.recover();
      expect(r.positions).toBeGreaterThanOrEqual(1);
      const pos = masterRuntime.positions.get(String(ticket));
      expect(pos).toBeTruthy();
      expect(pos!.stop_loss).toBe(4390);
      expect(pos!.take_profit).toBe(4420);
      const opens = await broker.listOpenPositions('XAUUSD');
      const hit = opens.positions.find((p) => p.position_id === String(ticket));
      expect(hit?.stop_level).toBe(4390);
      expect(hit?.profit_level).toBe(4420);
      expect(String(masterRuntime.broker_detail || '')).toMatch(/ack_attach_ok/);
    } finally {
      sim.stop();
    }
  });

  it('recover attach-fail registers live ticket with intended levels when close fails', async () => {
    const state = mkdtempSync(join(tmpdir(), 'vs-ack-attach-fail-'));
    process.env.MASTER_STATE_DIR = state;
    clearTradeAckJournalForTest();
    const root = mkdtempSync(join(tmpdir(), 'vs-mt4-attach-fail-'));
    const sim = new Mt4BridgeSimulator(root);
    sim.setQuote(4400, 4400.4);
    sim.start(30);
    const ticket = sim.seedPosition({
      ticket: 888666,
      side: 'BUY',
      lot: 0.05,
      open: 4401,
      sl: 0,
      tp: 0,
    });

    logTradeIntent({
      command_id: 'recattachfail1',
      intent_id: 'recover-attach-fail-1',
      action: 'OPEN',
      side: 'BUY',
      volume: 0.05,
      epic: 'XAUUSD',
      sl: 4390,
      tp: 4420,
      reason: 'INTENT',
    });
    updateTradeAck('recattachfail1', {
      ack_status: 'SUCCESS',
      ticket: String(ticket),
      fill_price: 4401,
      detail: 'RECOVER_LATE_FILL',
    });

    masterRuntime.pipeline = new MasterPipeline('LIVE');
    masterRuntime.positions = new PositionManager();
    masterRuntime.cfg = { ...masterRuntime.cfg, mode: 'LIVE' };
    const broker = new Mt4FileBroker(root);
    await broker.connect();
    broker.modifyPosition = async () => ({ ok: false, detail: 'modify_denied' });
    broker.closePosition = async () => ({ ok: false, detail: 'close_denied' });
    masterRuntime.attachBroker(broker);
    masterRuntime.recovered = false;
    try {
      const r = await masterRuntime.recover();
      expect(r.positions).toBeGreaterThanOrEqual(1);
      const pos = masterRuntime.positions.get(String(ticket));
      expect(pos).toBeTruthy();
      expect(pos!.stop_loss).toBeNull();
      expect(pos!.intended_stop_loss).toBe(4390);
      expect(pos!.intended_take_profit).toBe(4420);
      expect(String(masterRuntime.broker_detail || '')).toMatch(/ack_attach_fail/);
      const opens = await broker.listOpenPositions('XAUUSD');
      expect(opens.positions.some((p) => p.position_id === String(ticket))).toBe(
        true
      );
    } finally {
      sim.stop();
    }
  });

});
