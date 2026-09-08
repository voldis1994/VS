/**
 * Cycle / bridge monitoring snapshot — Reader monitoring_store pattern.
 * Tracks latency, freshness, relative spread, alerts, and persists last snapshot.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { loadMasterErrors } from './errorJournal.js';
import type { CycleAlert } from './cycleAlerts.js';
import { healthFromAlerts } from './cycleAlerts.js';

export type CycleMonitorSnapshot = {
  last_cycle_ms: number;
  last_cycle_at: string | null;
  cycles: number;
  error_count: number;
  error_rate_per_min: number;
  data_freshness_ms: number | null;
  relative_spread: number | null;
  instance_health: 'OK' | 'DEGRADED' | 'CRITICAL';
  active_alerts: CycleAlert[];
  entry_block_reason: string | null;
};

function stateDir(): string {
  return (
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function snapshotPath(): string {
  return join(stateDir(), 'monitoring_snapshot.json');
}

export class CycleMonitor {
  last_cycle_ms = 0;
  last_cycle_at: string | null = null;
  cycles = 0;
  relative_spread: number | null = null;
  private lastAlerts: CycleAlert[] = [];
  private lastEntryBlock: string | null = null;

  noteCycle(ms: number) {
    this.last_cycle_ms = Math.max(0, Math.round(ms));
    this.last_cycle_at = new Date().toISOString();
    this.cycles += 1;
  }

  noteRelativeSpread(rel: number | null) {
    this.relative_spread =
      rel != null && Number.isFinite(rel) ? Number(rel) : null;
  }

  noteAlerts(alerts: CycleAlert[], entryBlock: string | null) {
    this.lastAlerts = alerts;
    this.lastEntryBlock = entryBlock;
  }

  /** Errors in the last 60s → rate per minute. */
  errorRatePerMin(nowMs = Date.now()): number {
    const errs = loadMasterErrors(200);
    const recent = errs.filter((e) => {
      const t = Date.parse(e.ts);
      return Number.isFinite(t) && nowMs - t <= 60_000;
    });
    return recent.length;
  }

  snapshot(quoteAgeMs: number | null = null): CycleMonitorSnapshot {
    const error_count = loadMasterErrors(200).length;
    const error_rate_per_min = this.errorRatePerMin();
    const snap: CycleMonitorSnapshot = {
      last_cycle_ms: this.last_cycle_ms,
      last_cycle_at: this.last_cycle_at,
      cycles: this.cycles,
      error_count,
      error_rate_per_min,
      data_freshness_ms:
        quoteAgeMs != null && Number.isFinite(quoteAgeMs)
          ? Math.max(0, Math.round(quoteAgeMs))
          : null,
      relative_spread: this.relative_spread,
      instance_health: healthFromAlerts(this.lastAlerts),
      active_alerts: this.lastAlerts.slice(0, 8),
      entry_block_reason: this.lastEntryBlock,
    };
    this.persistSnapshot(snap);
    return snap;
  }

  /** Durable last metrics — survives restart for dashboard honesty. */
  persistSnapshot(snap: CycleMonitorSnapshot) {
    try {
      mkdirSync(stateDir(), { recursive: true });
      const path = snapshotPath();
      const tmp = `${path}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify(
          {
            timestamp_utc: new Date().toISOString(),
            cycle_latency_ms: snap.last_cycle_ms,
            data_freshness_ms: snap.data_freshness_ms,
            error_count: snap.error_count,
            error_rate_per_min: snap.error_rate_per_min,
            instance_health: snap.instance_health,
            relative_spread: snap.relative_spread,
            entry_block_reason: snap.entry_block_reason,
            active_alerts: snap.active_alerts,
          },
          null,
          0
        ),
        'utf8'
      );
      const fd = openSync(tmp, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch {
      try {
        unlinkSync(`${snapshotPath()}.tmp`);
      } catch {
        /* ignore */
      }
    }
  }

  loadPersisted(): Record<string, unknown> | null {
    try {
      const path = snapshotPath();
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Restart hydrate — seed last metrics/alerts so dashboard is not cold-empty
   * until the first tick. Does not invent cycles count (unknown after crash).
   */
  hydrateFromDisk(): boolean {
    const raw = this.loadPersisted();
    if (!raw) return false;
    if (typeof raw.cycle_latency_ms === 'number' && Number.isFinite(raw.cycle_latency_ms)) {
      this.last_cycle_ms = Math.max(0, Math.round(raw.cycle_latency_ms));
    }
    if (typeof raw.timestamp_utc === 'string' && raw.timestamp_utc) {
      this.last_cycle_at = raw.timestamp_utc;
    }
    if (typeof raw.relative_spread === 'number' && Number.isFinite(raw.relative_spread)) {
      this.relative_spread = Number(raw.relative_spread);
    }
    if (Array.isArray(raw.active_alerts)) {
      this.lastAlerts = raw.active_alerts as CycleAlert[];
    }
    if (
      typeof raw.entry_block_reason === 'string' ||
      raw.entry_block_reason === null
    ) {
      this.lastEntryBlock =
        raw.entry_block_reason == null ? null : String(raw.entry_block_reason);
    }
    return true;
  }
}
