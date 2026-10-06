import { pool } from '../db/pool.js';

export type PersistedRobot = {
  id: string;
  account_id: number;
  epic: string;
  display_name: string | null;
  lot_size: number;
  trading_enabled: boolean;
  entry_enabled: boolean;
};

export async function markRobotDesiredRunning(input: {
  id: string;
  account_id: number;
  epic: string;
  display_name?: string;
  lot_size: number;
  trading_enabled?: boolean;
  entry_enabled?: boolean;
}): Promise<void> {
  await pool.query(
    `INSERT INTO robot_desk_persist
       (id, account_id, epic, display_name, lot_size, trading_enabled, entry_enabled, desired_running, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW())
     ON CONFLICT (id) DO UPDATE SET
       account_id = EXCLUDED.account_id,
       epic = EXCLUDED.epic,
       display_name = EXCLUDED.display_name,
       lot_size = EXCLUDED.lot_size,
       trading_enabled = EXCLUDED.trading_enabled,
       entry_enabled = EXCLUDED.entry_enabled,
       desired_running = true,
       updated_at = NOW()`,
    [
      input.id,
      input.account_id,
      input.epic,
      input.display_name || null,
      input.lot_size,
      input.trading_enabled !== false,
      input.entry_enabled !== false,
    ]
  );
}

export async function markRobotDesiredStopped(id: string): Promise<void> {
  await pool.query(
    `UPDATE robot_desk_persist
     SET desired_running = false, updated_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

export async function listDesiredRunningRobots(): Promise<PersistedRobot[]> {
  const { rows } = await pool.query(
    `SELECT id, account_id, epic, display_name, lot_size, trading_enabled, entry_enabled
     FROM robot_desk_persist
     WHERE desired_running = true
     ORDER BY updated_at ASC`
  );
  return rows.map((r) => ({
    id: String(r.id),
    account_id: Number(r.account_id),
    epic: String(r.epic),
    display_name: r.display_name != null ? String(r.display_name) : null,
    lot_size: Number(r.lot_size),
    trading_enabled: r.trading_enabled !== false,
    entry_enabled: r.entry_enabled !== false,
  }));
}

export async function countPersistedClients(): Promise<{
  clients: number;
  running_panel: number;
  brokers: number;
}> {
  const [c, r, b] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM clients`),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM clients WHERE panel_robot_requested = 'RUNNING'`
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM broker_connections`),
  ]);
  return {
    clients: c.rows[0]?.n ?? 0,
    running_panel: r.rows[0]?.n ?? 0,
    brokers: b.rows[0]?.n ?? 0,
  };
}
