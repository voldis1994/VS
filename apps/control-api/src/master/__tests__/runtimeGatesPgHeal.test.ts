import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('runtime_gates DualPersist heal', () => {
  it('MemoryPersist primary heals wiped runtime_gates sidecar', async () => {
    const {
      MemoryPersist,
      setPersistClient,
      persistRuntimeGatesState,
    } = await import('../persist.js');
    const { DualPersist } = await import('../dualPersist.js');
    const { FilePersist } = await import('../filePersist.js');
    const {
      saveRuntimeGates,
      loadRuntimeGates,
      hydrateRuntimeGatesFromPersist,
    } = await import('../runtimeGates.js');
    const dir = mkdtempSync(join(tmpdir(), 'master-gates-pg-heal-'));
    const prevState = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    const primary = new MemoryPersist();
    try {
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(
        saveRuntimeGates({
          last_loss_ms: 1,
          reject_until_ms: 2,
          desired_running: true,
          mode: 'PAPER',
          epic: 'GOLD',
          kill_switch: true,
          day_start_equity: 12_345,
          peak_equity: 13_000,
          daily_pnl_day: '2026-09-09',
        })
      ).toBe(true);
      await persistRuntimeGatesState({
        last_loss_ms: 1,
        reject_until_ms: 2,
        desired_running: true,
        mode: 'PAPER',
        epic: 'GOLD',
        kill_switch: true,
        day_start_equity: 12_345,
        peak_equity: 13_000,
        daily_pnl_day: '2026-09-09',
        saved_at_ms: Date.now(),
      });
      expect(primary.runtimeGatesPayload?.kill_switch).toBe(true);
      expect(primary.runtimeGatesPayload?.desired_running).toBe(true);
      setPersistClient(null);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(existsSync(join(dir, 'runtime_gates.json'))).toBe(false);
      const healed = await hydrateRuntimeGatesFromPersist(dir);
      expect(healed.restored).toBe(true);
      expect(existsSync(join(dir, 'runtime_gates.json'))).toBe(true);
      const loaded = loadRuntimeGates();
      expect(loaded?.kill_switch).toBe(true);
      expect(loaded?.desired_running).toBe(true);
      expect(loaded?.mode).toBe('PAPER');
      expect(loaded?.epic).toBe('GOLD');
      expect(loaded?.day_start_equity).toBe(12_345);
    } finally {
      setPersistClient(null);
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
      try {
        unlinkSync(join(dir, 'runtime_gates.json'));
      } catch {
        /* ignore */
      }
    }
  });
});
