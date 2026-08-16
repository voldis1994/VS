/**
 * Global trading kill switch — durable in Postgres when available, env fallback.
 * ACTIVE => no new risk approvals / new positions.
 */

import { pool } from '../db/pool.js';

export type KillSwitchState = {
  active: boolean;
  reason: string | null;
  changed_by: string | null;
  updated_at: string | null;
  source: 'database' | 'environment' | 'default';
};

export async function getKillSwitch(): Promise<KillSwitchState> {
  try {
    const { rows } = await pool.query(
      `SELECT active, reason, changed_by, updated_at FROM kill_switch WHERE id = 1 LIMIT 1`
    );
    if (rows[0]) {
      return {
        active: rows[0].active === true,
        reason: rows[0].reason ?? null,
        changed_by: rows[0].changed_by ?? null,
        updated_at: rows[0].updated_at
          ? new Date(rows[0].updated_at).toISOString()
          : null,
        source: 'database',
      };
    }
  } catch {
    /* table may not exist yet — fall through */
  }
  if (process.env.VS_KILL_SWITCH === '1' || process.env.VS_KILL_SWITCH === 'true') {
    return {
      active: true,
      reason: 'VS_KILL_SWITCH env',
      changed_by: 'environment',
      updated_at: null,
      source: 'environment',
    };
  }
  return {
    active: false,
    reason: null,
    changed_by: null,
    updated_at: null,
    source: 'default',
  };
}

export async function setKillSwitch(input: {
  active: boolean;
  reason?: string;
  changed_by: string;
}): Promise<KillSwitchState> {
  const reason = input.reason || (input.active ? 'activated' : 'deactivated');
  try {
    await pool.query(
      `INSERT INTO kill_switch (id, active, reason, changed_by, updated_at)
       VALUES (1, $1, $2, $3, NOW())
       ON CONFLICT (id) DO UPDATE SET
         active = EXCLUDED.active,
         reason = EXCLUDED.reason,
         changed_by = EXCLUDED.changed_by,
         updated_at = NOW()`,
      [input.active, reason, input.changed_by]
    );
  } catch (e) {
    throw new Error(
      `KILL_SWITCH_PERSIST_FAILED: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  return getKillSwitch();
}
