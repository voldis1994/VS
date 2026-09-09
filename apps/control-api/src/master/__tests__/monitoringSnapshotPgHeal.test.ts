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

describe('monitoring_snapshot DualPersist heal', () => {
  it('MemoryPersist primary heals wiped monitoring_snapshot sidecar', async () => {
    const {
      MemoryPersist,
      setPersistClient,
      persistMonitoringSnapshotState,
    } = await import('../persist.js');
    const { DualPersist } = await import('../dualPersist.js');
    const { FilePersist } = await import('../filePersist.js');
    const {
      CycleMonitor,
      hydrateMonitoringSnapshotFromPersist,
    } = await import('../monitoring.js');
    const dir = mkdtempSync(join(tmpdir(), 'master-mon-pg-heal-'));
    const prevState = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    const primary = new MemoryPersist();
    try {
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      const mon = new CycleMonitor();
      mon.noteRelativeSpread(2.5);
      mon.noteAlerts(
        [{ code: 'DATA_STALE', level: 'WARN', message: 'pg_heal' }],
        'alert:DATA_STALE'
      );
      mon.noteCycle(42);
      mon.snapshot(900);
      await persistMonitoringSnapshotState({
        timestamp_utc: new Date().toISOString(),
        cycle_latency_ms: 42,
        data_freshness_ms: 900,
        error_count: 0,
        error_rate_per_min: 0,
        instance_health: 'DEGRADED',
        relative_spread: 2.5,
        ack_latency_ms: null,
        entry_block_reason: 'alert:DATA_STALE',
        active_alerts: [
          { code: 'DATA_STALE', level: 'WARN', message: 'pg_heal' },
        ],
        saved_at_ms: Date.now(),
      });
      expect(primary.monitoringSnapshotPayload?.relative_spread).toBe(2.5);
      setPersistClient(null);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(existsSync(join(dir, 'monitoring_snapshot.json'))).toBe(false);
      const healed = await hydrateMonitoringSnapshotFromPersist(dir);
      expect(healed.restored).toBe(true);
      expect(existsSync(join(dir, 'monitoring_snapshot.json'))).toBe(true);
      const raw = JSON.parse(
        readFileSync(join(dir, 'monitoring_snapshot.json'), 'utf8')
      );
      expect(raw.entry_block_reason).toBe('alert:DATA_STALE');
      expect(raw.relative_spread).toBe(2.5);
      const restored = new CycleMonitor();
      expect(restored.hydrateFromDisk(dir)).toBe(true);
      const snap = restored.snapshot(null);
      expect(snap.hydrated).toBe(true);
      expect(snap.entry_block_reason).toBe('alert:DATA_STALE');
      expect(snap.relative_spread).toBe(2.5);
    } finally {
      setPersistClient(null);
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
      try {
        unlinkSync(join(dir, 'monitoring_snapshot.json'));
      } catch {
        /* ignore */
      }
    }
  });
});
