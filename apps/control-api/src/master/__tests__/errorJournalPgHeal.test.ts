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

describe('error_journal DualPersist heal', () => {
  it('MemoryPersist primary heals wiped error_journal sidecar', async () => {
    const {
      MemoryPersist,
      setPersistClient,
      persistErrorJournalState,
    } = await import('../persist.js');
    const { DualPersist } = await import('../dualPersist.js');
    const { FilePersist } = await import('../filePersist.js');
    const {
      logMasterError,
      loadMasterErrors,
      hydrateErrorJournalFromPersist,
    } = await import('../errorJournal.js');
    const dir = mkdtempSync(join(tmpdir(), 'master-error-pg-heal-'));
    const prevState = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    const primary = new MemoryPersist();
    try {
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      logMasterError({
        module: 'heal_test',
        error_type: 'UNIT',
        message: 'error journal heal proof',
      });
      expect(existsSync(join(dir, 'error_journal.jsonl'))).toBe(true);
      expect(primary.errorJournalPayload?.entries?.length).toBeGreaterThanOrEqual(
        1
      );
      await persistErrorJournalState({
        entries: [
          {
            error_id: 'err-1',
            ts: new Date().toISOString(),
            module: 'heal_test',
            error_type: 'UNIT',
            message: 'error journal heal proof',
            context: null,
          },
        ],
        saved_at_ms: Date.now(),
      });
      expect(primary.errorJournalPayload?.entries?.[0]?.error_id).toBe('err-1');
      setPersistClient(null);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(existsSync(join(dir, 'error_journal.jsonl'))).toBe(false);
      const healed = await hydrateErrorJournalFromPersist(dir);
      expect(healed.restored).toBe(true);
      expect(healed.count).toBeGreaterThanOrEqual(1);
      expect(existsSync(join(dir, 'error_journal.jsonl'))).toBe(true);
      const rows = loadMasterErrors(10);
      expect(rows.some((r) => r.error_id === 'err-1')).toBe(true);
      const raw = readFileSync(join(dir, 'error_journal.jsonl'), 'utf8');
      expect(raw).toContain('err-1');
    } finally {
      setPersistClient(null);
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
      try {
        unlinkSync(join(dir, 'error_journal.jsonl'));
      } catch {
        /* ignore */
      }
    }
  });
});
