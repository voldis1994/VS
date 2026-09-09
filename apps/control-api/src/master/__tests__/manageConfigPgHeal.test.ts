import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('manage_config DualPersist heal', () => {
  it('MemoryPersist primary heals wiped master_manage_config sidecar', async () => {
    const {
      MemoryPersist,
      setPersistClient,
      persistManageConfigState,
    } = await import('../persist.js');
    const { DualPersist } = await import('../dualPersist.js');
    const { FilePersist } = await import('../filePersist.js');
    const {
      saveManageConfig,
      loadManageConfig,
      hydrateManageConfigFromPersist,
    } = await import('../manageConfig.js');
    const dir = mkdtempSync(join(tmpdir(), 'master-manage-pg-heal-'));
    const prevState = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    const primary = new MemoryPersist();
    try {
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(
        saveManageConfig({
          profit_lock: 88,
          min_score: 0.51,
          require_armed_setup: true,
          soft_trail_money_arm: 0,
        })
      ).toBe(true);
      await persistManageConfigState({
        profit_lock: 88,
        min_score: 0.51,
        require_armed_setup: true,
        soft_trail_money_arm: 0,
        saved_at_ms: Date.now(),
      });
      expect(primary.manageConfigPayload?.profit_lock).toBe(88);
      setPersistClient(null);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(existsSync(join(dir, 'master_manage_config.json'))).toBe(false);
      const healed = await hydrateManageConfigFromPersist(dir);
      expect(healed.restored).toBe(true);
      expect(existsSync(join(dir, 'master_manage_config.json'))).toBe(true);
      const loaded = loadManageConfig();
      expect(loaded?.profit_lock).toBe(88);
      expect(loaded?.min_score).toBe(0.51);
      expect(loaded?.require_armed_setup).toBe(true);
    } finally {
      setPersistClient(null);
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
      try {
        unlinkSync(join(dir, 'master_manage_config.json'));
      } catch {
        /* ignore */
      }
    }
  });
});
