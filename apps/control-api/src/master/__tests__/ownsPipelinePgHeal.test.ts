import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('owns_pipeline DualPersist heal', () => {
  it('MemoryPersist primary heals wiped owns_pipeline sidecar', async () => {
    const {
      MemoryPersist,
      setPersistClient,
      persistOwnsPipelineState,
    } = await import('../persist.js');
    const { DualPersist } = await import('../dualPersist.js');
    const { FilePersist } = await import('../filePersist.js');
    const {
      saveOwnsPipelinePref,
      loadOwnsPipelinePref,
      hydrateOwnsPipelineFromPersist,
    } = await import('../ownsPipelinePref.js');
    const dir = mkdtempSync(join(tmpdir(), 'master-owns-pg-heal-'));
    const prevState = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    const primary = new MemoryPersist();
    try {
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(saveOwnsPipelinePref(true)).toBe(true);
      await persistOwnsPipelineState({
        owns_pipeline: true,
        saved_at_ms: Date.now(),
      });
      expect(primary.ownsPipelinePayload?.owns_pipeline).toBe(true);
      setPersistClient(null);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(existsSync(join(dir, 'owns_pipeline.json'))).toBe(false);
      const healed = await hydrateOwnsPipelineFromPersist(dir);
      expect(healed.restored).toBe(true);
      expect(existsSync(join(dir, 'owns_pipeline.json'))).toBe(true);
      expect(loadOwnsPipelinePref(dir)).toBe(true);
    } finally {
      setPersistClient(null);
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
      try {
        unlinkSync(join(dir, 'owns_pipeline.json'));
      } catch {
        /* ignore */
      }
    }
  });
});
