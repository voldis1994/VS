import { pool } from '../db/pool.js';

export type ActiveSubscription = {
  client_id: number;
  client_name: string;
  account_id: number;
  connection_id: number;
  epic: string;
  display_name: string;
  lot_size: number;
  instrument_id: number;
};

/** Runtime health per client (broker last-ok). */
const brokerHealth = new Map<
  number,
  { last_ok_at: number | null; last_error: string | null }
>();

export function noteBrokerOk(clientId: number): void {
  brokerHealth.set(clientId, { last_ok_at: Date.now(), last_error: null });
}

export function noteBrokerError(clientId: number, error: string): void {
  const prev = brokerHealth.get(clientId);
  brokerHealth.set(clientId, {
    last_ok_at: prev?.last_ok_at ?? null,
    last_error: error,
  });
}

export function getBrokerHealth(clientId: number): {
  last_ok_at: string | null;
  last_error: string | null;
  broker_status: 'CONNECTED' | 'DEGRADED' | 'UNKNOWN';
} {
  const h = brokerHealth.get(clientId);
  if (!h) return { last_ok_at: null, last_error: null, broker_status: 'UNKNOWN' };
  const lastOk = h.last_ok_at;
  const fresh = lastOk != null && Date.now() - lastOk < 60_000;
  return {
    last_ok_at: lastOk ? new Date(lastOk).toISOString() : null,
    last_error: h.last_error,
    broker_status: h.last_error && !fresh ? 'DEGRADED' : fresh ? 'CONNECTED' : 'UNKNOWN',
  };
}

/** All client panel subscriptions with trading enabled (for manage-robot reconcile). */
export async function listAllActiveSubscriptions(): Promise<ActiveSubscription[]> {
  const { rows } = await pool.query(
    `SELECT c.id as client_id, c.name as client_name,
            c.panel_epic, c.panel_display_name, c.panel_lot_size,
            ba.id as account_id, bc.id as connection_id,
            cm.id as instrument_id, cm.epic, cm.display_name, cm.min_lot, cm.max_lot, cm.lot_step,
            ais.lot_size as settings_lot, ais.trading_enabled
     FROM clients c
     JOIN broker_connections bc ON bc.client_id = c.id AND bc.enabled = true
     JOIN broker_accounts ba ON ba.broker_connection_id = bc.id AND ba.enabled = true
     JOIN capital_markets cm ON cm.broker_connection_id = bc.id AND cm.epic = c.panel_epic
     LEFT JOIN account_instrument_settings ais
       ON ais.broker_account_id = ba.id AND ais.instrument_id = cm.id
     WHERE c.enabled = true
       AND c.access_enabled = true
       AND c.panel_robot_requested = 'RUNNING'
       AND c.panel_epic IS NOT NULL
       AND (
         c.preferred_broker_account_id IS NULL
         OR c.preferred_broker_account_id = ba.id
       )
     ORDER BY c.id ASC, ba.id ASC`
  );

  const out: ActiveSubscription[] = [];
  const seenClients = new Set<number>();
  for (const r of rows) {
    const clientId = Number(r.client_id);
    if (seenClients.has(clientId)) continue;
    if (r.trading_enabled === false) continue;
    const lot =
      r.settings_lot != null
        ? Number(r.settings_lot)
        : r.panel_lot_size != null
          ? Number(r.panel_lot_size)
          : Number(r.min_lot);
    out.push({
      client_id: clientId,
      client_name: String(r.client_name),
      account_id: Number(r.account_id),
      connection_id: Number(r.connection_id),
      epic: String(r.epic),
      display_name: String(r.display_name || r.panel_display_name || r.epic),
      lot_size: lot,
      instrument_id: Number(r.instrument_id),
    });
    seenClients.add(clientId);
  }
  return out;
}

export async function listActiveSubscriptionsForEpic(
  epic: string
): Promise<ActiveSubscription[]> {
  const clean = epic.trim();
  if (!clean) return [];

  const { rows } = await pool.query(
    `SELECT c.id as client_id, c.name as client_name,
            c.panel_epic, c.panel_display_name, c.panel_lot_size,
            ba.id as account_id, bc.id as connection_id,
            cm.id as instrument_id, cm.epic, cm.display_name, cm.min_lot, cm.max_lot, cm.lot_step,
            ais.lot_size as settings_lot, ais.trading_enabled
     FROM clients c
     JOIN broker_connections bc ON bc.client_id = c.id AND bc.enabled = true
     JOIN broker_accounts ba ON ba.broker_connection_id = bc.id AND ba.enabled = true
     JOIN capital_markets cm ON cm.broker_connection_id = bc.id AND cm.epic = c.panel_epic
     LEFT JOIN account_instrument_settings ais
       ON ais.broker_account_id = ba.id AND ais.instrument_id = cm.id
     WHERE c.enabled = true
       AND c.access_enabled = true
       AND c.panel_robot_requested = 'RUNNING'
       AND c.panel_epic = $1
       AND (
         c.preferred_broker_account_id IS NULL
         OR c.preferred_broker_account_id = ba.id
       )
     ORDER BY c.id ASC, ba.id ASC`,
    [clean]
  );

  const out: ActiveSubscription[] = [];
  const seenClients = new Set<number>();
  for (const r of rows) {
    const clientId = Number(r.client_id);
    if (seenClients.has(clientId)) continue;
    // Prefer preferred account row; query already filters, take first per client
    if (r.trading_enabled === false) continue;
    const lot =
      r.settings_lot != null
        ? Number(r.settings_lot)
        : r.panel_lot_size != null
          ? Number(r.panel_lot_size)
          : Number(r.min_lot);
    out.push({
      client_id: clientId,
      client_name: String(r.client_name),
      account_id: Number(r.account_id),
      connection_id: Number(r.connection_id),
      epic: String(r.epic),
      display_name: String(r.display_name || r.panel_display_name || r.epic),
      lot_size: lot,
      instrument_id: Number(r.instrument_id),
    });
    seenClients.add(clientId);
  }
  return out;
}

export async function activateSubscription(input: {
  clientId: number;
  accountId: number;
  instrumentId: number;
  epic: string;
  displayName: string;
  lotSize: number;
}): Promise<void> {
  // One active market per account for Client Panel subscriptions
  await pool.query(
    `UPDATE account_instrument_settings
     SET trading_enabled = false, updated_at = NOW()
     WHERE broker_account_id = $1 AND instrument_id <> $2`,
    [input.accountId, input.instrumentId]
  );
  await pool.query(
    `INSERT INTO account_instrument_settings
       (broker_account_id, instrument_id, symbol, lot_size, enabled, trading_enabled)
     VALUES ($1, $2, $3, $4, true, true)
     ON CONFLICT (broker_account_id, instrument_id) DO UPDATE SET
       symbol = EXCLUDED.symbol,
       lot_size = EXCLUDED.lot_size,
       enabled = true,
       trading_enabled = true,
       updated_at = NOW()`,
    [input.accountId, input.instrumentId, input.epic, input.lotSize]
  );
  await pool.query(
    `UPDATE clients SET
       panel_epic = $2,
       panel_display_name = $3,
       panel_lot_size = $4,
       panel_robot_requested = 'RUNNING',
       updated_at = NOW()
     WHERE id = $1`,
    [input.clientId, input.epic, input.displayName, input.lotSize]
  );
}

export async function deactivateSubscription(input: {
  clientId: number;
  accountId: number;
  instrumentId: number | null;
}): Promise<void> {
  if (input.instrumentId != null) {
    await pool.query(
      `UPDATE account_instrument_settings
       SET trading_enabled = false, updated_at = NOW()
       WHERE broker_account_id = $1 AND instrument_id = $2`,
      [input.accountId, input.instrumentId]
    );
  }
  await pool.query(
    `UPDATE clients SET panel_robot_requested = 'STOPPED', updated_at = NOW() WHERE id = $1`,
    [input.clientId]
  );
}
