/**
 * Dual-write MASTER persist — Postgres primary + file mirror for restart recovery
 * when DB is down or unavailable. Standalone still uses file-only via installFilePersist.
 */
import { join } from 'path';
import { pool } from '../db/pool.js';
import { FilePersist, installFilePersist } from './filePersist.js';
import { setPersistClient, type PersistClient } from './persist.js';

let installed = false;

export class DualPersist implements PersistClient {
  constructor(
    private readonly primary: PersistClient,
    private readonly mirror: FilePersist
  ) {}

  async query(sql: string, params: unknown[] = []) {
    const write = /INSERT|UPDATE|DELETE/i.test(sql);
    if (write) {
      let primaryResult: { rows: any[]; rowCount?: number | null } = {
        rows: [],
        rowCount: 0,
      };
      let primaryFailed = false;
      try {
        primaryResult = await this.primary.query(sql, params);
      } catch {
        primaryFailed = true;
      }
      // Mirror is the recovery lifeline — always attempt
      const mirrorResult = await this.mirror.query(sql, params);
      if (primaryFailed) return mirrorResult;
      return primaryResult;
    }

    try {
      return await this.primary.query(sql, params);
    } catch {
      return this.mirror.query(sql, params);
    }
  }
}

/**
 * Install MASTER persistence for control-api:
 * - MASTER_STANDALONE / MASTER_FILE_PERSIST → file only
 * - else → DualPersist (Postgres + file mirror under MASTER_STATE_DIR)
 *
 * Idempotent; skips if a client was already injected (tests).
 */
export function ensureMasterPersist(root?: string): PersistClient | null {
  if (installed) return null;
  if (process.env.MASTER_SKIP_PERSIST_INSTALL === 'true') return null;

  const dir =
    root ||
    process.env.MASTER_STATE_DIR ||
    join(process.cwd(), '.master-state');

  if (
    process.env.MASTER_STANDALONE === 'true' ||
    process.env.MASTER_FILE_PERSIST === 'true'
  ) {
    installed = true;
    return installFilePersist(dir);
  }

  const mirror = new FilePersist(dir);
  const dual = new DualPersist(pool, mirror);
  setPersistClient(dual);
  installed = true;
  return dual;
}

/** Test helper — allow re-install after setPersistClient(null). */
export function resetMasterPersistInstallFlag() {
  installed = false;
}
