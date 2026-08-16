/**
 * Canonical /api/v1/* read surfaces for MSI ADMIN + contracts.
 * Never invent values — return UNAVAILABLE / empty when data is missing.
 * Admin auth: x-admin-token (global middleware + explicit check).
 */
import type { FastifyInstance } from 'fastify';
import { pool, healthCheck } from '../db/pool.js';
import { collectHostSystemSnapshot } from '../vs-core/hostTelemetry.js';
import { getEventBus } from '../vs-core/eventBus.js';
import { buildAdminSnapshot, type AdminAgentDeps } from '../vs-core/adminAgent.js';
import { normalizeNetworkSecret } from '../vs-core/network/networkSecrets.js';
import { listFeedHealthRows } from './robotReader.js';
import { runtimeBuildInfo } from '../services/runtimeBuild.js';

function authorizeAdmin(req: { headers: Record<string, unknown> }, expected?: string): boolean {
  const want = normalizeNetworkSecret(expected ?? process.env.API_ADMIN_TOKEN);
  if (!want || want === 'CHANGE_ME_ADMIN_TOKEN') {
    return process.env.NODE_ENV !== 'production';
  }
  const token = normalizeNetworkSecret(String(req.headers['x-admin-token'] || ''));
  return token === want;
}

async function safeQuery<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function registerCanonicalV1Routes(
  app: FastifyInstance,
  deps: AdminAgentDeps
): Promise<void> {
  const token = deps.adminToken ?? process.env.API_ADMIN_TOKEN;

  const deny = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });

  app.get('/api/v1/system/snapshot', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) return deny(reply);
    return buildAdminSnapshot(deps);
  });

  app.get('/api/v1/system/resources', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) return deny(reply);
    const host = collectHostSystemSnapshot({
      cpuSampleMs: 50,
      probeNetwork: true,
      dataRoot: process.env.VS_CORE_DATA || process.env.VS_SERVER_DATA || '/',
    });
    return { ok: true, resources: host, ...runtimeBuildInfo() };
  });

  app.get('/api/v1/admin/status', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) return deny(reply);
    const snap = await buildAdminSnapshot(deps);
    return {
      ok: true,
      role: 'admin',
      server_id: snap.server_id,
      readiness: snap.core,
      host: snap.host,
      ...runtimeBuildInfo(),
    };
  });

  app.get('/api/v1/market/status', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) return deny(reply);
    const feedSnap = deps.feedManager?.snapshot('GOLD') ?? null;
    return {
      ok: true,
      symbol: feedSnap ? 'GOLD' : null,
      feed: feedSnap,
      status: feedSnap ? 'AVAILABLE' : 'UNAVAILABLE',
    };
  });

  app.get('/api/v1/market/feeds', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) return deny(reply);
    const rows = await safeQuery(() => listFeedHealthRows(), []);
    return { ok: true, feeds: rows, status: rows.length ? 'AVAILABLE' : 'UNAVAILABLE' };
  });

  app.get('/api/v1/market/ohlc', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) return deny(reply);
    const q = req.query as { symbol?: string; limit?: string };
    const symbol = q.symbol || 'GOLD';
    const limit = Math.min(Math.max(parseInt(q.limit || '60', 10) || 60, 1), 500);
    const rows = await safeQuery(async () => {
      const { rows: r } = await pool.query(
        `SELECT * FROM candles_10s WHERE instrument = $1 ORDER BY start_ts DESC LIMIT $2`,
        [symbol, limit]
      );
      return r;
    }, null as unknown[] | null);
    return {
      ok: true,
      symbol,
      interval: '10s',
      candles: rows ?? [],
      status: rows === null ? 'UNAVAILABLE' : 'AVAILABLE',
    };
  });

  app.get('/api/v1/market/intelligence', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) return deny(reply);
    const q = req.query as { symbol?: string };
    const symbol = q.symbol || 'GOLD';
    const rows = await safeQuery(async () => {
      const { rows: r } = await pool.query(
        `SELECT * FROM market_states WHERE instrument = $1 ORDER BY as_of DESC LIMIT 1`,
        [symbol]
      );
      return r[0] ?? null;
    }, null);
    return {
      ok: true,
      symbol,
      state: rows,
      status: rows ? 'AVAILABLE' : 'UNAVAILABLE',
    };
  });

  app.get('/api/v1/market/regime', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) return deny(reply);
    const q = req.query as { symbol?: string };
    const symbol = q.symbol || 'GOLD';
    const row = await safeQuery(async () => {
      const { rows } = await pool.query(
        `SELECT label, status, vector, as_of, created_at FROM market_states
         WHERE instrument = $1 ORDER BY as_of DESC LIMIT 1`,
        [symbol]
      );
      return rows[0] ?? null;
    }, null);
    return {
      ok: true,
      symbol,
      regime: row,
      status: row ? 'AVAILABLE' : 'UNAVAILABLE',
    };
  });

  app.get('/api/v1/accounts', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) return deny(reply);
    const rows = await safeQuery(async () => {
      const { rows: r } = await pool.query(
        `SELECT id, client_id, broker_account_ref, currency, enabled, created_at
         FROM accounts ORDER BY id ASC LIMIT 500`
      );
      return r;
    }, null as unknown[] | null);
    return {
      ok: true,
      accounts: rows ?? [],
      status: rows === null ? 'UNAVAILABLE' : 'AVAILABLE',
    };
  });

  app.get('/api/v1/clients', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) return deny(reply);
    const rows = await safeQuery(async () => {
      const { rows: r } = await pool.query(
        `SELECT id, name, enabled, access_enabled, created_at FROM clients ORDER BY id ASC LIMIT 500`
      );
      return r;
    }, null as unknown[] | null);
    return {
      ok: true,
      clients: rows ?? [],
      status: rows === null ? 'UNAVAILABLE' : 'AVAILABLE',
    };
  });

  app.get('/api/v1/positions', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) return deny(reply);
    const rows = await safeQuery(async () => {
      const { rows: r } = await pool.query(
        `SELECT * FROM positions ORDER BY opened_at DESC NULLS LAST LIMIT 500`
      );
      return r;
    }, null as unknown[] | null);
    return {
      ok: true,
      positions: rows ?? [],
      status: rows === null ? 'UNAVAILABLE' : 'AVAILABLE',
    };
  });

  app.get('/api/v1/orders', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) return deny(reply);
    const rows = await safeQuery(async () => {
      const { rows: r } = await pool.query(
        `SELECT * FROM orders ORDER BY created_at DESC NULLS LAST LIMIT 500`
      );
      return r;
    }, null as unknown[] | null);
    return {
      ok: true,
      orders: rows ?? [],
      status: rows === null ? 'UNAVAILABLE' : 'AVAILABLE',
    };
  });

  app.get('/api/v1/trades', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) return deny(reply);
    const rows = await safeQuery(async () => {
      const { rows: r } = await pool.query(
        `SELECT * FROM executions ORDER BY executed_at DESC NULLS LAST LIMIT 500`
      );
      return r;
    }, null as unknown[] | null);
    return {
      ok: true,
      trades: rows ?? [],
      status: rows === null ? 'UNAVAILABLE' : 'AVAILABLE',
    };
  });

  // NOTE: GET /api/v1/incidents is owned by mobileApiV1 (client + admin token).
  // Do NOT re-register here — Fastify FST_ERR_DUPLICATED_ROUTE crashes boot.

  app.get('/api/v1/events', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) return deny(reply);
    const recent = getEventBus().recent(100);
    const dbEvents = await safeQuery(async () => {
      const { rows } = await pool.query(
        `SELECT * FROM system_events ORDER BY created_at DESC LIMIT 100`
      );
      return rows;
    }, []);
    return {
      ok: true,
      events: recent,
      system_events: dbEvents,
      db_ok: await healthCheck(),
      status: 'AVAILABLE',
    };
  });
}
