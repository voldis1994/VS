import { pool } from '../db/pool.js';
import {
  listRobotSessions,
  startRobotSession,
  stopEntryRobotsForAccount,
  stopFlatManageRobotsForAccount,
  stopRobotSession,
  robotIdFor,
} from './robotDesk.js';
import { emitToClient } from './clientEvents.js';
import {
  listAllMarketsForClient,
  resolveMarketForClient,
} from './capitalMarketsCatalog.js';
import { formatTradeLabel } from './tradePresentation.js';
import { currentRegime } from './regimes.js';
import {
  deactivateSubscription,
  getBrokerHealth,
  noteBrokerError,
  noteBrokerOk,
} from './clientSubscriptions.js';
import {
  acquireCapitalSession,
  listCapitalOpenPositions,
} from './capitalCom.js';
import { decrypt } from '../security/encryption.js';

export type ClientMarket = {
  instrument_id: number;
  epic: string;
  symbol: string;
  display_name: string;
  category: string;
  min_lot: number;
  max_lot: number;
  lot_step: number;
};

export type ClientLiveTrade = {
  market: string;
  display_name: string;
  side: 'BUY' | 'SELL';
  trade_type: string;
  regime: string | null;
  lot_size: number;
  entry_price: number | null;
  status: 'OPEN';
} | null;

export type ClientPanelStatus = {
  client_id: number;
  client_name: string;
  connection_status: 'ONLINE' | 'LOST' | 'ERROR';
  /** REQUESTED vs CONFIRMED: STARTING until this client's own desk brain is live */
  robot_status: 'RUNNING' | 'STARTING' | 'STOPPED' | 'ERROR';
  requested_status: 'RUNNING' | 'STOPPED';
  broker_status: 'CONNECTED' | 'DEGRADED' | 'UNKNOWN';
  pipeline_healthy: boolean;
  market_analyzed: boolean;
  last_broker_ok_at: string | null;
  broker_error: string | null;
  market: string | null;
  display_name: string | null;
  lot_size: number | null;
  account_id: number | null;
  live_trade: ClientLiveTrade;
  last_seen_at: string | null;
  /** Human-readable reason for STARTING/ERROR */
  status_reason?: string | null;
  /** @deprecated use connection_status */
  connection_ok: boolean;
};

/**
 * Per-client own-brain status.
 * RUNNING only when this client's desk entry session is live — never via shared Market Core fanout.
 */
export function computeClientRobotStatus(input: {
  requestedRunning: boolean;
  hasAccount: boolean;
  hasEpic: boolean;
  deskEntryRunning: boolean;
}): { robot_status: ClientPanelStatus['robot_status']; status_reason: string | null } {
  if (!input.requestedRunning) return { robot_status: 'STOPPED', status_reason: null };
  if (!input.hasAccount) return { robot_status: 'ERROR', status_reason: 'No broker account' };
  if (!input.hasEpic) return { robot_status: 'ERROR', status_reason: 'No market selected' };
  if (!input.deskEntryRunning) {
    return { robot_status: 'STARTING', status_reason: 'Starting this client\'s own robot brain' };
  }
  return { robot_status: 'RUNNING', status_reason: null };
}

export function validateLotSize(
  lot: number,
  minLot: number,
  maxLot: number,
  lotStep: number
): string | null {
  if (!Number.isFinite(lot)) return 'lot_size must be a number';
  if (lot <= 0) return 'lot_size must be > 0';
  if (lot + 1e-12 < minLot) return `lot_size below min_lot (${minLot})`;
  if (lot - 1e-12 > maxLot) return `lot_size above max_lot (${maxLot})`;
  const step = lotStep > 0 ? lotStep : 0.01;
  const steps = Math.round((lot - minLot) / step);
  const aligned = minLot + steps * step;
  if (Math.abs(aligned - lot) > Math.max(1e-8, step * 1e-6)) {
    return `lot_size must align to lot_step (${step}) from min_lot (${minLot})`;
  }
  return null;
}

export async function resolveClientTradingAccount(clientId: number): Promise<{
  account_id: number;
  connection_id: number;
  display_name: string;
} | null> {
  const pref = await pool.query(
    `SELECT preferred_broker_account_id FROM clients WHERE id = $1`,
    [clientId]
  );
  const preferred = pref.rows[0]?.preferred_broker_account_id as number | null | undefined;
  if (preferred) {
    const { rows } = await pool.query(
      `SELECT ba.id as account_id, ba.display_name, bc.id as connection_id
       FROM broker_accounts ba
       JOIN broker_connections bc ON bc.id = ba.broker_connection_id
       WHERE ba.id = $1 AND bc.client_id = $2 AND ba.enabled = true AND bc.enabled = true`,
      [preferred, clientId]
    );
    if (rows.length) {
      return {
        account_id: rows[0].account_id as number,
        connection_id: rows[0].connection_id as number,
        display_name: rows[0].display_name as string,
      };
    }
  }

  const { rows } = await pool.query(
    `SELECT ba.id as account_id, ba.display_name, bc.id as connection_id
     FROM broker_accounts ba
     JOIN broker_connections bc ON bc.id = ba.broker_connection_id
     WHERE bc.client_id = $1 AND ba.enabled = true AND bc.enabled = true
     ORDER BY ba.id ASC
     LIMIT 1`,
    [clientId]
  );
  if (!rows.length) return null;
  return {
    account_id: rows[0].account_id as number,
    connection_id: rows[0].connection_id as number,
    display_name: rows[0].display_name as string,
  };
}

export async function listClientMarkets(clientId: number): Promise<ClientMarket[]> {
  const account = await resolveClientTradingAccount(clientId);
  return listAllMarketsForClient(account?.connection_id ?? null);
}

async function loadMarketForClient(
  clientId: number,
  epic: string
): Promise<(ClientMarket & { connection_id: number; account_id: number }) | null> {
  const account = await resolveClientTradingAccount(clientId);
  if (!account) return null;
  const m = await resolveMarketForClient(account.connection_id, epic);
  if (!m) return null;
  return {
    instrument_id: m.instrument_id,
    epic: m.epic,
    symbol: m.symbol,
    display_name: m.display_name,
    category: m.category,
    min_lot: m.min_lot,
    max_lot: m.max_lot,
    lot_step: m.lot_step,
    connection_id: account.connection_id,
    account_id: account.account_id,
  };
}

function robotForAccount(accountId: number, epic?: string | null) {
  const all = listRobotSessions().filter((s) => s.account_id === accountId);
  if (epic) {
    const exact = all.find((s) => s.epic === epic && s.running);
    if (exact) return exact;
  }
  return all.find((s) => s.running) || all[0] || null;
}

export async function getClientPanelStatus(clientId: number): Promise<ClientPanelStatus> {
  const { rows } = await pool.query(
    `SELECT id, name, panel_epic, panel_display_name, panel_lot_size,
            panel_robot_requested, last_seen_at
     FROM clients WHERE id = $1`,
    [clientId]
  );
  if (!rows.length) throw new Error('Client not found');
  const c = rows[0] as {
    id: number;
    name: string;
    panel_epic: string | null;
    panel_display_name: string | null;
    panel_lot_size: string | number | null;
    panel_robot_requested: string;
    last_seen_at: Date | string | null;
  };
  const account = await resolveClientTradingAccount(clientId);
  const requestedRunning = String(c.panel_robot_requested || '').toUpperCase() === 'RUNNING';
  const robot = account ? robotForAccount(account.account_id, c.panel_epic) : null;
  const deskEntryRunning = Boolean(robot?.running && robot.entry_enabled);
  const health = getBrokerHealth(clientId);

  let live_trade: ClientLiveTrade = null;
  if (robot?.running && robot.open_side) {
    const side = robot.open_side as 'BUY' | 'SELL';
    const regime =
      robot.regime || currentRegime(robot.epic, robot.id)?.current || null;
    live_trade = {
      market: robot.epic,
      display_name: robot.display_name,
      side,
      trade_type: formatTradeLabel(side, null, regime) || side,
      regime,
      lot_size: robot.lot_size,
      entry_price: robot.entry_price,
      status: 'OPEN',
    };
  }

  // Authoritative open trade from Capital (survives refresh / WS loss)
  if (!live_trade && account && c.panel_epic) {
    try {
      const conn = await pool.query(
        `SELECT environment, identifier, broker_name FROM broker_connections WHERE id = $1`,
        [account.connection_id]
      );
      if (conn.rows[0]?.broker_name === 'capital_com') {
        const credRows = await pool.query(
          `SELECT credential_type, ciphertext, iv, tag FROM api_credential_metadata
           WHERE broker_connection_id = $1`,
          [account.connection_id]
        );
        const creds: Record<string, string> = {};
        for (const row of credRows.rows) {
          creds[row.credential_type as string] = decrypt(
            row.ciphertext as string,
            row.iv as string,
            row.tag as string
          );
        }
        const accExt = await pool.query(
          `SELECT external_account_id FROM broker_accounts WHERE id = $1`,
          [account.account_id]
        );
        const opened = await acquireCapitalSession({
          environment: conn.rows[0].environment as string,
          apiKey: creds.api_key || '',
          identifier: String(conn.rows[0].identifier || '').trim(),
          password: creds.password || '',
          connectionId: account.connection_id,
          capitalAccountId: (accExt.rows[0]?.external_account_id as string | null) || null,
        });
        if (opened.ok) {
          noteBrokerOk(clientId);
          const listed = await listCapitalOpenPositions(opened.session);
          const match = listed.ok
            ? listed.positions.find(
                (p) => p.epic.toUpperCase() === String(c.panel_epic).toUpperCase()
              )
            : null;
          if (match) {
            const side = match.direction;
            const scope = robot?.id || null;
            const regime = currentRegime(match.epic, scope)?.current || null;
            live_trade = {
              market: match.epic,
              display_name: c.panel_display_name || match.epic,
              side,
              trade_type: formatTradeLabel(side, null, regime) || side,
              regime,
              lot_size:
                match.size > 0
                  ? match.size
                  : c.panel_lot_size != null
                    ? Number(c.panel_lot_size)
                    : 0,
              entry_price: match.open_level,
              status: 'OPEN',
            };
          }
        } else {
          noteBrokerError(clientId, opened.result.detail);
        }
      }
    } catch (err) {
      noteBrokerError(clientId, err instanceof Error ? err.message : String(err));
    }
  }

  const computed = computeClientRobotStatus({
    requestedRunning,
    hasAccount: Boolean(account),
    hasEpic: Boolean(c.panel_epic),
    deskEntryRunning,
  });
  const robot_status = computed.robot_status;
  const status_reason = computed.status_reason;

  let connection_status: ClientPanelStatus['connection_status'] = 'ONLINE';
  if (robot_status === 'ERROR' || health.broker_status === 'DEGRADED' || health.last_error) {
    connection_status = requestedRunning ? 'ERROR' : 'ONLINE';
  }

  return {
    client_id: c.id,
    client_name: c.name,
    connection_status,
    connection_ok: connection_status === 'ONLINE',
    robot_status,
    requested_status: requestedRunning ? 'RUNNING' : 'STOPPED',
    broker_status: health.broker_status,
    pipeline_healthy: true,
    market_analyzed: deskEntryRunning,
    last_broker_ok_at: health.last_ok_at,
    broker_error: health.last_error || status_reason,
    status_reason,
    market: c.panel_epic,
    display_name: c.panel_display_name,
    lot_size: c.panel_lot_size != null ? Number(c.panel_lot_size) : null,
    account_id: account?.account_id ?? null,
    live_trade,
    last_seen_at: c.last_seen_at ? new Date(c.last_seen_at).toISOString() : null,
  };
}

export async function saveClientConfig(
  clientId: number,
  input: { epic: string; lot_size: number }
): Promise<ClientPanelStatus> {
  const market = await loadMarketForClient(clientId, input.epic.trim());
  if (!market) throw new Error('Invalid market for this client');
  const lotErr = validateLotSize(input.lot_size, market.min_lot, market.max_lot, market.lot_step);
  if (lotErr) throw new Error(lotErr);

  await pool.query(
    `UPDATE clients SET
       panel_epic = $2,
       panel_display_name = $3,
       panel_lot_size = $4,
       updated_at = NOW()
     WHERE id = $1`,
    [clientId, market.epic, market.display_name, input.lot_size]
  );

  emitToClient(clientId, {
    type: 'client_status',
    market: market.epic,
    display_name: market.display_name,
    lot_size: input.lot_size,
  });

  return getClientPanelStatus(clientId);
}

/**
 * Client START = this client's own desk brain (structure → setup → entry → best outcome).
 * Does NOT subscribe to shared Market Core fan-out — each client trades alone.
 */
export async function startClientRobot(clientId: number): Promise<ClientPanelStatus> {
  const { rows } = await pool.query(
    `SELECT panel_epic, panel_display_name, panel_lot_size, enabled, access_enabled
     FROM clients WHERE id = $1`,
    [clientId]
  );
  if (!rows.length) throw new Error('Client not found');
  const c = rows[0] as {
    panel_epic: string | null;
    panel_display_name: string | null;
    panel_lot_size: string | number | null;
    enabled: boolean;
    access_enabled: boolean;
  };
  if (!c.enabled) throw new Error('Client disabled');
  if (!c.access_enabled) throw new Error('Client access disabled');
  if (!c.panel_epic || c.panel_lot_size == null) {
    throw new Error('Select market and lot size before START');
  }

  const market = await loadMarketForClient(clientId, c.panel_epic);
  if (!market) throw new Error('Invalid market for this client');
  const lot = Number(c.panel_lot_size);
  const lotErr = validateLotSize(lot, market.min_lot, market.max_lot, market.lot_step);
  if (lotErr) throw new Error(lotErr);

  const account = await resolveClientTradingAccount(clientId);
  if (!account) throw new Error('No broker account linked to this client');

  // Leave fanout: disable ais trading so Market Core cannot open for this client
  await pool.query(
    `UPDATE account_instrument_settings
     SET trading_enabled = false, updated_at = NOW()
     WHERE broker_account_id = $1`,
    [account.account_id]
  );
  await pool.query(
    `UPDATE clients SET
       panel_epic = $2,
       panel_display_name = $3,
       panel_lot_size = $4,
       panel_robot_requested = 'RUNNING',
       updated_at = NOW()
     WHERE id = $1`,
    [clientId, market.epic, market.display_name, lot]
  );

  const session = await startRobotSession({
    account_id: account.account_id,
    epic: market.epic,
    display_name: market.display_name,
    lot_size: lot,
    trading_enabled: true,
    entry_enabled: true,
  });

  const status = await getClientPanelStatus(clientId);
  emitToClient(clientId, {
    type: 'robot_started',
    robot_id: session.id,
    market: status.market,
    display_name: status.display_name,
    lot_size: status.lot_size,
    robot_status: status.robot_status,
    mode: 'own_brain',
  });
  emitToClient(clientId, { type: 'client_status', ...status });
  return status;
}

export async function stopClientRobot(clientId: number): Promise<ClientPanelStatus> {
  const account = await resolveClientTradingAccount(clientId);
  const { rows } = await pool.query(
    `SELECT panel_epic FROM clients WHERE id = $1`,
    [clientId]
  );
  const epic = rows[0]?.panel_epic as string | null;
  let instrumentId: number | null = null;
  if (account && epic) {
    const m = await loadMarketForClient(clientId, epic);
    instrumentId = m?.instrument_id ?? null;
  }
  if (account) {
    // Stop this client's own brain (entry + flat manage). Open-trade manage keeps running
    // until flat — stopEntry then stopFlat; if still managing an open trade, leave it.
    await stopEntryRobotsForAccount(account.account_id);
    await stopFlatManageRobotsForAccount(account.account_id);
    if (epic) {
      const id = robotIdFor(account.account_id, epic);
      const still = listRobotSessions().find((s) => s.id === id && s.running && !s.open_side);
      if (still) await stopRobotSession(id);
    }
    await deactivateSubscription({
      clientId,
      accountId: account.account_id,
      instrumentId,
    });
  } else {
    await pool.query(
      `UPDATE clients SET panel_robot_requested = 'STOPPED', updated_at = NOW() WHERE id = $1`,
      [clientId]
    );
  }
  const status = await getClientPanelStatus(clientId);
  emitToClient(clientId, {
    type: 'robot_stopped',
    robot_status: status.robot_status,
  });
  emitToClient(clientId, { type: 'client_status', ...status });
  return status;
}

export function assertNoSecrets(payload: unknown): void {
  const forbidden = [
    'password',
    'api_key',
    'apiKey',
    'ciphertext',
    'access_code_hash',
    'token_hash',
    'MASTER_ENCRYPTION',
  ];
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (forbidden.some((f) => k.toLowerCase().includes(f.toLowerCase()))) {
        throw new Error(`Refusing to expose secret field: ${k}`);
      }
      walk(val);
    }
  };
  walk(payload);
}
