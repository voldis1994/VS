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

describe('spread_history DualPersist heal', () => {
  it('MemoryPersist primary heals wiped spread_history sidecar', async () => {
    const {
      MemoryPersist,
      setPersistClient,
      persistSpreadHistoryState,
    } = await import('../persist.js');
    const { DualPersist } = await import('../dualPersist.js');
    const { FilePersist } = await import('../filePersist.js');
    const {
      SpreadHistory,
      hydrateSpreadHistoryFromPersist,
    } = await import('../spreadModel.js');
    const dir = mkdtempSync(join(tmpdir(), 'master-spread-pg-heal-'));
    const prevState = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    const primary = new MemoryPersist();
    try {
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      const hist = new SpreadHistory(20);
      for (const s of [0.3, 0.35, 0.4, 0.38, 0.42]) hist.push(s);
      expect(existsSync(join(dir, 'spread_history.json'))).toBe(true);
      await persistSpreadHistoryState({
        lookback: 20,
        history: [0.3, 0.35, 0.4, 0.38, 0.42],
        ts: new Date().toISOString(),
        saved_at_ms: Date.now(),
      });
      expect(primary.spreadHistoryPayload?.history?.length).toBeGreaterThanOrEqual(
        3
      );
      setPersistClient(null);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(existsSync(join(dir, 'spread_history.json'))).toBe(false);
      const healed = await hydrateSpreadHistoryFromPersist(dir);
      expect(healed.restored).toBe(true);
      expect(healed.count).toBeGreaterThanOrEqual(3);
      expect(existsSync(join(dir, 'spread_history.json'))).toBe(true);
      const raw = JSON.parse(
        readFileSync(join(dir, 'spread_history.json'), 'utf8')
      );
      expect(raw.history.length).toBeGreaterThanOrEqual(3);
      const restored = new SpreadHistory(20);
      expect(restored.load(dir)).toBeGreaterThanOrEqual(3);
    } finally {
      setPersistClient(null);
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
      try {
        unlinkSync(join(dir, 'spread_history.json'));
      } catch {
        /* ignore */
      }
    }
  });
});
