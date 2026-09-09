import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  logTradeEvent,
  loadTradeEvents,
  normalizeTradeDeskSource,
} from '../tradeEventJournal.js';
import { MemoryPersist, setPersistClient } from '../persist.js';
import { setJournalMirror } from '../journalMirror.js';
import { installFilePersist } from '../filePersist.js';

describe('TradeEvent durable desk_entry_source', () => {
  let dir: string;
  const prev = process.env.MASTER_STATE_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trade-desk-'));
    process.env.MASTER_STATE_DIR = dir;
    process.env.MASTER_GATES_DIR = dir;
    installFilePersist(dir);
    setPersistClient(new MemoryPersist());
  });

  afterEach(() => {
    setPersistClient(null);
    setJournalMirror(null);
    if (prev === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prev;
    delete process.env.MASTER_GATES_DIR;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('normalizeTradeDeskSource accepts setup|move|none only', () => {
    expect(normalizeTradeDeskSource('setup')).toBe('setup');
    expect(normalizeTradeDeskSource('move')).toBe('move');
    expect(normalizeTradeDeskSource('none')).toBe('none');
    expect(normalizeTradeDeskSource('other')).toBeNull();
    expect(normalizeTradeDeskSource(null)).toBeNull();
  });

  it('logTradeEvent persists desk_entry_source on jsonl OPEN/CLOSE', () => {
    logTradeEvent({
      event: 'OPEN',
      broker: 'PAPER',
      epic: 'GOLD',
      side: 'BUY',
      volume: 0.1,
      price: 4400,
      position_id: 'p1',
      opportunity_id: 'o1',
      ok: true,
      detail: 'paper_fill',
      desk_entry_source: 'setup',
    });
    logTradeEvent({
      event: 'CLOSE',
      broker: 'PAPER',
      epic: 'GOLD',
      side: 'BUY',
      volume: 0.1,
      price: 4410,
      position_id: 'p1',
      opportunity_id: 'o1',
      ok: true,
      detail: 'TP',
      pnl: 1,
      fees: 0,
      desk_entry_source: 'move',
    });
    const rows = loadTradeEvents(5);
    const close = rows.find((e) => e.event === 'CLOSE');
    const open = rows.find((e) => e.event === 'OPEN');
    expect(open?.desk_entry_source).toBe('setup');
    expect(close?.desk_entry_source).toBe('move');
    const raw = readFileSync(join(dir, 'trade_event_journal.jsonl'), 'utf8');
    expect(raw).toMatch(/"desk_entry_source":"setup"/);
    expect(raw).toMatch(/"desk_entry_source":"move"/);
  });

  it('status recent_trades prefers TradeEvent stamp over missing opp join', async () => {
    const { masterRuntime } = await import('../runtime.js');
    masterRuntime.stop();
    masterRuntime.ensurePaperBroker();
    masterRuntime.setMode('PAPER');
    logTradeEvent({
      event: 'CLOSE',
      broker: 'PAPER',
      epic: 'GOLD',
      side: 'SELL',
      volume: 0.2,
      price: 4390,
      position_id: 'orphan-desk',
      opportunity_id: 'missing-opp',
      ok: true,
      detail: 'TakeProfit',
      pnl: 2,
      fees: 0,
      desk_entry_source: 'setup',
    });
    const st = masterRuntime.status();
    const byOpp = (
      st.recent_trades as Array<{
        opportunity_id?: string | null;
        desk_entry_source?: string | null;
      }>
    ).find((t) => t.opportunity_id === 'missing-opp');
    expect(byOpp?.desk_entry_source).toBe('setup');
    masterRuntime.stop();
  });

  it('verify-gate: migration + persist + runtime stamp wiring', () => {
    const root = join(__dirname, '../..');
    const mig = readFileSync(
      join(root, 'db/migrations/016_master_trade_desk_entry.sql'),
      'utf8'
    );
    expect(mig).toMatch(/master_trade_events/);
    expect(mig).toMatch(/desk_entry_source/);
    const journal = readFileSync(join(__dirname, '../tradeEventJournal.ts'), 'utf8');
    expect(journal).toMatch(/desk_entry_source/);
    expect(journal).toMatch(/normalizeTradeDeskSource/);
    const persist = readFileSync(join(__dirname, '../persist.ts'), 'utf8');
    expect(persist).toMatch(
      /INSERT INTO master_trade_events[\s\S]*desk_entry_source/
    );
    const runtime = readFileSync(join(__dirname, '../runtime.ts'), 'utf8');
    expect(runtime).toMatch(
      /desk_entry_source: cycle\.decision\.desk_entry_source/
    );
    expect(runtime).toMatch(
      /desk_entry_source: pos\.decision\?\.desk_entry_source/
    );
    expect(runtime).toMatch(/normalizeTradeDeskSource\(e\.desk_entry_source\)/);
  });
});
