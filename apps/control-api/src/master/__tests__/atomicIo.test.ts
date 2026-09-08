import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { atomicWriteJson, stableReadJson, stableReadText } from '../atomicIo.js';
import { Mt4FileBroker } from '../broker.js';
import { logMasterError, loadMasterErrors } from '../errorJournal.js';
import { logDecisionEvent, loadDecisionEvents } from '../decisionJournal.js';

describe('atomicIo (Reader)', () => {
  it('atomicWriteJson creates readable JSON without leftover tmp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-atomic-'));
    const path = join(dir, 'state.json');
    expect(atomicWriteJson(path, { a: 1, b: 'x' })).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8')).a).toBe(1);
  });

  it('stableReadJson refuses while sibling .tmp exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-stable-'));
    const path = join(dir, 'latest.json');
    writeFileSync(path, JSON.stringify({ ok: true }));
    writeFileSync(`${path}.tmp`, 'partial');
    expect(stableReadJson(path)).toBeNull();
    expect(stableReadText(path)).toBeNull();
  });
});

describe('error journal durability', () => {
  it('fsyncs and returns newest-first entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-err-fsync-'));
    process.env.MASTER_STATE_DIR = dir;
    logMasterError({ module: 't', error_type: 'A', message: 'one' });
    logMasterError({ module: 't', error_type: 'B', message: 'two' });
    const rows = loadMasterErrors(10);
    expect(rows[0]!.error_type).toBe('B');
    expect(rows[1]!.error_type).toBe('A');
    expect(existsSync(join(dir, 'error_journal.jsonl'))).toBe(true);
  });
});

describe('decision journal durability', () => {
  it('appends WAIT/TRADE events newest-first and survives reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-dec-fsync-'));
    process.env.MASTER_STATE_DIR = dir;
    logDecisionEvent({
      kind: 'WAIT',
      epic: 'XAUUSD',
      mode: 'PAPER',
      buy_score: 0.4,
      sell_score: 0.2,
      block_reason: 'spread',
      executed: false,
      cycle_ms: 12,
    });
    logDecisionEvent({
      kind: 'BUY',
      epic: 'XAUUSD',
      mode: 'PAPER',
      buy_score: 0.8,
      sell_score: 0.1,
      executed: true,
      execution_detail: 'paper_fill',
      cycle_ms: 18,
    });
    const rows = loadDecisionEvents(10);
    expect(rows[0]!.kind).toBe('BUY');
    expect(rows[0]!.executed).toBe(true);
    expect(rows[1]!.kind).toBe('WAIT');
    expect(rows[1]!.block_reason).toBe('spread');
    expect(existsSync(join(dir, 'decision_journal.jsonl'))).toBe(true);
    const reloaded = loadDecisionEvents(1);
    expect(reloaded[0]!.execution_detail).toBe('paper_fill');
  });
});

describe('trade event journal durability', () => {
  it('appends OPEN/CLOSE newest-first for paper+Capital audit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-trade-evt-'));
    process.env.MASTER_STATE_DIR = dir;
    const { logTradeEvent, loadTradeEvents } = await import('../tradeEventJournal.js');
    logTradeEvent({
      event: 'OPEN',
      broker: 'PAPER',
      epic: 'GOLD',
      side: 'BUY',
      volume: 0.1,
      price: 4400,
      position_id: 'paper-1',
      intent_id: 'i1',
      ok: true,
      detail: 'paper_fill',
    });
    logTradeEvent({
      event: 'CLOSE',
      broker: 'PAPER',
      epic: 'GOLD',
      side: 'BUY',
      volume: 0.1,
      price: 4405,
      position_id: 'paper-1',
      intent_id: 'i1',
      ok: true,
      detail: 'STOP_HIT',
      pnl: 0.45,
      fees: 0.05,
    });
    const rows = loadTradeEvents(10);
    expect(rows[0]!.event).toBe('CLOSE');
    expect(rows[0]!.fees).toBeCloseTo(0.05, 8);
    expect(rows[1]!.event).toBe('OPEN');
    expect(existsSync(join(dir, 'trade_event_journal.jsonl'))).toBe(true);
  });
});

describe('MT4 ack prune + ACK_TIMEOUT error journal', () => {
  it('clearOldAcks archives older ack files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vs-ack-prune-'));
    const broker = new Mt4FileBroker(root);
    await broker.connect();
    mkdirSync(join(root, 'acks'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(root, 'acks', `ack_old${i}.json`),
        JSON.stringify({ id: `old${i}`, ok: true })
      );
    }
    const { utimesSync } = await import('fs');
    const old = new Date(Date.now() - 86_400_000);
    for (let i = 0; i < 5; i++) {
      utimesSync(join(root, 'acks', `ack_old${i}.json`), old, old);
    }
    writeFileSync(
      join(root, 'acks', 'ack_new.json'),
      JSON.stringify({ id: 'new', ok: true })
    );
    const report = broker.clearOldAcks(2);
    expect(report.kept).toBe(2);
    expect(report.pruned).toBe(4);
    expect(existsSync(join(root, 'acks', 'archive'))).toBe(true);
  });

  it('OPEN ack timeout writes error journal row', async () => {
    const prevPolls = process.env.MASTER_MT4_ACK_POLLS;
    const prevMs = process.env.MASTER_MT4_ACK_POLL_MS;
    process.env.MASTER_MT4_ACK_POLLS = '5';
    process.env.MASTER_MT4_ACK_POLL_MS = '20';
    const state = mkdtempSync(join(tmpdir(), 'vs-ack-to-state-'));
    process.env.MASTER_STATE_DIR = state;
    try {
      const root = mkdtempSync(join(tmpdir(), 'vs-ack-to-'));
      const broker = new Mt4FileBroker(root);
      await broker.connect();
      const placed = await broker.placeOrder({
        intent_id: 'timeoutintent000000000001',
        epic: 'XAUUSD',
        side: 'BUY',
        size: 0.01,
      });
      expect(placed.ok).toBe(false);
      expect(placed.detail).toBe('mt4_command_written_ack_timeout');
      const errs = loadMasterErrors(5);
      expect(errs.some((e) => e.error_type === 'ACK_TIMEOUT')).toBe(true);
    } finally {
      if (prevPolls === undefined) delete process.env.MASTER_MT4_ACK_POLLS;
      else process.env.MASTER_MT4_ACK_POLLS = prevPolls;
      if (prevMs === undefined) delete process.env.MASTER_MT4_ACK_POLL_MS;
      else process.env.MASTER_MT4_ACK_POLL_MS = prevMs;
    }
  });
});
