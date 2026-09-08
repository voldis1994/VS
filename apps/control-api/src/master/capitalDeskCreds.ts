/**
 * Load Capital.com credentials from Brokers-page DB (encrypted api_credential_metadata).
 * Used when CAPITAL_* env is absent — primary LIVE venue is still Capital.com API direct,
 * but operators enter keys in Brokers UI rather than duplicating into env.
 */
import { decrypt } from '../security/encryption.js';

export type DeskCapitalCreds = {
  environment: string;
  apiKey: string;
  identifier: string;
  password: string;
  /** DB broker_connections.id — used only for credential lookup, not CST pool */
  dbConnectionId: number;
  capitalAccountId: string | null;
  detail: string;
};

export type DeskCapitalLoadResult =
  | { ok: true; creds: DeskCapitalCreds }
  | { ok: false; detail: string };

type DeskLoader = (connectionId?: number | null) => Promise<DeskCapitalLoadResult>;

let testLoader: DeskLoader | null = null;

/** Vitest inject — bypass Postgres. */
export function setDeskCapitalCredLoaderForTests(loader: DeskLoader | null) {
  testLoader = loader;
}

/**
 * Pick an enabled capital_com Brokers row + decrypted api_key/password.
 * Optional connectionId / MASTER_CAPITAL_DB_CONNECTION_ID / first enabled row.
 */
export async function loadDeskCapitalCredentials(
  connectionId?: number | null
): Promise<DeskCapitalLoadResult> {
  if (testLoader) return testLoader(connectionId);

  try {
    const { pool } = await import('../db/pool.js');
    const want =
      connectionId != null && Number.isFinite(Number(connectionId)) && Number(connectionId) > 0
        ? Math.floor(Number(connectionId))
        : Number(process.env.MASTER_CAPITAL_DB_CONNECTION_ID || 0) > 0
          ? Math.floor(Number(process.env.MASTER_CAPITAL_DB_CONNECTION_ID))
          : null;

    const { rows } = want
      ? await pool.query(
          `SELECT id, environment, identifier, broker_name, enabled
           FROM broker_connections WHERE id = $1`,
          [want]
        )
      : await pool.query(
          `SELECT id, environment, identifier, broker_name, enabled
           FROM broker_connections
           WHERE broker_name = 'capital_com' AND enabled = true
           ORDER BY id ASC
           LIMIT 1`
        );

    if (!rows.length) {
      return {
        ok: false,
        detail: want
          ? `desk_capital_connection_missing:${want}`
          : 'desk_capital_no_enabled_connection',
      };
    }

    const conn = rows[0] as {
      id: number;
      environment: string;
      identifier: string | null;
      broker_name: string;
      enabled: boolean;
    };

    if (conn.broker_name !== 'capital_com') {
      return { ok: false, detail: `desk_not_capital_com:${conn.broker_name}` };
    }
    if (!conn.enabled) {
      return { ok: false, detail: `desk_capital_disabled:${conn.id}` };
    }

    const credRows = await pool.query(
      `SELECT credential_type, ciphertext, iv, tag
       FROM api_credential_metadata WHERE broker_connection_id = $1`,
      [conn.id]
    );
    const map: Record<string, string> = {};
    for (const row of credRows.rows) {
      map[row.credential_type as string] = decrypt(
        row.ciphertext as string,
        row.iv as string,
        row.tag as string
      );
    }

    const apiKey = (map.api_key || '').trim();
    const password = (map.password || '').trim();
    const identifier = String(conn.identifier || '').trim();
    if (!apiKey || !password || !identifier) {
      return {
        ok: false,
        detail: `desk_capital_creds_incomplete:conn=${conn.id}`,
      };
    }

    const acc = await pool.query(
      `SELECT external_account_id FROM broker_accounts
       WHERE broker_connection_id = $1 AND enabled = true
       ORDER BY id ASC LIMIT 1`,
      [conn.id]
    );
    const capitalAccountId =
      (acc.rows[0]?.external_account_id as string | null | undefined) || null;

    return {
      ok: true,
      creds: {
        environment: (conn.environment || 'demo').trim(),
        apiKey,
        identifier,
        password,
        dbConnectionId: conn.id,
        capitalAccountId: capitalAccountId ? String(capitalAccountId).trim() : null,
        detail: `desk_db:conn=${conn.id}`,
      },
    };
  } catch (e) {
    return {
      ok: false,
      detail: `desk_db_unavailable:${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
