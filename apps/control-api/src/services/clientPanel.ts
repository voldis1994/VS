import { pool } from '../db/pool.js';
import { listRobotSessions, stopEntryRobotsForAccount, stopFlatManageRobotsForAccount } from './robotDesk.js';
import { emitToClient } from './clientEvents.js';
import { formatTradeLabel } from './tradePresentation.js';
import { currentRegime } from './regimes.js';
import {
  activateSubscription,
  deactivateSubscription,
  getBrokerHealth,
  noteBrokerError,
  noteBrokerOk,
} from './clientSubscriptions.js';
import {
  getPipelineBridgeStatus,
  isEpicBeingAnalyzed,
} from './pipelineBridge.js';
import {
  acquireCapitalSession,
  fetchCapitalMarketQuote,
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

export type ClientQuote = {
  epic: string;
  display_name: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread: number | null;
  change_pct: number | null;
  regime: string | null;
  updated_at: string;
};

export type ClientPanelStatus = {
  client_id: number;
  client_name: string;
  connection_status: 'ONLINE' | 'LOST' | 'ERROR';
  /** REQUESTED vs CONFIRMED: STARTING until Market Reader bridge analyzes the epic */
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

export function computeClientRobotStatus(input: {
  requestedRunning: boolean;
  hasAccount: boolean;
  hasEpic: boolean;
  bridgeHealthy: boolean;
  marketAnalyzed: boolean;
}): { robot_status: ClientPanelStatus['robot_status']; status_reason: string | null } {
  if (!input.requestedRunning) return { robot_status: 'STOPPED', status_reason: null };
  if (!input.hasAccount) return { robot_status: 'ERROR', status_reason: 'No broker account' };
  if (!input.hasEpic) return { robot_status: 'ERROR', status_reason: 'No market selected' };
  if (!input.bridgeHealthy) {
    return { robot_status: 'ERROR', status_reason: 'Market Core heartbeat unavailable' };
  }
  if (!input.marketAnalyzed) {
    return { robot_status: 'STARTING', status_reason: 'Waiting for Market Core to analyze market' };
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
  const health = getBrokerHealth(clientId);
  const bridge = getPipelineBridgeStatus();
  const marketAnalyzed = isEpicBeingAnalyzed(c.panel_epic);

  let live_trade: ClientLiveTrade = null;
  if (robot?.running && robot.open_side) {
    const side = robot.open_side as 'BUY' | 'SELL';
    const regime = robot.regime || currentRegime(robot.epic)?.current || null;
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
            const regime = currentRegime(match.epic)?.current || null;
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
    bridgeHealthy: bridge.healthy,
    marketAnalyzed,
  });
  const robot_status = computed.robot_status;
  const status_reason =
    robot_status === 'ERROR' && bridge.last_error && !bridge.healthy
      ? bridge.last_error
      : computed.status_reason;

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
    pipeline_healthy: bridge.healthy,
    market_analyzed: marketAnalyzed,
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
 * Client START = activate subscription for pipeline fan-out.
 * Does NOT start robotDesk entry strategy.
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

  // Kill entry brains only — keep manage-only robot if a trade is already open
  await stopEntryRobotsForAccount(account.account_id);

  await activateSubscription({
    clientId,
    accountId: account.account_id,
    instrumentId: market.instrument_id,
    epic: market.epic,
    displayName: market.display_name,
    lotSize: lot,
  });

  const status = await getClientPanelStatus(clientId);
  emitToClient(clientId, {
    type: 'robot_started',
    market: status.market,
    display_name: status.display_name,
    lot_size: status.lot_size,
    robot_status: status.robot_status,
    mode: 'subscription',
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
    await stopEntryRobotsForAccount(account.account_id);
    await stopFlatManageRobotsForAccount(account.account_id);
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

export async function getClientQuote(clientId: number): Promise<ClientQuote | null> {
  const { rows } = await pool.query(
    `SELECT panel_epic, panel_display_name FROM clients WHERE id = $1`,
    [clientId]
  );
  if (!rows.length) return null;
  const epic = rows[0].panel_epic as string | null;
  if (!epic) return null;
  const displayName = String(rows[0].panel_display_name || epic);
  const account = await resolveClientTradingAccount(clientId);
  const regime = currentRegime(epic)?.current || null;
  const now = new Date().toISOString();

  if (account) {
    const robot = robotForAccount(account.account_id, epic);
    const tick = robot?.ticks?.[0];
    if (tick && (tick.mid != null || tick.bid != null || tick.ask != null)) {
      const bid = tick.bid;
      const ask = tick.ask;
      const mid =
        tick.mid ??
        (bid != null && ask != null ? (bid + ask) / 2 : bid ?? ask ?? robot?.last_mid ?? null);
      const spread = bid != null && ask != null ? ask - bid : null;
      return {
        epic,
        display_name: displayName,
        bid,
        ask,
        mid,
        spread,
        change_pct: null,
        regime: robot?.regime || regime,
        updated_at: tick.at || robot?.last_quote_at || now,
      };
    }
    if (robot?.last_mid != null) {
      return {
        epic,
        display_name: displayName,
        bid: null,
        ask: null,
        mid: robot.last_mid,
        spread: null,
        change_pct: null,
        regime: robot?.regime || regime,
        updated_at: robot.last_quote_at || now,
      };
    }
  }

  if (!account) {
    return {
      epic,
      display_name: displayName,
      bid: null,
      ask: null,
      mid: null,
      spread: null,
      change_pct: null,
      regime,
      updated_at: now,
    };
  }

  try {
    const conn = await pool.query(
      `SELECT environment, identifier, broker_name FROM broker_connections WHERE id = $1`,
      [account.connection_id]
    );
    if (conn.rows[0]?.broker_name !== 'capital_com') {
      return {
        epic,
        display_name: displayName,
        bid: null,
        ask: null,
        mid: null,
        spread: null,
        change_pct: null,
        regime,
        updated_at: now,
      };
    }
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
    if (!opened.ok) {
      return {
        epic,
        display_name: displayName,
        bid: null,
        ask: null,
        mid: null,
        spread: null,
        change_pct: null,
        regime,
        updated_at: now,
      };
    }
    const quote = await fetchCapitalMarketQuote(opened.session, epic);
    return {
      epic: quote.epic || epic,
      display_name: displayName,
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      spread: quote.spread,
      change_pct: quote.percentage_change,
      regime,
      updated_at: quote.update_time || now,
    };
  } catch {
    return {
      epic,
      display_name: displayName,
      bid: null,
      ask: null,
      mid: null,
      spread: null,
      change_pct: null,
      regime,
      updated_at: now,
    };
  }
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
