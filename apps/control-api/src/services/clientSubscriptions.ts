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
  budget_pct: number;
  category: string;
  min_lot: number;
  max_lot: number;
  lot_step: number;
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

function mapSubRow(r: Record<string, unknown>): ActiveSubscription {
  const lot =
    r.settings_lot != null
      ? Number(r.settings_lot)
      : r.panel_lot_size != null
        ? Number(r.panel_lot_size)
        : Number(r.min_lot);
  const budget =
    r.panel_budget_pct != null && Number.isFinite(Number(r.panel_budget_pct))
      ? Number(r.panel_budget_pct)
      : 25;
  const epic = String(r.epic);
  return {
    client_id: Number(r.client_id),
    client_name: String(r.client_name),
    account_id: Number(r.account_id),
    connection_id: Number(r.connection_id),
    epic,
    // Capital app name = epic (US100 stays US100)
    display_name: epic,
    lot_size: lot,
    instrument_id: Number(r.instrument_id),
    budget_pct: budget,
    category: String(r.category || 'other'),
    min_lot: Number(r.min_lot),
    max_lot: Number(r.max_lot),
    lot_step: Number(r.lot_step),
  };
}

/** All client panel subscriptions with trading enabled (for manage-robot reconcile). */
export async function listAllActiveSubscriptions(): Promise<ActiveSubscription[]> {
  const { rows } = await pool.query(
    `SELECT c.id as client_id, c.name as client_name,
            c.panel_epic, c.panel_display_name, c.panel_lot_size, c.panel_budget_pct,
            ba.id as account_id, bc.id as connection_id,
            cm.id as instrument_id, cm.epic, cm.display_name, cm.category,
            cm.min_lot, cm.max_lot, cm.lot_step,
            ais.lot_size as settings_lot, ais.trading_enabled
     FROM clients c
     JOIN broker_connections bc ON bc.client_id = c.id AND bc.enabled = true
     JOIN broker_accounts ba ON ba.broker_connection_id = bc.id AND ba.enabled = true
     JOIN capital_markets cm ON cm.broker_connection_id = bc.id
       AND (
         cm.epic = ANY(COALESCE(c.panel_epics, ARRAY[]::text[]))
         OR (cardinality(COALESCE(c.panel_epics, ARRAY[]::text[])) = 0 AND cm.epic = c.panel_epic)
       )
     LEFT JOIN account_instrument_settings ais
       ON ais.broker_account_id = ba.id AND ais.instrument_id = cm.id
     WHERE c.enabled = true
       AND c.access_enabled = true
       AND c.panel_robot_requested = 'RUNNING'
       AND (
         cardinality(COALESCE(c.panel_epics, ARRAY[]::text[])) > 0
         OR c.panel_epic IS NOT NULL
       )
       AND (
         c.preferred_broker_account_id IS NULL
         OR c.preferred_broker_account_id = ba.id
       )
     ORDER BY c.id ASC, ba.id ASC, cm.epic ASC`
  );

  const out: ActiveSubscription[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.client_id}:${r.epic}`;
    if (seen.has(key)) continue;
    if (r.trading_enabled === false) continue;
    out.push(mapSubRow(r as Record<string, unknown>));
    seen.add(key);
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
            c.panel_epic, c.panel_display_name, c.panel_lot_size, c.panel_budget_pct,
            ba.id as account_id, bc.id as connection_id,
            cm.id as instrument_id, cm.epic, cm.display_name, cm.category,
            cm.min_lot, cm.max_lot, cm.lot_step,
            ais.lot_size as settings_lot, ais.trading_enabled
     FROM clients c
     JOIN broker_connections bc ON bc.client_id = c.id AND bc.enabled = true
     JOIN broker_accounts ba ON ba.broker_connection_id = bc.id AND ba.enabled = true
     JOIN capital_markets cm ON cm.broker_connection_id = bc.id AND cm.epic = $1
     LEFT JOIN account_instrument_settings ais
       ON ais.broker_account_id = ba.id AND ais.instrument_id = cm.id
     WHERE c.enabled = true
       AND c.access_enabled = true
       AND c.panel_robot_requested = 'RUNNING'
       AND (
         $1 = ANY(COALESCE(c.panel_epics, ARRAY[]::text[]))
         OR (
           cardinality(COALESCE(c.panel_epics, ARRAY[]::text[])) = 0
           AND c.panel_epic = $1
         )
         OR COALESCE(c.panel_multi_market, false) = true
       )
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
    if (r.trading_enabled === false) continue;
    out.push(mapSubRow(r as Record<string, unknown>));
    seenClients.add(clientId);
  }
  return out;
}

export async function activateSubscription(input: {
  clientId: number;
  accountId: number;
  markets: Array<{ instrumentId: number; epic: string }>;
  lotSize: number;
  budgetPct: number;
}): Promise<void> {
  const markets = input.markets.slice(0, 3);
  if (!markets.length) throw new Error('Select 1–3 markets');
  const epics = markets.map((m) => m.epic);
  const ids = markets.map((m) => m.instrumentId);

  // Enable only selected markets on this account
  await pool.query(
    `UPDATE account_instrument_settings
     SET trading_enabled = false, updated_at = NOW()
     WHERE broker_account_id = $1
       AND NOT (instrument_id = ANY($2::int[]))`,
    [input.accountId, ids]
  );

  for (const m of markets) {
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
      [input.accountId, m.instrumentId, m.epic, input.lotSize]
    );
  }

  const primary = markets[0]!;
  await pool.query(
    `UPDATE clients SET
       panel_epic = $2,
       panel_display_name = $2,
       panel_epics = $3::text[],
       panel_lot_size = $4,
       panel_budget_pct = $5,
       panel_robot_requested = 'RUNNING',
       updated_at = NOW()
     WHERE id = $1`,
    [input.clientId, primary.epic, epics, input.lotSize, input.budgetPct]
  );
}

export async function deactivateSubscription(input: {
  clientId: number;
  accountId: number;
  instrumentIds?: number[] | null;
}): Promise<void> {
  if (input.instrumentIds?.length) {
    await pool.query(
      `UPDATE account_instrument_settings
       SET trading_enabled = false, updated_at = NOW()
       WHERE broker_account_id = $1 AND instrument_id = ANY($2::int[])`,
      [input.accountId, input.instrumentIds]
    );
  } else {
    await pool.query(
      `UPDATE account_instrument_settings
       SET trading_enabled = false, updated_at = NOW()
       WHERE broker_account_id = $1`,
      [input.accountId]
    );
  }
  await pool.query(
    `UPDATE clients SET panel_robot_requested = 'STOPPED', updated_at = NOW() WHERE id = $1`,
    [input.clientId]
  );
}
