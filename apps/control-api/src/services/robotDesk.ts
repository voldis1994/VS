import { pool } from '../db/pool.js';
import { decrypt } from '../security/encryption.js';
import {
  createCapitalPosition,
  fetchCapitalMarketQuote,
  openCapitalSession,
} from './capitalCom.js';

export type RobotTick = {
  at: string;
  phase: 'READ' | 'DECIDE' | 'ORDER' | 'WAIT' | 'ERROR' | 'INFO';
  bid: number | null;
  ask: number | null;
  mid: number | null;
  detail: string;
};

export type RobotSession = {
  id: string;
  account_id: number;
  account_name: string;
  environment: string;
  epic: string;
  display_name: string;
  lot_size: number;
  running: boolean;
  trading_enabled: boolean;
  started_at: string;
  stopped_at: string | null;
  ticks: RobotTick[];
  last_quote_at: string | null;
  last_mid: number | null;
  last_deal_reference: string | null;
  orders_placed: number;
  reads_ok: number;
  reads_fail: number;
  open_side: 'BUY' | 'SELL' | null;
  error: string | null;
};

type Internal = RobotSession & { timer: ReturnType<typeof setInterval> | null; connection_id: number };

const sessions = new Map<string, Internal>();
const MAX_TICKS = 200;

/** Stable robot id from account + epic — never Date.now(), never random */
export function robotIdFor(accountId: number, epic: string): string {
  const safe = String(epic)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
  return `r${accountId}_${safe || 'market'}`;
}

async function loadCreds(connectionId: number): Promise<Record<string, string>> {
  const { rows } = await pool.query(
    `SELECT credential_type, ciphertext, iv, tag
     FROM api_credential_metadata WHERE broker_connection_id = $1`,
    [connectionId]
  );
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.credential_type as string] = decrypt(
      row.ciphertext as string,
      row.iv as string,
      row.tag as string
    );
  }
  return out;
}

function pushTick(s: Internal, tick: Omit<RobotTick, 'at'>) {
  s.ticks.unshift({ ...tick, at: new Date().toISOString() });
  if (s.ticks.length > MAX_TICKS) s.ticks.length = MAX_TICKS;
}

function publicSession(s: Internal): RobotSession {
  const { timer: _t, connection_id: _c, ...rest } = s;
  return rest;
}

/** Exact id only — never returns a different robot */
export function getRobotSession(id?: string | null): RobotSession | null {
  const key = String(id || '').trim();
  if (!key || key === 'active') return null;
  const s = sessions.get(key);
  return s ? publicSession(s) : null;
}

/** Resolve by stable id OR account_id+epic — never confuses robots */
export function resolveRobotSession(opts: {
  id?: string | null;
  account_id?: number | null;
  epic?: string | null;
}): RobotSession | null {
  const byId = getRobotSession(opts.id);
  if (byId) return byId;

  const accountId = Number(opts.account_id);
  const epic = String(opts.epic || '').trim();
  if (Number.isFinite(accountId) && accountId > 0 && epic) {
    const key = robotIdFor(accountId, epic);
    const s = sessions.get(key);
    if (s) return publicSession(s);
    // Also match if epic was normalized differently but same account+epic stored
    for (const sess of sessions.values()) {
      if (sess.account_id === accountId && sess.epic === epic) return publicSession(sess);
    }
  }
  return null;
}

export function listRobotSessions(): RobotSession[] {
  return [...sessions.values()]
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .map(publicSession);
}

export async function stopRobotSession(id: string): Promise<RobotSession | null> {
  const s = sessions.get(id);
  if (!s) return null;
  s.running = false;
  s.trading_enabled = false;
  s.stopped_at = new Date().toISOString();
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
  pushTick(s, {
    phase: 'INFO',
    bid: null,
    ask: null,
    mid: s.last_mid,
    detail: 'ROBOT STOPPED by operator',
  });
  return publicSession(s);
}

async function robotCycle(s: Internal) {
  if (!s.running) return;

  const { rows } = await pool.query(
    `SELECT bc.id, bc.environment, bc.identifier, bc.broker_name
     FROM broker_connections bc WHERE bc.id = $1`,
    [s.connection_id]
  );
  if (!rows.length) {
    pushTick(s, {
      phase: 'ERROR',
      bid: null,
      ask: null,
      mid: null,
      detail: 'Broker connection missing',
    });
    return;
  }
  const conn = rows[0] as { environment: string; identifier: string | null; broker_name: string };
  if (conn.broker_name !== 'capital_com') {
    pushTick(s, {
      phase: 'ERROR',
      bid: null,
      ask: null,
      mid: null,
      detail: 'Not Capital.com',
    });
    return;
  }

  const creds = await loadCreds(s.connection_id);
  const opened = await openCapitalSession({
    environment: conn.environment,
    apiKey: creds.api_key || '',
    identifier: (conn.identifier || '').trim(),
    password: creds.password || '',
  });
  if (!opened.ok) {
    s.reads_fail += 1;
    s.error = opened.result.detail;
    pushTick(s, {
      phase: 'ERROR',
      bid: null,
      ask: null,
      mid: null,
      detail: `Session fail: ${opened.result.detail}`,
    });
    return;
  }

  try {
    const quote = await fetchCapitalMarketQuote(opened.session, s.epic);
    if (!quote.raw_ok) {
      s.reads_fail += 1;
      s.error = quote.detail || 'No quote';
      pushTick(s, {
        phase: 'ERROR',
        bid: null,
        ask: null,
        mid: null,
        detail: quote.detail || `No quote for ${s.display_name} (${s.epic})`,
      });
      return;
    }

    s.reads_ok += 1;
    s.error = null;
    s.last_quote_at = new Date().toISOString();
    const prevMid = s.last_mid;
    s.last_mid = quote.mid;
    if (quote.epic && quote.epic !== s.epic) {
      s.epic = quote.epic;
    }

    pushTick(s, {
      phase: 'READ',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `READ ${s.display_name} · bid=${quote.bid} ask=${quote.ask} mid=${quote.mid} · lot=${s.lot_size}`,
    });

    if (!s.trading_enabled) {
      pushTick(s, {
        phase: 'WAIT',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: 'Trading OFF — reading only',
      });
      return;
    }

    // Simple visible strategy: first good quote opens BUY once; later flips on mid move
    let direction: 'BUY' | 'SELL' | null = null;
    let reason = '';

    if (!s.open_side && quote.mid != null) {
      direction = 'BUY';
      reason = 'First live quote → open BUY with selected lot';
    } else if (s.open_side && prevMid != null && quote.mid != null) {
      const move = quote.mid - prevMid;
      const thr = Math.max(Math.abs(prevMid) * 0.00015, 0.01);
      if (s.open_side === 'BUY' && move < -thr) {
        direction = 'SELL';
        reason = `Mid dropped ${move.toFixed(5)} → reverse SELL`;
      } else if (s.open_side === 'SELL' && move > thr) {
        direction = 'BUY';
        reason = `Mid rose ${move.toFixed(5)} → reverse BUY`;
      } else {
        pushTick(s, {
          phase: 'DECIDE',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `HOLD ${s.open_side} · Δmid=${move.toFixed(5)} (need ±${thr.toFixed(5)})`,
        });
      }
    }

    if (!direction) return;

    // Cooldown: at most 1 order / 45s
    const lastOrder = s.ticks.find((t) => t.phase === 'ORDER' && t.detail.includes('dealRef'));
    if (lastOrder) {
      const age = Date.now() - new Date(lastOrder.at).getTime();
      if (age < 45_000) {
        pushTick(s, {
          phase: 'WAIT',
          bid: quote.bid,
          ask: quote.ask,
          mid: quote.mid,
          detail: `Cooldown: wait ${Math.ceil((45_000 - age) / 1000)}s before next order`,
        });
        return;
      }
    }

    pushTick(s, {
      phase: 'DECIDE',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `${reason} · size=${s.lot_size}`,
    });

    const result = await createCapitalPosition(opened.session, {
      epic: s.epic,
      direction,
      size: s.lot_size,
    });

    if (!result.ok) {
      pushTick(s, {
        phase: 'ERROR',
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        detail: `ORDER FAIL ${direction}: ${result.detail}`,
      });
      s.error = result.detail;
      return;
    }

    s.orders_placed += 1;
    s.open_side = direction;
    s.last_deal_reference = result.deal_reference || null;
    pushTick(s, {
      phase: 'ORDER',
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      detail: `ORDER ${direction} ${s.display_name} lot=${s.lot_size} · ${result.detail}`,
    });

    try {
      const m = await pool.query(
        `SELECT id FROM capital_markets
         WHERE broker_connection_id = $1 AND epic = $2 LIMIT 1`,
        [s.connection_id, s.epic]
      );
      await pool.query(
        `INSERT INTO positions
         (broker_account_id, instrument_id, direction, entry_price, quantity, status)
         VALUES ($1, $2, $3, $4, $5, 'OPEN')`,
        [
          s.account_id,
          m.rows[0]?.id || 0,
          direction === 'BUY' ? 'LONG' : 'SHORT',
          quote.mid || 0,
          s.lot_size,
        ]
      );
    } catch {
      /* Capital order already live */
    }
  } catch (err) {
    s.reads_fail += 1;
    const detail = err instanceof Error ? err.message : String(err);
    s.error = detail;
    pushTick(s, { phase: 'ERROR', bid: null, ask: null, mid: null, detail });
  } finally {
    await opened.session.close();
  }
}

export async function startRobotSession(input: {
  account_id: number;
  epic: string;
  display_name?: string;
  lot_size: number;
  trading_enabled?: boolean;
}): Promise<RobotSession> {
  const { rows } = await pool.query(
    `SELECT ba.id, ba.display_name, bc.id as connection_id, bc.environment, bc.broker_name
     FROM broker_accounts ba
     JOIN broker_connections bc ON bc.id = ba.broker_connection_id
     WHERE ba.id = $1`,
    [input.account_id]
  );
  if (!rows.length) throw new Error('Trading account not found');
  const acc = rows[0] as {
    id: number;
    display_name: string;
    connection_id: number;
    environment: string;
    broker_name: string;
  };
  if (acc.broker_name !== 'capital_com') throw new Error('Only Capital.com accounts supported');

  let displayName = (input.display_name || '').trim();
  let epic = input.epic.trim();
  if (!epic) throw new Error('epic required');

  // Prefer exact epic match; never invent wrong market
  const exact = await pool.query(
    `SELECT epic, display_name FROM capital_markets
     WHERE broker_connection_id = $1 AND epic = $2
     ORDER BY updated_at DESC LIMIT 1`,
    [acc.connection_id, epic]
  );
  if (exact.rows.length) {
    epic = exact.rows[0].epic as string;
    displayName = (exact.rows[0].display_name as string) || displayName || epic;
  } else {
    const byName = await pool.query(
      `SELECT epic, display_name FROM capital_markets
       WHERE broker_connection_id = $1 AND display_name ILIKE $2
       ORDER BY updated_at DESC LIMIT 1`,
      [acc.connection_id, epic]
    );
    if (byName.rows.length) {
      epic = byName.rows[0].epic as string;
      displayName = (byName.rows[0].display_name as string) || displayName || epic;
    }
  }
  if (!displayName) displayName = epic;

  const lot = Number(input.lot_size);
  if (!Number.isFinite(lot) || lot <= 0) throw new Error('lot_size must be > 0');

  // Stable id — same account+epic always same robot; restart replaces ONLY this one
  const id = robotIdFor(acc.id, epic);
  const existing = sessions.get(id);
  if (existing?.running) {
    await stopRobotSession(id);
  }
  sessions.delete(id);

  const session: Internal = {
    id,
    account_id: acc.id,
    account_name: acc.display_name,
    environment: acc.environment,
    connection_id: acc.connection_id,
    epic,
    display_name: displayName,
    lot_size: lot,
    running: true,
    trading_enabled: input.trading_enabled !== false,
    started_at: new Date().toISOString(),
    stopped_at: null,
    ticks: [],
    last_quote_at: null,
    last_mid: null,
    last_deal_reference: null,
    orders_placed: 0,
    reads_ok: 0,
    reads_fail: 0,
    open_side: null,
    error: null,
    timer: null,
  };

  const others = [...sessions.values()].filter((s) => s.running && s.id !== id).length;
  pushTick(session, {
    phase: 'INFO',
    bid: null,
    ask: null,
    mid: null,
    detail: `ROBOT START · id=${id} · ${displayName} (${epic}) · lot ${lot} · ${acc.environment.toUpperCase()} · trading ${
      session.trading_enabled ? 'ON' : 'OFF'
    } · other robots running: ${others}`,
  });
  pushTick(session, {
    phase: 'INFO',
    bid: null,
    ask: null,
    mid: null,
    detail: `Independent robot — only this account+instrument; other clients keep their robots`,
  });

  sessions.set(id, session);

  // Immediate first cycle, then every 4s
  void robotCycle(session);
  session.timer = setInterval(() => void robotCycle(session), 4000);

  return publicSession(session);
}
