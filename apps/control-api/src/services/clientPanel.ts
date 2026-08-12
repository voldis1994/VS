import { pool } from '../db/pool.js';
import {
  listRobotSessions,
  startRobotSession,
  stopRobotSession,
  type RobotSession,
} from './robotDesk.js';
import { emitToClient } from './clientEvents.js';
import { mapTradeType } from './tradePresentation.js';

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
  lot_size: number;
  entry_price: number | null;
  status: 'OPEN';
} | null;

export type ClientPanelStatus = {
  client_id: number;
  client_name: string;
  connection_ok: boolean;
  robot_status: 'RUNNING' | 'STOPPED';
  market: string | null;
  display_name: string | null;
  lot_size: number | null;
  account_id: number | null;
  live_trade: ClientLiveTrade;
  last_seen_at: string | null;
};

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
  if (!account) return [];
  const { rows } = await pool.query(
    `SELECT id, epic, symbol, display_name, category, min_lot, max_lot, lot_step
     FROM capital_markets
     WHERE broker_connection_id = $1
     ORDER BY display_name ASC`,
    [account.connection_id]
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

async function loadMarketForClient(
  clientId: number,
  epic: string
): Promise<(ClientMarket & { connection_id: number; account_id: number }) | null> {
  const account = await resolveClientTradingAccount(clientId);
  if (!account) return null;
  const { rows } = await pool.query(
    `SELECT id, epic, symbol, display_name, category, min_lot, max_lot, lot_step
     FROM capital_markets
     WHERE broker_connection_id = $1 AND epic = $2
     LIMIT 1`,
    [account.connection_id, epic]
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
    connection_id: account.connection_id,
    account_id: account.account_id,
  };
}

function robotForAccount(accountId: number, epic?: string | null): RobotSession | null {
  const all = listRobotSessions().filter((s) => s.account_id === accountId);
  if (epic) {
    const exact = all.find((s) => s.epic === epic && s.running);
    if (exact) return exact;
  }
  return all.find((s) => s.running) || all[0] || null;
}

export async function getClientPanelStatus(clientId: number): Promise<ClientPanelStatus> {
  const { rows } = await pool.query(
    `SELECT id, name, panel_epic, panel_display_name, panel_lot_size, last_seen_at
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
    last_seen_at: Date | string | null;
  };
  const account = await resolveClientTradingAccount(clientId);
  const robot = account ? robotForAccount(account.account_id, c.panel_epic) : null;
  const running = Boolean(robot?.running);
  let live_trade: ClientLiveTrade = null;
  if (robot?.running && robot.open_side) {
    live_trade = {
      market: robot.epic,
      display_name: robot.display_name,
      side: robot.open_side as 'BUY' | 'SELL',
      trade_type: mapTradeType(robot.open_side as 'BUY' | 'SELL') || robot.open_side,
      lot_size: robot.lot_size,
      entry_price: robot.entry_price,
      status: 'OPEN',
    };
  }

  return {
    client_id: c.id,
    client_name: c.name,
    connection_ok: true,
    robot_status: running ? 'RUNNING' : 'STOPPED',
    market: running ? robot!.epic : c.panel_epic,
    display_name: running ? robot!.display_name : c.panel_display_name,
    lot_size: running
      ? robot!.lot_size
      : c.panel_lot_size != null
        ? Number(c.panel_lot_size)
        : null,
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

  // Stop other robots for this account so Client Panel stays one-active-market
  for (const s of listRobotSessions()) {
    if (s.account_id === account.account_id && s.running && s.epic !== market.epic) {
      await stopRobotSession(s.id);
    }
  }

  await startRobotSession({
    account_id: account.account_id,
    epic: market.epic,
    display_name: market.display_name,
    lot_size: lot,
    trading_enabled: true,
  });

  await pool.query(
    `UPDATE clients SET panel_robot_requested = 'RUNNING', updated_at = NOW() WHERE id = $1`,
    [clientId]
  );

  const status = await getClientPanelStatus(clientId);
  emitToClient(clientId, {
    type: 'robot_started',
    market: status.market,
    display_name: status.display_name,
    lot_size: status.lot_size,
    robot_status: status.robot_status,
  });
  emitToClient(clientId, { type: 'client_status', ...status });
  return status;
}

export async function stopClientRobot(clientId: number): Promise<ClientPanelStatus> {
  const account = await resolveClientTradingAccount(clientId);
  if (account) {
    for (const s of listRobotSessions()) {
      if (s.account_id === account.account_id && s.running) {
        await stopRobotSession(s.id);
      }
    }
  }
  await pool.query(
    `UPDATE clients SET panel_robot_requested = 'STOPPED', updated_at = NOW() WHERE id = $1`,
    [clientId]
  );
  const status = await getClientPanelStatus(clientId);
  emitToClient(clientId, {
    type: 'robot_stopped',
    robot_status: status.robot_status,
  });
  emitToClient(clientId, { type: 'client_status', ...status });
  return status;
}

/** Strip any credential-like keys from objects returned to Client API. */
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
