/**
 * Admin Service / Admin Agent — authenticated management channel on VS SERVER.
 * ADMIN clients on another machine consume these endpoints.
 * Never returns Capital secrets. Never invents READY/LIVE telemetry.
 */

import type { FastifyInstance } from 'fastify';
import { collectHostSystemSnapshot } from './hostTelemetry.js';
import { evaluateReadiness, type ProbeResult } from './readiness.js';
import { getIncidentCenter } from './incidentCenter.js';
import { getEventBus } from './eventBus.js';
import { versionBundle } from './versions.js';
import { renderCoreTui, servicesFromProbes, type CoreTuiModel } from './coreTui.js';
import { FeedManager } from './feedManager.js';
import {
  buildServerMonitorSnapshot,
  renderServerMonitorFrame,
} from './serverMonitor.js';
import { evaluateSupervisor } from '../../../core/supervisor/src/orchestrator.js';
import { getKillSwitch, setKillSwitch } from './killSwitch.js';
import { classifyBrokerConfig } from '../../../core/broker/capital/health.js';
import {
  heartbeatPresence,
  getAdminPresence,
  listPresence,
} from './presenceRegistry.js';
import { hostname } from 'os';
import { normalizeNetworkSecret } from './network/networkSecrets.js';

export type AdminAgentDeps = {
  getProbes: () => ProbeResult[] | Promise<ProbeResult[]>;
  feedManager?: FeedManager;
  adminToken?: string;
  /** Optional live counters from robotDesk / registry */
  getLiveCounts?: () =>
    | {
        clients?: number | null;
        positions?: number | null;
        trading?: number | null;
      }
    | Promise<{
        clients?: number | null;
        positions?: number | null;
        trading?: number | null;
      }>;
};

function isPrivateClientIp(req: {
  ip?: string;
  ips?: string[];
  headers?: Record<string, unknown>;
  socket?: { remoteAddress?: string };
}): boolean {
  const candidates = [
    req.ip,
    ...(Array.isArray(req.ips) ? req.ips : []),
    req.socket?.remoteAddress,
    typeof req.headers?.['x-forwarded-for'] === 'string'
      ? String(req.headers['x-forwarded-for']).split(',')[0]?.trim()
      : undefined,
  ].filter(Boolean) as string[];
  for (const raw of candidates) {
    const ip = raw.replace(/^::ffff:/, '');
    if (ip === '127.0.0.1' || ip === '::1') return true;
    if (/^10\./.test(ip)) return true;
    if (/^192\.168\./.test(ip)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
  }
  return false;
}

function lanTrustAdminEnabled(): boolean {
  const v = String(process.env.VS_LAN_TRUST_ADMIN || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function authorizeAdmin(
  req: {
    headers: Record<string, unknown>;
    ip?: string;
    ips?: string[];
    socket?: { remoteAddress?: string };
  },
  expected?: string
): boolean {
  const want = normalizeNetworkSecret(expected ?? process.env.API_ADMIN_TOKEN);
  if (!want || want === 'CHANGE_ME_ADMIN_TOKEN') {
    // Dev only — production must set API_ADMIN_TOKEN
    return process.env.NODE_ENV !== 'production';
  }
  const token = normalizeNetworkSecret(String(req.headers['x-admin-token'] || ''));
  if (token === want) return true;
  // Home appliance: MSI on private LAN may read monitor / heartbeat without copying token first
  if (lanTrustAdminEnabled() && isPrivateClientIp(req)) return true;
  return false;
}

/** Physical i3 console only — never expose on LAN/WireGuard clients. */
function isLocalConsoleRequest(req: {
  ip?: string;
  ips?: string[];
  headers?: Record<string, unknown>;
  socket?: { remoteAddress?: string };
}): boolean {
  const candidates = [
    req.ip,
    ...(Array.isArray(req.ips) ? req.ips : []),
    req.socket?.remoteAddress,
    typeof req.headers?.['x-forwarded-for'] === 'string'
      ? String(req.headers['x-forwarded-for']).split(',')[0]?.trim()
      : undefined,
  ].filter(Boolean) as string[];
  for (const raw of candidates) {
    const ip = raw.replace(/^::ffff:/, '');
    if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  }
  return false;
}

function probeStatus(
  probes: ProbeResult[],
  name: string
): { status: string; detail: string } {
  const p = probes.find((x) => x.name === name);
  if (!p) return { status: 'NOT_READY', detail: 'NO_DATA' };
  return { status: String(p.status), detail: p.detail || '' };
}

export async function buildAdminSnapshot(deps: AdminAgentDeps): Promise<Record<string, unknown>> {
  const probes = await deps.getProbes();
  const readiness = evaluateReadiness(probes);
  const host = collectHostSystemSnapshot({
    cpuSampleMs: 80,
    probeNetwork: true,
    dataRoot: process.env.VS_CORE_DATA || process.env.VS_SERVER_DATA || '/',
  });
  const incidents = getIncidentCenter().list({ unresolved_only: true });
  const counts = (await deps.getLiveCounts?.()) || {};
  const feedSnap = deps.feedManager?.snapshot('GOLD') ?? null;

  const market = probeStatus(probes, 'MARKET');
  const strategy = probeStatus(probes, 'STRATEGY');
  const risk = probeStatus(probes, 'RISK');
  const execution = probeStatus(probes, 'EXECUTION');
  const capital = probeStatus(probes, 'CAPITAL');
  const reconcile = probeStatus(probes, 'RECONCILIATION');

  return {
    ok: true,
    role: 'admin_agent',
    connection: 'CONNECTED',
    server_id: host.server_id || hostname(),
    hostname: host.hostname,
    versions: versionBundle(),
    uptime_seconds: host.uptime_seconds,
    uptime_human: host.uptime_human,
    time_utc: host.time_utc,
    host: {
      cpu_percent: host.cpu_percent,
      cpu_status: host.cpu_status,
      ram_used_bytes: host.ram_used_bytes,
      ram_total_bytes: host.ram_total_bytes,
      ram_status: host.ram_status,
      ssd_used_bytes: host.ssd_used_bytes,
      ssd_total_bytes: host.ssd_total_bytes,
      ssd_status: host.ssd_status,
      network_online: host.network_online,
      network_latency_ms: host.network_latency_ms,
      network_status: host.network_status,
      time_sync_ok: host.time_sync_ok,
      time_sync_status: host.time_sync_status,
    },
    core: {
      state: readiness.state,
      live_ready: readiness.live_ready === true,
      reason_code: readiness.reason_code || null,
    },
    market: {
      status: market.status,
      detail: market.detail,
      primary_feed: feedSnap?.primary_status || 'NO_DATA',
      feed_age_ms: feedSnap?.primary?.age_ms ?? null,
      allows_execution: feedSnap?.allows_execution ?? false,
    },
    strategy,
    risk,
    execution,
    capital,
    reconciliation: reconcile,
    clients: {
      count: counts.clients ?? null,
      trading: counts.trading ?? null,
    },
    positions: {
      count: counts.positions ?? null,
    },
    incidents: {
      unresolved: incidents.length,
      critical: incidents.filter((i) => i.severity === 'CRITICAL').length,
      error: incidents.filter((i) => i.severity === 'ERROR').length,
      warning: incidents.filter((i) => i.severity === 'WARNING').length,
    },
    // Explicit: never claim LIVE from this channel alone
    live_ready: false,
    secrets_exposed: false,
  };
}

export async function registerAdminAgentRoutes(
  app: FastifyInstance,
  deps: AdminAgentDeps
): Promise<void> {
  const token = deps.adminToken ?? process.env.API_ADMIN_TOKEN;

  app.get('/api/v1/admin/ping', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    const host = collectHostSystemSnapshot({
      cpuSampleMs: 20,
      probeNetwork: false,
      dataRoot: process.env.VS_CORE_DATA || '/',
    });
    return {
      ok: true,
      server_id: host.server_id || hostname(),
      time_utc: new Date().toISOString(),
      uptime_seconds: host.uptime_seconds,
    };
  });

  /**
   * Home LAN bootstrap for MSI ADMIN — only when VS_LAN_TRUST_ADMIN=1 and caller is private IP.
   * Returns non-secret identity + API_ADMIN_TOKEN so MSI can write control-panel.env.
   */
  app.get('/api/v1/admin/lan-bootstrap', async (req, reply) => {
    if (!lanTrustAdminEnabled() || !isPrivateClientIp(req as Parameters<typeof isPrivateClientIp>[0])) {
      return reply.code(403).send({ ok: false, code: 'LAN_TRUST_REQUIRED' });
    }
    const want = normalizeNetworkSecret(token || process.env.API_ADMIN_TOKEN || '');
    if (!want || want === 'CHANGE_ME_ADMIN_TOKEN') {
      return reply.code(503).send({ ok: false, code: 'TOKEN_NOT_CONFIGURED' });
    }
    return {
      ok: true,
      service: 'VS-CORE',
      server_id: process.env.VS_SERVER_ID || 'VS-CORE-01',
      api_admin_token: want,
      control_api_port: Number(process.env.CONTROL_API_PORT || 3000),
    };
  });

  app.get('/api/v1/admin/snapshot', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    return buildAdminSnapshot(deps);
  });

  app.get('/api/v1/admin/health', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    // Back-compat thin view of snapshot
    const snap = await buildAdminSnapshot(deps);
    return {
      ok: true,
      role: 'admin_agent',
      versions: snap.versions,
      readiness: {
        state: (snap.core as { state: string }).state,
        live_ready: false,
      },
      host: snap.host,
      server_id: snap.server_id,
      uptime_human: snap.uptime_human,
      incidents_unresolved: (snap.incidents as { unresolved: number }).unresolved,
    };
  });

  app.get('/api/v1/admin/tui', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    const probes = await deps.getProbes();
    const readiness = evaluateReadiness(probes);
    const host = collectHostSystemSnapshot({
      cpuSampleMs: 50,
      probeNetwork: true,
      dataRoot: process.env.VS_CORE_DATA || '/',
    });
    const center = getIncidentCenter();
    const model: CoreTuiModel = {
      host,
      readiness,
      services: servicesFromProbes(probes),
      feeds: deps.feedManager?.snapshot('GOLD') ?? null,
      capital: {
        connection: probes.find((p) => p.name === 'CAPITAL')?.status || 'NO_DATA',
        accounts: null,
        positions: null,
        working_orders: null,
        last_sync: null,
        latency_ms: null,
      },
      clients: {
        registered: null,
        active: null,
        trading: null,
        paused: null,
        disabled: null,
      },
      incidents: {
        critical: center.list({ severity: 'CRITICAL', unresolved_only: true }).length,
        error: center.list({ severity: 'ERROR', unresolved_only: true }).length,
        warning: center.list({ severity: 'WARNING', unresolved_only: true }).length,
        info: 0,
      },
      events: getEventBus().recent(20),
    };
    const text = renderCoreTui(model);
    reply.header('content-type', 'text/plain; charset=utf-8');
    return text;
  });

  /**
   * Unified health/status contract for MSI ADMIN + i3 local SERVER MONITOR.
   * Auth: x-admin-token. Never returns secrets. Never invents ONLINE.
   */
  app.get('/api/v1/server/monitor', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    return buildServerMonitorSnapshot({
      getProbes: deps.getProbes,
      apiSelfOnline: true,
    });
  });

  app.get('/api/v1/server/monitor/text', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    const snap = await buildServerMonitorSnapshot({
      getProbes: deps.getProbes,
      apiSelfOnline: true,
    });
    reply.header('content-type', 'text/plain; charset=utf-8');
    return renderServerMonitorFrame(snap);
  });

  /**
   * Local console monitor for physical i3 — 127.0.0.1 / ::1 only.
   * No admin token required so the monitor never sources server.env secrets.
   * Never returns secrets. Rejects non-localhost (LAN/WG) with 403.
   */
  app.get('/api/v1/server/monitor/console', async (req, reply) => {
    if (!isLocalConsoleRequest(req as Parameters<typeof isLocalConsoleRequest>[0])) {
      return reply.code(403).send({ ok: false, code: 'LOCALHOST_ONLY' });
    }
    return buildServerMonitorSnapshot({
      getProbes: deps.getProbes,
      apiSelfOnline: true,
    });
  });

  app.get('/api/v1/server/monitor/console/text', async (req, reply) => {
    if (!isLocalConsoleRequest(req as Parameters<typeof isLocalConsoleRequest>[0])) {
      return reply.code(403).send({ ok: false, code: 'LOCALHOST_ONLY' });
    }
    const snap = await buildServerMonitorSnapshot({
      getProbes: deps.getProbes,
      apiSelfOnline: true,
    });
    reply.header('content-type', 'text/plain; charset=utf-8');
    return renderServerMonitorFrame(snap);
  });

  /** Supervisor: process_ready vs trading_ready (fail-closed). */
  app.get('/api/v1/system/supervisor', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    const [sup, kill, broker] = await Promise.all([
      evaluateSupervisor(),
      getKillSwitch(),
      Promise.resolve(classifyBrokerConfig()),
    ]);
    return {
      ...sup,
      kill_switch: kill,
      broker,
      trading_ready: sup.trading_ready && !kill.active && broker.state !== 'CONFIG_REQUIRED',
      trading_blockers: [
        ...sup.trading_blockers,
        ...(kill.active ? ['KILL_SWITCH'] : []),
        ...(broker.state === 'CONFIG_REQUIRED' ? ['BROKER_CONFIG_REQUIRED'] : []),
      ],
    };
  });

  app.get('/api/v1/system/kill-switch', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    return { ok: true, ...(await getKillSwitch()) };
  });

  app.post('/api/v1/system/kill-switch', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    const body = (req.body || {}) as { active?: boolean; reason?: string };
    if (typeof body.active !== 'boolean') {
      return reply.code(400).send({ ok: false, code: 'INVALID_BODY' });
    }
    const state = await setKillSwitch({
      active: body.active,
      reason: body.reason,
      changed_by: 'admin',
    });
    return { ok: true, ...state };
  });

  app.get('/api/v1/broker/health', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    return { ok: true, ...classifyBrokerConfig() };
  });

  /** ADMIN / CLIENT presence heartbeat — drives i3 CONNECTED/DISCONNECTED. */
  app.post('/api/v1/presence/heartbeat', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    const body = (req.body || {}) as {
      device_id?: string;
      display_name?: string;
      role?: 'ADMIN' | 'CLIENT' | 'MONITOR';
      transport?: 'LAN' | 'WIREGUARD' | 'NONE' | 'UNKNOWN';
      source_ip?: string;
      vpn_ip?: string;
      app_version?: string;
      session_id?: string;
      wg_connected?: boolean;
    };
    if (!body.device_id || !body.role) {
      return reply.code(400).send({ ok: false, code: 'INVALID_BODY' });
    }
    const rec = heartbeatPresence({
      device_id: body.device_id,
      display_name: body.display_name,
      role: body.role,
      transport: body.transport,
      source_ip: body.source_ip ?? null,
      vpn_ip: body.vpn_ip ?? null,
      app_version: body.app_version ?? null,
      session_id: body.session_id ?? null,
      wg_connected: body.wg_connected ?? null,
    });
    return { ok: true, presence: rec };
  });

  app.get('/api/v1/presence', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    return {
      ok: true,
      admin: getAdminPresence(),
      admins: listPresence('ADMIN'),
      clients: listPresence('CLIENT'),
      monitors: listPresence('MONITOR'),
    };
  });

  /** SSE event stream for server panel / admin live updates. */
  app.get('/api/v1/events/stream', async (req, reply) => {
    if (!authorizeAdmin(req as { headers: Record<string, unknown> }, token)) {
      return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = async () => {
      try {
        const snap = await buildServerMonitorSnapshot({
          getProbes: deps.getProbes,
          apiSelfOnline: true,
        });
        const admin = getAdminPresence();
        const payload = JSON.stringify({
          type: 'snapshot',
          at: new Date().toISOString(),
          monitor: snap,
          presence: {
            admin,
            clients: listPresence('CLIENT'),
          },
        });
        res.write(`event: snapshot\ndata: ${payload}\n\n`);
      } catch (e) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ message: e instanceof Error ? e.message : 'error' })}\n\n`
        );
      }
    };
    await send();
    const timer = setInterval(send, 2000);
    req.raw.on('close', () => {
      clearInterval(timer);
    });
  });
}
