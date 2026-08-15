/**
 * Server clock sync / drift monitoring.
 */

export type TimeSyncResult = {
  ok: boolean;
  drift_ms: number;
  detail: string;
  source: string;
};

/** Max acceptable drift vs reference (ms). */
export const MAX_DRIFT_MS = 2000;

/**
 * Check clock. Optional referenceEpochMs from NTP/HTTP Date.
 * Without external reference, we can only sanity-check Date.parse integrity —
 * do NOT claim TIME OK for LIVE without reference (caller must supply).
 */
export function checkTimeSync(opts?: {
  referenceEpochMs?: number;
  now?: number;
  requireReference?: boolean;
}): TimeSyncResult {
  const now = opts?.now ?? Date.now();
  if (!Number.isFinite(now) || now < 1_600_000_000_000) {
    return {
      ok: false,
      drift_ms: NaN,
      detail: 'System clock nonsense (pre-2020)',
      source: 'local',
    };
  }
  if (opts?.referenceEpochMs != null) {
    const drift = Math.abs(now - opts.referenceEpochMs);
    if (drift > MAX_DRIFT_MS) {
      return {
        ok: false,
        drift_ms: drift,
        detail: `TIME_SYNC_ERROR drift ${drift}ms > ${MAX_DRIFT_MS}ms`,
        source: 'reference',
      };
    }
    return {
      ok: true,
      drift_ms: drift,
      detail: `synced drift=${drift}ms`,
      source: 'reference',
    };
  }
  if (opts?.requireReference) {
    return {
      ok: false,
      drift_ms: 0,
      detail: 'TIME_SYNC_ERROR — no NTP/reference provided',
      source: 'none',
    };
  }
  // Dev/unit: local clock present
  return {
    ok: true,
    drift_ms: 0,
    detail: 'local clock accepted (no external reference)',
    source: 'local',
  };
}
