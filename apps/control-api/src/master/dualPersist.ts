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
      const primaryResult = await this.primary.query(sql, params);
      // Postgres up but empty/stale while mirror still has recovery rows —
      // prefer non-empty mirror so restart does not ghost-wipe opens/journal.
      if (
        Array.isArray(primaryResult.rows) &&
        primaryResult.rows.length === 0 &&
        /master_open_positions|master_seen_intents|master_opportunities|master_trade_outcomes|master_decision_events|master_trade_events|master_market_cache|master_epic_cycle_stash|master_runtime_gates|master_manage_config|master_owns_pipeline|master_monitoring_snapshot/i.test(
          sql
        )
      ) {
        const mirrorResult = await this.mirror.query(sql, params);
        if (Array.isArray(mirrorResult.rows) && mirrorResult.rows.length > 0) {
          return mirrorResult;
        }
      }
      // PG may have legacy rows with null pnl_proven while file mirror has false —
      // merge fail-close flags so DualPersist does not invent proven closes.
      if (
        Array.isArray(primaryResult.rows) &&
        primaryResult.rows.length > 0 &&
        /master_trade_outcomes/i.test(sql)
      ) {
        try {
          const mirrorResult = await this.mirror.query(sql, params);
          if (Array.isArray(mirrorResult.rows) && mirrorResult.rows.length > 0) {
            const byKey = new Map<string, any>();
            for (const m of mirrorResult.rows) {
              const k = `${m.opportunity_id}|${m.position_id ?? ''}|${m.created_at ?? ''}`;
              byKey.set(k, m);
              // Also index by opportunity alone (last write wins)
              byKey.set(String(m.opportunity_id), m);
            }
            for (const row of primaryResult.rows) {
              if (row.pnl_proven === false || row.pnl_proven === true) continue;
              const hit =
                byKey.get(
                  `${row.opportunity_id}|${row.position_id ?? ''}|${row.created_at ?? ''}`
                ) || byKey.get(String(row.opportunity_id));
              if (hit && (hit.pnl_proven === false || hit.pnl_proven === true)) {
                row.pnl_proven = hit.pnl_proven;
              }
            }
          }
        } catch {
          /* keep primary */
        }
      }
      return primaryResult;
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
