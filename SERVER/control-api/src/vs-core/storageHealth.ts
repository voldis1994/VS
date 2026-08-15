/**
 * SSD / storage health — free space monitoring; rotate secondary data before crash.
 */

import { existsSync, mkdirSync, statfsSync } from 'fs';

export type StorageHealth = {
  ok: boolean;
  warning: boolean;
  detail: string;
  reason_code: string | null;
  free_bytes?: number;
  total_bytes?: number;
};

/** Warn below 10GB; critical below 2GB. */
export const STORAGE_WARN_BYTES = 10 * 1024 * 1024 * 1024;
export const STORAGE_CRITICAL_BYTES = 2 * 1024 * 1024 * 1024;

export function checkStorageHealth(path: string): StorageHealth {
  try {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
    // Node 18.15+ / 22: statfsSync
    const st = statfsSync(path);
    const free = st.bavail * st.bsize;
    const total = st.blocks * st.bsize;
    if (free < STORAGE_CRITICAL_BYTES) {
      return {
        ok: false,
        warning: false,
        detail: `free=${free} critical`,
        reason_code: 'STORAGE_CRITICAL_LOW',
        free_bytes: free,
        total_bytes: total,
      };
    }
    if (free < STORAGE_WARN_BYTES) {
      return {
        ok: true,
        warning: true,
        detail: `free=${free} low`,
        reason_code: 'STORAGE_LOW',
        free_bytes: free,
        total_bytes: total,
      };
    }
    return {
      ok: true,
      warning: false,
      detail: `free=${free}`,
      reason_code: null,
      free_bytes: free,
      total_bytes: total,
    };
  } catch (e) {
    return {
      ok: false,
      warning: false,
      detail: e instanceof Error ? e.message : String(e),
      reason_code: 'STORAGE_CHECK_FAILED',
    };
  }
}
