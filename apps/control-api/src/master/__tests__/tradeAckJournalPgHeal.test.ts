import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  readFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('trade_ack_journal DualPersist heal', () => {
  it('MemoryPersist primary heals wiped trade_ack_journal sidecar', async () => {
    const {
      MemoryPersist,
      setPersistClient,
      persistTradeAckJournalState,
    } = await import('../persist.js');
    const { DualPersist } = await import('../dualPersist.js');
    const { FilePersist } = await import('../filePersist.js');
    const {
      logTradeIntent,
      updateTradeAck,
      loadTradeAckJournal,
      hydrateTradeAckJournalFromPersist,
      findOpenSuccessUnbooked,
    } = await import('../tradeAckJournal.js');
    const dir = mkdtempSync(join(tmpdir(), 'master-trade-ack-pg-heal-'));
    const prevState = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    const primary = new MemoryPersist();
    try {
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(
        logTradeIntent({
          command_id: 'cmd-1',
          intent_id: 'intent-1',
          action: 'OPEN',
          side: 'BUY',
          volume: 0.1,
          epic: 'EURUSD',
          sl: 1.08,
          tp: 1.09,
          reason: 'INTENT',
        })
      ).toBe(true);
      expect(
        updateTradeAck('cmd-1', {
          ack_status: 'SUCCESS',
          ticket: 'T-99',
          fill_price: 1.085,
          detail: 'ACK',
        })
      ).toBe(true);
      expect(existsSync(join(dir, 'trade_ack_journal.json'))).toBe(true);
      await persistTradeAckJournalState({
        records: {
          'cmd-1': {
            command_id: 'cmd-1',
            intent_id: 'intent-1',
            action: 'OPEN',
            side: 'BUY',
            volume: 0.1,
            epic: 'EURUSD',
            ack_status: 'SUCCESS',
            ticket: 'T-99',
            fill_price: 1.085,
            sl: 1.08,
            tp: 1.09,
            reason: 'ACK',
            ts_intent: new Date().toISOString(),
            ts_ack: new Date().toISOString(),
          },
        },
        saved_at_ms: Date.now(),
      });
      expect(
        primary.tradeAckJournalPayload?.records?.['cmd-1']?.ticket
      ).toBe('T-99');
      setPersistClient(null);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(existsSync(join(dir, 'trade_ack_journal.json'))).toBe(false);
      const healed = await hydrateTradeAckJournalFromPersist(dir);
      expect(healed.restored).toBe(true);
      expect(healed.count).toBeGreaterThanOrEqual(1);
      expect(existsSync(join(dir, 'trade_ack_journal.json'))).toBe(true);
      const rows = loadTradeAckJournal();
      expect(rows.some((r) => r.ticket === 'T-99')).toBe(true);
      expect(findOpenSuccessUnbooked(new Set()).map((r) => r.ticket)).toEqual([
        'T-99',
      ]);
      const raw = JSON.parse(
        readFileSync(join(dir, 'trade_ack_journal.json'), 'utf8')
      );
      expect(raw['cmd-1']?.ticket).toBe('T-99');
    } finally {
      setPersistClient(null);
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
      try {
        unlinkSync(join(dir, 'trade_ack_journal.json'));
      } catch {
        /* ignore */
      }
    }
  });
});
