import { pool } from '../db/pool.js';

export type PulledMarket = {
  epic: string;
  symbol: string;
  display_name: string;
  instrument_type: string | null;
  category: string;
  min_lot: number;
  max_lot: number;
  lot_step: number;
};

/** Upsert Capital catalog rows for one broker connection. */
export async function upsertMarketsForConnection(
  connectionId: number,
  markets: PulledMarket[]
): Promise<string[]> {
  const seenEpics: string[] = [];
  for (const m of markets) {
    seenEpics.push(m.epic);
    await pool.query(
      `INSERT INTO capital_markets
       (broker_connection_id, epic, symbol, display_name, instrument_type, category, min_lot, max_lot, lot_step)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (broker_connection_id, epic) DO UPDATE SET
         symbol = EXCLUDED.symbol,
         display_name = EXCLUDED.display_name,
         instrument_type = EXCLUDED.instrument_type,
         category = EXCLUDED.category,
         min_lot = EXCLUDED.min_lot,
         max_lot = EXCLUDED.max_lot,
         lot_step = EXCLUDED.lot_step,
         updated_at = NOW()`,
      [
        connectionId,
        m.epic,
        m.symbol,
        m.display_name,
        m.instrument_type,
        m.category,
        m.min_lot,
        m.max_lot,
        m.lot_step,
      ]
    );
  }
  return seenEpics;
}

/** Share pulled catalog with every Capital connection on the same environment (demo/live). */
export async function replicateMarketsToSiblingConnections(
  sourceConnectionId: number,
  environment: string,
  markets: PulledMarket[]
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT id FROM broker_connections
     WHERE broker_name = 'capital_com' AND environment = $1 AND id != $2`,
    [environment, sourceConnectionId]
  );
  for (const row of rows) {
    await upsertMarketsForConnection(row.id as number, markets);
  }
  return rows.length;
}

/** Global market list for client panel — all pulled epics, prefer this client's connection for lot limits. */
export async function listAllMarketsForClient(connectionId?: number | null): Promise<
  Array<{
    instrument_id: number;
    epic: string;
    symbol: string;
    display_name: string;
    category: string;
    min_lot: number;
    max_lot: number;
    lot_step: number;
  }>
> {
  const { rows } =
    connectionId != null
      ? await pool.query(
          `SELECT DISTINCT ON (epic)
             id, epic, symbol, display_name, category, min_lot, max_lot, lot_step
           FROM capital_markets
           ORDER BY epic,
             CASE WHEN broker_connection_id = $1 THEN 0 ELSE 1 END,
             updated_at DESC,
             display_name ASC`,
          [connectionId]
        )
      : await pool.query(
          `SELECT DISTINCT ON (epic)
             id, epic, symbol, display_name, category, min_lot, max_lot, lot_step
           FROM capital_markets
           ORDER BY epic, updated_at DESC, display_name ASC`
        );
  return rows.map((m) => ({
    instrument_id: Number(m.id),
    epic: String(m.epic),
    symbol: String(m.symbol || m.epic),
    display_name: String(m.display_name),
    category: String(m.category || 'other'),
    min_lot: Number(m.min_lot),
    max_lot: Number(m.max_lot),
    lot_step: Number(m.lot_step),
  }));
}

/** Resolve epic for a client — any connection's row, prefer own broker connection. */
export async function resolveMarketForClient(
  connectionId: number,
  epic: string
): Promise<{
  instrument_id: number;
  epic: string;
  symbol: string;
  display_name: string;
  category: string;
  min_lot: number;
  max_lot: number;
  lot_step: number;
  broker_connection_id: number;
} | null> {
  const { rows } = await pool.query(
    `SELECT id, epic, symbol, display_name, category, min_lot, max_lot, lot_step, broker_connection_id
     FROM capital_markets
     WHERE epic = $2
     ORDER BY CASE WHEN broker_connection_id = $1 THEN 0 ELSE 1 END, updated_at DESC
     LIMIT 1`,
    [connectionId, epic.trim()]
  );
  if (!rows.length) return null;
  const m = rows[0];
  return {
    instrument_id: Number(m.id),
    epic: String(m.epic),
    symbol: String(m.symbol || m.epic),
    display_name: String(m.display_name),
    category: String(m.category || 'other'),
    min_lot: Number(m.min_lot),
    max_lot: Number(m.max_lot),
    lot_step: Number(m.lot_step),
    broker_connection_id: Number(m.broker_connection_id),
  };
}
