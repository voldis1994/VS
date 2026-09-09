import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installFilePersist, ensureJournalSidecarsFromStateDir } from '../filePersist.js';
import { setPersistClient } from '../persist.js';
import { setJournalMirror } from '../journalMirror.js';
import { logDecisionEvent, loadDecisionEvents } from '../decisionJournal.js';
import { logTradeEvent, loadTradeEvents } from '../tradeEventJournal.js';

describe('DualPersist/FilePersist journal mirror', () => {
  const prevDir = process.env.MASTER_STATE_DIR;
  let dir: string;

  afterEach(() => {
    setPersistClient(null);
    setJournalMirror(null);
    if (prevDir === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prevDir;
    delete process.env.MASTER_GATES_DIR;
  });

  it('mirrors decision/trade into master_state and recovers after jsonl wipe', () => {
    dir = mkdtempSync(join(tmpdir(), 'vs-jmirror-'));
    process.env.MASTER_STATE_DIR = dir;
    process.env.MASTER_GATES_DIR = dir;

    installFilePersist(dir);
    logDecisionEvent({
      kind: 'WAIT',
      epic: 'GOLD',
      mode: 'PAPER',
      opportunity_id: 'opp-m1',
      buy_score: 0.2,
      sell_score: 0.1,
    });
    logTradeEvent({
      event: 'CLOSE',
      broker: 'PAPER',
      epic: 'GOLD',
      side: 'BUY',
      volume: 0.1,
      price: 4410,
      position_id: 'pos-m1',
      opportunity_id: 'opp-m1',
      ok: true,
      detail: 'mirror_test',
      pnl: 1,
      fees: 0,
    });

    const state = JSON.parse(
      readFileSync(join(dir, 'master_state.json'), 'utf8')
    );
    expect(Array.isArray(state.decision_events)).toBe(true);
    expect(state.decision_events.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(state.trade_events)).toBe(true);
    expect(state.trade_events.length).toBeGreaterThanOrEqual(1);

    // Wipe hot jsonl sidecars — DualPersist recovery hole without mirror
    unlinkSync(join(dir, 'decision_journal.jsonl'));
    unlinkSync(join(dir, 'trade_event_journal.jsonl'));
    expect(existsSync(join(dir, 'decision_journal.jsonl'))).toBe(false);

    // In-memory mirror still serves loads
    expect(loadDecisionEvents(5).some((e) => e.opportunity_id === 'opp-m1')).toBe(
      true
    );
    expect(loadTradeEvents(5).some((e) => e.position_id === 'pos-m1')).toBe(true);

    // Fresh process: reinstall from master_state restores jsonl
    setJournalMirror(null);
    setPersistClient(null);
    const healed = ensureJournalSidecarsFromStateDir(dir);
    expect(healed).toBe(true);
    expect(existsSync(join(dir, 'decision_journal.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'trade_event_journal.jsonl'))).toBe(true);

    installFilePersist(dir);
    expect(loadDecisionEvents(5).some((e) => e.opportunity_id === 'opp-m1')).toBe(
      true
    );
    expect(loadTradeEvents(5).some((e) => e.detail === 'mirror_test')).toBe(true);
  });
});
