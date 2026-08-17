/**
 * Server monitor contract — never invent ONLINE / OPEN; failures stay explicit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { registerAdminAgentRoutes } from './adminAgent.js';
import { probe } from './readiness.js';
import {
  buildServerMonitorSnapshot,
  offlineServerMonitorSnapshot,
  renderServerMonitorFrame,
} from './serverMonitor.js';
import { getDeviceRegistry } from './network/deviceRegistry.js';
import { resetDeviceRegistryForTests } from './network/deviceRegistry.js';

const probesOk = () => [
  probe('NETWORK', 'OK', 'ok'),
  probe('TIME', 'OK', 'ok'),
  probe('STORAGE', 'OK', 'ok'),
  probe('DATABASE', 'OK', 'ok'),
  probe('MARKET', 'WARNING', 'awaiting quote', 'MARKET_WAITING'),
  probe('CAPITAL', 'ERROR', 'unverified', 'CAPITAL_UNVERIFIED'),
  probe('STRATEGY', 'OK', 'ok'),
  probe('RISK', 'OK', 'ok'),
  probe('EXECUTION', 'OK', 'ok'),
  probe('RECONCILIATION', 'OK', 'ok'),
  probe('CONTROL_API', 'OK', 'up'),
];

const procOnline = async () => ({
  status: 'ONLINE' as const,
  latency_ms: null,
  detail: 'test process',
  error: null,
});

const procOffline = async () => ({
  status: 'OFFLINE' as const,
  latency_ms: null,
  detail: 'stopped',
  error: 'stopped',
});

describe('serverMonitor builder', () => {
  let dataRoot: string;
  const prevLan = process.env.VS_LAN_MANAGEMENT;
  const prevLive = process.env.LIVE_TRADING_ENABLED;

  beforeAll(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'vs-mon-'));
    process.env.VS_LAN_MANAGEMENT = '1';
    process.env.LIVE_TRADING_ENABLED = 'false';
    process.env.VS_SERVER_ID = 'VS-CORE-01';
  });

  afterAll(() => {
    if (prevLan === undefined) delete process.env.VS_LAN_MANAGEMENT;
    else process.env.VS_LAN_MANAGEMENT = prevLan;
    if (prevLive === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = prevLive;
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('reports server ONLINE when API self-online and postgres ok', async () => {
    const s = await buildServerMonitorSnapshot({
      getProbes: probesOk,
      apiSelfOnline: true,
      dataRoot,
      checkServerProcess: procOnline,
      checkPostgres: async () => ({ ok: true, detail: 'ok' }),
      checkRedis: async () => ({ ok: true, detail: 'PONG' }),
      checkWireguard: async () => ({ state: 'ONLINE', detail: 'vs0 UP' }),
    });
    expect(s.services.server.state).toBe('ONLINE');
    expect(s.services.api.state).toBe('ONLINE');
    expect(s.api.status).toBe('ONLINE');
    expect(s.database.status).toBe('ONLINE');
    expect(s.services.postgres.state).toBe('ONLINE');
    expect(s.services.redis.state).toBe('ONLINE');
    expect(s.services.wireguard.state).toBe('ONLINE');
    expect(s.strategy.status).toBe('OK');
    expect(s.live_trading_enabled).toBe(false);
    expect(s.trading.enabled).toBe(false);
    expect(s.market.state).toBe('UNKNOWN'); // WARNING must not become OPEN
  });

  it('keeps SERVER PROCESS independent from CONTROL API', async () => {
    const s = await buildServerMonitorSnapshot({
      getProbes: probesOk,
      apiSelfOnline: false,
      dataRoot,
      checkServerProcess: procOnline,
      checkPostgres: async () => ({ ok: true, detail: 'ok' }),
      checkRedis: async () => ({ ok: true, detail: 'PONG' }),
      checkWireguard: async () => ({ state: 'ONLINE', detail: 'vs0' }),
    });
    expect(s.server_process.status).toBe('ONLINE');
    expect(s.api.status).toBe('OFFLINE');
    expect(s.ok).toBe(false);
  });

  it('reports API OFFLINE when apiSelfOnline=false', async () => {
    const s = await buildServerMonitorSnapshot({
      getProbes: probesOk,
      apiSelfOnline: false,
      dataRoot,
      checkServerProcess: procOffline,
      checkPostgres: async () => ({ ok: true, detail: 'ok' }),
      checkRedis: async () => ({ ok: true, detail: 'PONG' }),
      checkWireguard: async () => ({ state: 'ONLINE', detail: 'vs0' }),
    });
    expect(s.services.server.state).toBe('OFFLINE');
    expect(s.services.api.state).toBe('OFFLINE');
    expect(s.ok).toBe(false);
  });

  it('reports postgres OFFLINE with real reason', async () => {
    const s = await buildServerMonitorSnapshot({
      getProbes: probesOk,
      dataRoot,
      checkServerProcess: procOnline,
      checkPostgres: async () => ({
        ok: false,
        detail: 'PostgreSQL connection refused',
      }),
      checkRedis: async () => ({ ok: true, detail: 'PONG' }),
      checkWireguard: async () => ({ state: 'ONLINE', detail: 'vs0' }),
    });
    expect(s.services.postgres.state).toBe('OFFLINE');
    expect(s.database.status).toBe('OFFLINE');
    expect(s.last_error).toContain('POSTGRES');
    expect(s.errors.some((e) => /PostgreSQL connection refused/.test(e))).toBe(true);
  });

  it('reports redis OFFLINE and WARNING distinctly', async () => {
    const down = await buildServerMonitorSnapshot({
      getProbes: probesOk,
      dataRoot,
      checkPostgres: async () => ({ ok: true, detail: 'ok' }),
      checkRedis: async () => ({ ok: false, detail: 'connection refused on 127.0.0.1:6379' }),
      checkWireguard: async () => ({ state: 'ONLINE', detail: 'vs0' }),
    });
    expect(down.services.redis.state).toBe('OFFLINE');

    const warn = await buildServerMonitorSnapshot({
      getProbes: probesOk,
      dataRoot,
      checkPostgres: async () => ({ ok: true, detail: 'ok' }),
      checkRedis: async () => ({
        ok: false,
        detail: 'port open; redis-cli ping unavailable',
        warning: true,
      }),
      checkWireguard: async () => ({ state: 'ONLINE', detail: 'vs0' }),
    });
    expect(warn.services.redis.state).toBe('WARNING');
  });

  it('reports WireGuard OFFLINE / WARNING without inventing ONLINE', async () => {
    const off = await buildServerMonitorSnapshot({
      getProbes: probesOk,
      dataRoot,
      checkPostgres: async () => ({ ok: true, detail: 'ok' }),
      checkRedis: async () => ({ ok: true, detail: 'PONG' }),
      checkWireguard: async () => ({ state: 'OFFLINE', detail: 'vs0 has no IPv4' }),
    });
    expect(off.services.wireguard.state).toBe('OFFLINE');

    const warn = await buildServerMonitorSnapshot({
      getProbes: probesOk,
      dataRoot,
      checkPostgres: async () => ({ ok: true, detail: 'ok' }),
      checkRedis: async () => ({ ok: true, detail: 'PONG' }),
      checkWireguard: async () => ({
        state: 'WARNING',
        detail: 'vs0 down (LAN ADMIN may still work)',
      }),
    });
    expect(warn.services.wireguard.state).toBe('WARNING');
  });

  it('reports ADMIN UNKNOWN when no device; DISCONNECTED when enrolled offline', async () => {
    resetDeviceRegistryForTests(dataRoot);
    const none = await buildServerMonitorSnapshot({
      getProbes: probesOk,
      dataRoot,
      checkPostgres: async () => ({ ok: true, detail: 'ok' }),
      checkRedis: async () => ({ ok: true, detail: 'PONG' }),
      checkWireguard: async () => ({ state: 'ONLINE', detail: 'vs0' }),
    });
    expect(none.admin.status).toBe('NOT_CONFIGURED');
    expect(none.admin.transport).toBe('NONE');

    const reg = getDeviceRegistry(dataRoot);
    const d = reg.registerPending({
      device_id: 'VS-ADMIN-MSI-01',
      device_name: 'MSI',
      device_type: 'ADMIN',
      public_key: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=',
      device_token: 'tok-test-admin-device-0001',
    }, { timeout: 15_000 });
    reg.approve(d.device_id);
    // enrolled but never heartbeat → DISCONNECTED / OFFLINE
    const disc = await buildServerMonitorSnapshot({
      getProbes: probesOk,
      dataRoot,
      checkPostgres: async () => ({ ok: true, detail: 'ok' }),
      checkRedis: async () => ({ ok: true, detail: 'PONG' }),
      checkWireguard: async () => ({ state: 'ONLINE', detail: 'vs0' }),
    });
    expect(disc.admin.device_id).toBe(d.device_id);
    expect(disc.admin.connected).toBe(false);
    expect(disc.admin.status).toBe('OFFLINE');
    expect(disc.admin.transport).toBe('LAN');

    reg.heartbeat(d.device_id, {});
    const up = await buildServerMonitorSnapshot({
      getProbes: probesOk,
      dataRoot,
      checkServerProcess: procOnline,
      checkPostgres: async () => ({ ok: true, detail: 'ok' }),
      checkRedis: async () => ({ ok: true, detail: 'PONG' }),
      checkWireguard: async () => ({ state: 'ONLINE', detail: 'vs0' }),
    });
    expect(up.admin.connected).toBe(true);
    expect(up.admin.status).toBe('ONLINE');
    expect(up.admin.transport).toBe('LAN');
  });

  it('offline snapshot never invents ONLINE; build identity present', () => {
    const s = offlineServerMonitorSnapshot('ECONNREFUSED');
    expect(s.services.api.state).toBe('OFFLINE');
    expect(s.api.status).toBe('OFFLINE');
    expect(s.services.postgres.state).toBe('UNKNOWN');
    expect(s.services.redis.state).toBe('UNKNOWN');
    expect(s.market.state).toBe('UNKNOWN');
    expect(s.strategy.status).toBe('OFFLINE');
    expect(s.build.service).toBe('VS-CORE');
    expect(s.build.build_commit).toBeTruthy();
    expect(s.ok).toBe(false);
    const frame = renderServerMonitorFrame(s);
    expect(frame).toContain('VS CORE SERVER');
    expect(frame).toContain('OFFLINE');
    expect(frame).toContain('BUILD / VERSION');
    expect(frame).toContain('READ-ONLY');
    expect(frame).not.toMatch(/POSTGRES\s+●\s+ONLINE/);
  });

  it('MARKET WARNING stays UNKNOWN not OPEN', async () => {
    const s = await buildServerMonitorSnapshot({
      getProbes: () => [probe('MARKET', 'WARNING', 'waiting', 'MARKET_WAITING')],
      dataRoot,
      checkServerProcess: procOnline,
      checkPostgres: async () => ({ ok: true, detail: 'ok' }),
      checkRedis: async () => ({ ok: true, detail: 'PONG' }),
      checkWireguard: async () => ({ state: 'ONLINE', detail: 'vs0' }),
    });
    expect(s.market.state).toBe('UNKNOWN');
  });
});

describe('GET /api/v1/server/monitor', () => {
  const token = 'monitor-admin-token';
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.LIVE_TRADING_ENABLED = 'false';
    app = Fastify({ logger: false });
    await registerAdminAgentRoutes(app, {
      adminToken: token,
      getProbes: probesOk,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects missing token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/server/monitor' });
    expect(res.statusCode).toBe(401);
  });

  it('returns contract fields without secrets', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/server/monitor',
      headers: { 'x-admin-token': token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.role).toBe('server_monitor');
    expect(body.server_id).toBeTruthy();
    expect(body.server_version).toBeTruthy();
    expect(body.api).toBeTruthy();
    expect(body.database).toBeTruthy();
    expect(body.strategy).toBeTruthy();
    expect(body.wireguard.listen_port).toBeTruthy();
    expect(body.admin).toBeTruthy();
    expect(body.clients).toBeTruthy();
    expect(body.market).toBeTruthy();
    expect(body.trading.enabled).toBe(false);
    expect(body.live_trading_enabled).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/API_ADMIN_TOKEN|private_key|BEGIN /i);
  });

  it('text frame endpoint is plaintext', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/server/monitor/text',
      headers: { 'x-admin-token': token },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toMatch(/text\/plain/);
    expect(res.body).toContain('VS CORE SERVER');
    expect(res.body).toContain('READ-ONLY');
  });

  it('localhost console monitor requires no admin token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/server/monitor/console',
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.role).toBe('server_monitor');
    expect(JSON.stringify(body)).not.toMatch(/API_ADMIN_TOKEN|private_key|BEGIN /i);
  });

  it('console text works from localhost without token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/server/monitor/console/text',
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('VS CORE SERVER');
    expect(res.body).toContain('[ ADMIN ]');
    expect(res.body).toContain('[ CLIENTS ]');
  });

  it('console rejects non-localhost', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/server/monitor/console',
      remoteAddress: '192.168.0.50',
    });
    expect(res.statusCode).toBe(403);
  });
});
