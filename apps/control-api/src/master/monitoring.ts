/**
 * Cycle / bridge monitoring snapshot — Reader monitoring_store pattern.
 * Lightweight: last tick latency, error tail count, data freshness.
 */
import { loadMasterErrors } from './errorJournal.js';

export type CycleMonitorSnapshot = {
  last_cycle_ms: number;
  last_cycle_at: string | null;
  cycles: number;
  error_count: number;
  data_freshness_ms: number | null;
  relative_spread: number | null;
};

export class CycleMonitor {
  last_cycle_ms = 0;
  last_cycle_at: string | null = null;
  cycles = 0;
  relative_spread: number | null = null;

  noteCycle(ms: number) {
    this.last_cycle_ms = Math.max(0, Math.round(ms));
    this.last_cycle_at = new Date().toISOString();
    this.cycles += 1;
  }

  noteRelativeSpread(rel: number | null) {
    this.relative_spread =
      rel != null && Number.isFinite(rel) ? Number(rel) : null;
  }

  snapshot(quoteAgeMs: number | null = null): CycleMonitorSnapshot {
    return {
      last_cycle_ms: this.last_cycle_ms,
      last_cycle_at: this.last_cycle_at,
      cycles: this.cycles,
      error_count: loadMasterErrors(200).length,
      data_freshness_ms:
        quoteAgeMs != null && Number.isFinite(quoteAgeMs)
          ? Math.max(0, Math.round(quoteAgeMs))
          : null,
      relative_spread: this.relative_spread,
    };
  }
}
