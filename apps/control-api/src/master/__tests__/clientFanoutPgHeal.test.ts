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

describe('client_fanout DualPersist heal', () => {
  it('MemoryPersist primary heals wiped client_fanout sidecar', async () => {
    const {
      MemoryPersist,
      setPersistClient,
      persistClientFanoutState,
    } = await import('../persist.js');
    const { DualPersist } = await import('../dualPersist.js');
    const { FilePersist } = await import('../filePersist.js');
    const {
      saveClientFanoutSummary,
      hydrateClientFanoutFromPersist,
      loadClientFanoutSummary,
    } = await import('../masterClientFanout.js');
    const dir = mkdtempSync(join(tmpdir(), 'master-fanout-pg-heal-'));
    const prevState = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    const primary = new MemoryPersist();
    try {
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(
        saveClientFanoutSummary({
          attempted: true,
          subscribers: 2,
          ok_count: 1,
          fail_count: 1,
          detail: 'ok=1/2',
          journaled_count: 1,
        })
      ).toBe(true);
      expect(existsSync(join(dir, 'client_fanout.json'))).toBe(true);
      await persistClientFanoutState({
        attempted: true,
        subscribers: 2,
        ok_count: 1,
        fail_count: 1,
        detail: 'ok=1/2',
        journaled_count: 1,
        saved_at_ms: Date.now(),
      });
      expect(primary.clientFanoutPayload?.ok_count).toBe(1);
      setPersistClient(null);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(existsSync(join(dir, 'client_fanout.json'))).toBe(false);
      const healed = await hydrateClientFanoutFromPersist(dir);
      expect(healed.restored).toBe(true);
      expect(healed.summary?.ok_count).toBe(1);
      expect(existsSync(join(dir, 'client_fanout.json'))).toBe(true);
      expect(loadClientFanoutSummary()?.detail).toContain('ok=1/2');
      const raw = JSON.parse(
        readFileSync(join(dir, 'client_fanout.json'), 'utf8')
      );
      expect(raw.attempted).toBe(true);
    } finally {
      setPersistClient(null);
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
      try {
        unlinkSync(join(dir, 'client_fanout.json'));
      } catch {
        /* ignore */
      }
    }
  });
});
