import { pool } from '../db/pool.js';

export async function logAudit(
  actor: string,
  action: string,
  entityType: string,
  entityId: string | null,
  previousValue?: unknown,
  newValue?: unknown
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_logs (actor, action, entity_type, entity_id, previous_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      actor,
      action,
      entityType,
      entityId,
      previousValue ? JSON.stringify(previousValue) : null,
      newValue ? JSON.stringify(newValue) : null,
    ]
  );
}
