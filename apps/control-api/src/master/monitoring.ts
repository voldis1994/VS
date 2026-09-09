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
import {
  persistMonitoringSnapshotState,
  loadMonitoringSnapshotFromPersist,
} from './persist.js';
import { embedOperatorMetaPatch } from './operatorMetaEmbed.js';

export type CycleMonitorSnapshot = {
  last_cycle_ms: number;
  last_cycle_at: string | null;
  cycles: number;
  error_count: number;
  error_rate_per_min: number;
  data_freshness_ms: number | null;
  relative_spread: number | null;
  /** INTENT→ACK / confirm latency from last OPEN attempt (ms); null if none yet */
  ack_latency_ms: number | null;
  instance_health: 'OK' | 'DEGRADED' | 'CRITICAL';
  active_alerts: CycleAlert[];
  entry_block_reason: string | null;
  /** True when metrics came from monitoring_snapshot.json and no live cycle yet */
  hydrated: boolean;
};

function stateDir(root?: string): string {
  return (
    root ||
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function snapshotPath(root?: string): string {
  return join(stateDir(root), 'monitoring_snapshot.json');
}

export type MonitoringDiskPayload = {
  timestamp_utc: string;
  cycle_latency_ms: number;
  data_freshness_ms: number | null;
  error_count: number;
  error_rate_per_min: number;
  instance_health: string;
  relative_spread: number | null;
  ack_latency_ms: number | null;
  entry_block_reason: string | null;
  active_alerts: CycleAlert[];
};

function diskPayloadFromSnap(snap: CycleMonitorSnapshot): MonitoringDiskPayload {
  return {
    timestamp_utc: new Date().toISOString(),
    cycle_latency_ms: snap.last_cycle_ms,
    data_freshness_ms: snap.data_freshness_ms,
    error_count: snap.error_count,
    error_rate_per_min: snap.error_rate_per_min,
    instance_health: snap.instance_health,
    relative_spread: snap.relative_spread,
    ack_latency_ms: snap.ack_latency_ms,
    entry_block_reason: snap.entry_block_reason,
    active_alerts: snap.active_alerts,
  };
}

function writeDiskPayload(path: string, payload: MonitoringDiskPayload): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 0), 'utf8');
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export class CycleMonitor {
  last_cycle_ms = 0;
  last_cycle_at: string | null = null;
  cycles = 0;
  relative_spread: number | null = null;
  ack_latency_ms: number | null = null;
  /** Disk restore — cleared on first live note* so cards stop looking current. */
  private fromDisk = false;
  private lastAlerts: CycleAlert[] = [];
  private lastEntryBlock: string | null = null;

  private markLive() {
    this.fromDisk = false;
  }

  noteCycle(ms: number) {
    this.markLive();
    this.last_cycle_ms = Math.max(0, Math.round(ms));
    this.last_cycle_at = new Date().toISOString();
    this.cycles += 1;
  }

  noteAckLatency(ms: number | null) {
    this.markLive();
    if (ms == null || !Number.isFinite(ms) || ms < 0) {
      this.ack_latency_ms = null;
      return;
    }
    this.ack_latency_ms = Math.max(0, Math.round(ms));
  }

  noteRelativeSpread(rel: number | null) {
    this.markLive();
    this.relative_spread =
      rel != null && Number.isFinite(rel) ? Number(rel) : null;
  }

  noteAlerts(alerts: CycleAlert[], entryBlock: string | null) {
    this.markLive();
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
      ack_latency_ms: this.ack_latency_ms,
      instance_health: healthFromAlerts(this.lastAlerts),
      active_alerts: this.lastAlerts.slice(0, 8),
      entry_block_reason: this.lastEntryBlock,
      hydrated: this.fromDisk,
    };
    this.persistSnapshot(snap);
    return snap;
  }

  /** Durable last metrics — survives restart for dashboard honesty. */
  persistSnapshot(snap: CycleMonitorSnapshot) {
    try {
      mkdirSync(stateDir(), { recursive: true });
      const path = snapshotPath();
      const payload = diskPayloadFromSnap(snap);
      writeDiskPayload(path, payload);
      // Keep operator_meta in sync even when no position write flushes FilePersist
      embedOperatorMetaPatch({ monitoring_snapshot: payload as unknown as Record<string, unknown> });
      // DualPersist / MemoryPersist / PG primary — survive full file wipe
      void persistMonitoringSnapshotState({
        ...payload,
        saved_at_ms: Date.now(),
      }).catch(() => {});
    } catch {
      try {
        unlinkSync(`${snapshotPath()}.tmp`);
      } catch {
        /* ignore */
      }
    }
  }

  loadPersisted(root?: string): Record<string, unknown> | null {
    try {
      const path = snapshotPath(root);
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Restart hydrate — seed last metrics/alerts so dashboard is not cold-empty
   * until the first tick. Does not invent cycles count (unknown after crash).
   * Marks fromDisk so Why / Alert block / Rel spread do not paint as live.
   */
  hydrateFromDisk(root?: string): boolean {
    const raw = this.loadPersisted(root);
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
    if (typeof raw.ack_latency_ms === 'number' && Number.isFinite(raw.ack_latency_ms)) {
      this.ack_latency_ms = Math.max(0, Math.round(raw.ack_latency_ms));
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
    this.fromDisk = true;
    return true;
  }
}

/**
 * When monitoring_snapshot.json was wiped but DualPersist/PG primary still
 * holds the singleton payload, rewrite the sidecar before disk hydrate.
 */
export async function hydrateMonitoringSnapshotFromPersist(
  root?: string
): Promise<{ restored: boolean }> {
  const dir = stateDir(root);
  const path = snapshotPath(root);
  if (existsSync(path)) return { restored: false };
  try {
    const loaded = await loadMonitoringSnapshotFromPersist();
    if (!loaded || typeof loaded !== 'object') return { restored: false };
    const hasSignal =
      typeof loaded.cycle_latency_ms === 'number' ||
      typeof loaded.relative_spread === 'number' ||
      typeof loaded.entry_block_reason === 'string' ||
      (Array.isArray(loaded.active_alerts) && loaded.active_alerts.length > 0);
    if (!hasSignal) return { restored: false };
    const payload: MonitoringDiskPayload = {
      timestamp_utc:
        typeof loaded.timestamp_utc === 'string' && loaded.timestamp_utc
          ? loaded.timestamp_utc
          : new Date().toISOString(),
      cycle_latency_ms:
        typeof loaded.cycle_latency_ms === 'number' &&
        Number.isFinite(loaded.cycle_latency_ms)
          ? Math.max(0, Math.round(loaded.cycle_latency_ms))
          : 0,
      data_freshness_ms:
        typeof loaded.data_freshness_ms === 'number' &&
        Number.isFinite(loaded.data_freshness_ms)
          ? loaded.data_freshness_ms
          : null,
      error_count:
        typeof loaded.error_count === 'number' && Number.isFinite(loaded.error_count)
          ? Math.max(0, Math.floor(loaded.error_count))
          : 0,
      error_rate_per_min:
        typeof loaded.error_rate_per_min === 'number' &&
        Number.isFinite(loaded.error_rate_per_min)
          ? loaded.error_rate_per_min
          : 0,
      instance_health:
        typeof loaded.instance_health === 'string' && loaded.instance_health
          ? String(loaded.instance_health)
          : 'OK',
      relative_spread:
        typeof loaded.relative_spread === 'number' &&
        Number.isFinite(loaded.relative_spread)
          ? Number(loaded.relative_spread)
          : null,
      ack_latency_ms:
        typeof loaded.ack_latency_ms === 'number' &&
        Number.isFinite(loaded.ack_latency_ms)
          ? Math.max(0, Math.round(loaded.ack_latency_ms))
          : null,
      entry_block_reason:
        loaded.entry_block_reason == null
          ? null
          : String(loaded.entry_block_reason),
      active_alerts: Array.isArray(loaded.active_alerts)
        ? (loaded.active_alerts as CycleAlert[])
        : [],
    };
    mkdirSync(dir, { recursive: true });
    writeDiskPayload(path, payload);
    embedOperatorMetaPatch(
      { monitoring_snapshot: payload as unknown as Record<string, unknown> },
      dir
    );
    return { restored: true };
  } catch {
    return { restored: false };
  }
}
