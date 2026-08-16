/**
 * Authoritative server monitor status — shared by MSI ADMIN and i3 local monitor.
 * Never invents ONLINE. Never exposes secrets. LIVE trading stays fail-closed elsewhere.
 */

import { createConnection } from 'net';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { collectHostSystemSnapshot } from './hostTelemetry.js';
import { evaluateReadiness, type ProbeResult } from './readiness.js';
import { getDeviceRegistry } from './network/deviceRegistry.js';
import { healthCheck } from '../db/pool.js';
import { CORE_VERSION } from './versions.js';
import { hostname } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);

export type MonitorState = 'ONLINE' | 'OFFLINE' | 'WARNING' | 'UNKNOWN';

export type ServerMonitorSnapshot = {
  ok: boolean;
  role: 'server_monitor';
  server_id: string;
  server_version: string;
  hostname: string;
  uptime_seconds: number;
  uptime_human: string;
  timestamp: string;
  live_trading_enabled: boolean;
  operating_mode: string;
  services: {
    server: { state: MonitorState; detail: string };
    api: { state: MonitorState; detail: string };
    postgres: { state: MonitorState; detail: string };
    redis: { state: MonitorState; detail: string };
    wireguard: { state: MonitorState; detail: string };
    network: { state: MonitorState; detail: string };
  };
  admin: {
    connected: boolean;
    state: MonitorState;
    device_id: string | null;
    transport: 'LAN' | 'WIREGUARD' | 'NONE' | 'UNKNOWN';
    last_seen: string | null;
  };
  clients: {
    total: number;
    online: number;
    offline: number;
    devices: Array<{
      device_id: string;
      status: string;
      connection_state: string;
      last_seen: string | null;
    }>;
  };
  market: {
    state: 'OPEN' | 'CLOSED' | 'UNKNOWN';
    detail: string;
  };
  trading: {
    enabled: boolean;
    mode: string;
    detail: string;
  };
  system: {
    cpu_percent: number | null;
    ram_percent: number | null;
    disk_percent: number | null;
    cpu_status: string;
    ram_status: string;
    disk_status: string;
  };
  last_error: string | null;
  errors: string[];
};

function dataRootDefault(): string {
  return (
    process.env.VS_SERVER_DATA ||
    process.env.VS_CORE_DATA ||
    join(process.cwd(), 'data', 'vs-server')
  );
}

function tcpProbe(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (ok: boolean) => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

export async function defaultRedisCheck(): Promise<{
  ok: boolean;
  detail: string;
  warning?: boolean;
}> {
  const port = Number(process.env.REDIS_PORT || 6379);
  const up = await tcpProbe('127.0.0.1', port);
  if (!up) return { ok: false, detail: `connection refused on 127.0.0.1:${port}` };
  try {
    const { stdout } = await execFileAsync(
      'redis-cli',
      ['-h', '127.0.0.1', '-p', String(port), 'ping'],
      { timeout: 1500 }
    );
    if (/PONG/i.test(stdout)) return { ok: true, detail: 'PONG' };
    return { ok: false, detail: 'unexpected redis-cli reply', warning: true };
  } catch {
    // Port open but redis-cli missing/failed — WARNING, never claim ONLINE
    return { ok: false, detail: 'port open; redis-cli ping unavailable', warning: true };
  }
}

export async function defaultWireguardCheck(
  iface: string
): Promise<{ state: MonitorState; detail: string }> {
  try {
    const { stdout } = await execFileAsync('ip', ['-4', '-br', 'addr', 'show', 'dev', iface], {
      timeout: 1500,
    });
    const line = stdout.trim();
    if (line && /UP|UNKNOWN/i.test(line.split(/\s+/)[1] || '') && /\d+\.\d+\.\d+\.\d+/.test(line)) {
      return { state: 'ONLINE', detail: line.replace(/\s+/g, ' ') };
    }
    if (line && /\d+\.\d+\.\d+\.\d+/.test(line)) {
      return { state: 'ONLINE', detail: line.replace(/\s+/g, ' ') };
    }
    return { state: 'OFFLINE', detail: `${iface} has no IPv4` };
  } catch {
    return {
      state: 'WARNING',
      detail: `${iface} down (LAN ADMIN may still work with VS_LAN_MANAGEMENT=1)`,
    };
  }
}

export async function defaultPostgresCheck(): Promise<{ ok: boolean; detail: string }> {
  try {
    const ok = await healthCheck();
    return { ok, detail: ok ? 'healthCheck OK' : 'Postgres healthCheck failed' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : 'Postgres probe error' };
  }
}

function pct(used: number | null, total: number | null): number | null {
  if (used == null || total == null || !total) return null;
  return Math.round((used / total) * 1000) / 10;
}

function marketFromProbes(probes: ProbeResult[]): {
  state: 'OPEN' | 'CLOSED' | 'UNKNOWN';
  detail: string;
} {
  const m = probes.find((p) => p.name === 'MARKET');
  if (!m) return { state: 'UNKNOWN', detail: 'NO_DATA' };
  if (m.status === 'OK') return { state: 'OPEN', detail: m.detail || 'OK' };
  if (m.status === 'ERROR') return { state: 'CLOSED', detail: m.detail || 'ERROR' };
  // WARNING / NOT_READY / anything else stays UNKNOWN — never invent OPEN
  return { state: 'UNKNOWN', detail: `${m.status}: ${m.detail || ''}`.trim() };
}

function inferAdminTransport(
  privateAddress: string | null | undefined
): ServerMonitorSnapshot['admin']['transport'] {
  // Home MSI ADMIN uses LAN when VS_LAN_MANAGEMENT is enabled (working path).
  if (process.env.VS_LAN_MANAGEMENT === '1' || process.env.VS_LAN_MANAGEMENT === 'true') {
    return 'LAN';
  }
  if (privateAddress?.startsWith('10.77.')) return 'WIREGUARD';
  if (privateAddress) return 'LAN';
  return 'UNKNOWN';
}

export type BuildMonitorDeps = {
  getProbes: () => ProbeResult[] | Promise<ProbeResult[]>;
  /** When API process is answering this request */
  apiSelfOnline?: boolean;
  dataRoot?: string;
  checkPostgres?: () => Promise<{ ok: boolean; detail: string }>;
  checkRedis?: () => Promise<{ ok: boolean; detail: string; warning?: boolean }>;
  checkWireguard?: () => Promise<{ state: MonitorState; detail: string }>;
};

/** Snapshot when the local monitor cannot reach Control API (API OFFLINE). */
export function offlineServerMonitorSnapshot(reason: string): ServerMonitorSnapshot {
  const host = (() => {
    try {
      return collectHostSystemSnapshot({
        cpuSampleMs: 20,
        probeNetwork: false,
        dataRoot: dataRootDefault(),
      });
    } catch {
      return null;
    }
  })();
  const detail = reason || 'API unreachable';
  return {
    ok: false,
    role: 'server_monitor',
    server_id: process.env.VS_SERVER_ID || host?.server_id || `VS-CORE-${hostname()}`,
    server_version: CORE_VERSION,
    hostname: host?.hostname || hostname(),
    uptime_seconds: host?.uptime_seconds ?? 0,
    uptime_human: host?.uptime_human || 'UNKNOWN',
    timestamp: new Date().toISOString(),
    live_trading_enabled: process.env.LIVE_TRADING_ENABLED === 'true',
    operating_mode: process.env.OPERATING_MODE || 'PAPER',
    services: {
      server: { state: 'UNKNOWN', detail: 'cannot confirm (API down)' },
      api: { state: 'OFFLINE', detail },
      postgres: { state: 'UNKNOWN', detail: 'not probed (API down)' },
      redis: { state: 'UNKNOWN', detail: 'not probed (API down)' },
      wireguard: { state: 'UNKNOWN', detail: 'not probed (API down)' },
      network: { state: 'UNKNOWN', detail: 'not probed (API down)' },
    },
    admin: {
      connected: false,
      state: 'UNKNOWN',
      device_id: null,
      transport: 'UNKNOWN',
      last_seen: null,
    },
    clients: { total: 0, online: 0, offline: 0, devices: [] },
    market: { state: 'UNKNOWN', detail: 'API unavailable' },
    trading: {
      enabled: process.env.LIVE_TRADING_ENABLED === 'true',
      mode: process.env.OPERATING_MODE || 'PAPER',
      detail: 'status unavailable while API offline',
    },
    system: {
      cpu_percent: host?.cpu_percent ?? null,
      ram_percent: host ? pct(host.ram_used_bytes, host.ram_total_bytes) : null,
      disk_percent: host ? pct(host.ssd_used_bytes, host.ssd_total_bytes) : null,
      cpu_status: host?.cpu_status || 'UNKNOWN',
      ram_status: host?.ram_status || 'UNKNOWN',
      disk_status: host?.ssd_status || 'UNKNOWN',
    },
    last_error: `API: ${detail}`,
    errors: [`API: ${detail}`],
  };
}

export async function buildServerMonitorSnapshot(
  deps: BuildMonitorDeps
): Promise<ServerMonitorSnapshot> {
  const errors: string[] = [];
  const probes = await deps.getProbes();
  evaluateReadiness(probes); // keep readiness evaluation for side-effect-free consistency
  const root = deps.dataRoot || dataRootDefault();
  const host = collectHostSystemSnapshot({
    cpuSampleMs: 50,
    probeNetwork: true,
    dataRoot: root,
  });

  const pg = await (deps.checkPostgres || defaultPostgresCheck)();
  if (!pg.ok) errors.push(`POSTGRES: ${pg.detail}`);

  const redis = await (deps.checkRedis || defaultRedisCheck)();
  if (!redis.ok) errors.push(`REDIS: ${redis.detail}`);

  const wgIface = process.env.VS_WG_INTERFACE || 'vs0';
  const wg = await (deps.checkWireguard || (() => defaultWireguardCheck(wgIface)))();
  if (wg.state === 'OFFLINE') errors.push(`WIREGUARD: ${wg.detail}`);

  const networkState: MonitorState = host.network_online
    ? host.network_status === 'OK'
      ? 'ONLINE'
      : 'WARNING'
    : 'OFFLINE';
  if (networkState === 'OFFLINE') errors.push('NETWORK: offline');

  let adminConnected = false;
  let adminDeviceId: string | null = null;
  let adminLastSeen: string | null = null;
  let adminTransport: ServerMonitorSnapshot['admin']['transport'] = 'UNKNOWN';
  const clientDevices: ServerMonitorSnapshot['clients']['devices'] = [];
  let clientsOnline = 0;
  let clientsTotal = 0;

  try {
    const reg = getDeviceRegistry(root);
    const devices = reg.list();
    for (const d of devices) {
      if (d.device_type === 'ADMIN') {
        const online =
          d.status === 'ACTIVE' &&
          (d.connection_state === 'CONNECTED' || d.connection_state === 'ONLINE');
        if (online || (!adminConnected && d.status === 'ACTIVE')) {
          adminDeviceId = d.device_id;
          adminLastSeen = d.last_seen;
          adminConnected = online;
          adminTransport = inferAdminTransport(d.private_address || d.private_ip);
        }
      }
      if (d.device_type === 'CLIENT') {
        clientsTotal += 1;
        const online =
          d.status === 'ACTIVE' &&
          (d.connection_state === 'CONNECTED' || d.connection_state === 'ONLINE');
        if (online) clientsOnline += 1;
        clientDevices.push({
          device_id: d.device_id,
          status: d.status,
          connection_state: d.connection_state || 'UNKNOWN',
          last_seen: d.last_seen,
        });
      }
    }
    if (!adminDeviceId) {
      adminTransport = 'NONE';
    }
  } catch (e) {
    errors.push(`REGISTRY: ${e instanceof Error ? e.message : 'unavailable'}`);
    adminTransport = 'UNKNOWN';
  }

  if (!adminConnected && adminDeviceId) {
    errors.push(`ADMIN: ${adminDeviceId} disconnected`);
  }

  const liveEnabled = process.env.LIVE_TRADING_ENABLED === 'true';
  const mode = process.env.OPERATING_MODE || 'PAPER';
  const market = marketFromProbes(probes);

  const apiOnline = deps.apiSelfOnline !== false;
  const serverOnline = apiOnline;

  const redisState: MonitorState = redis.ok
    ? 'ONLINE'
    : redis.warning
      ? 'WARNING'
      : 'OFFLINE';

  const last_error = errors.length ? errors[errors.length - 1] : null;

  return {
    ok: pg.ok && apiOnline,
    role: 'server_monitor',
    server_id: host.server_id || process.env.VS_SERVER_ID || `VS-CORE-${hostname()}`,
    server_version: CORE_VERSION,
    hostname: host.hostname,
    uptime_seconds: host.uptime_seconds,
    uptime_human: host.uptime_human,
    timestamp: new Date().toISOString(),
    live_trading_enabled: liveEnabled,
    operating_mode: mode,
    services: {
      server: {
        state: serverOnline ? 'ONLINE' : 'OFFLINE',
        detail: serverOnline ? 'control-api process' : 'API process not serving',
      },
      api: {
        state: apiOnline ? 'ONLINE' : 'OFFLINE',
        detail: apiOnline ? `port ${process.env.CONTROL_API_PORT || 3000}` : 'no /health',
      },
      postgres: {
        state: pg.ok ? 'ONLINE' : 'OFFLINE',
        detail: pg.detail,
      },
      redis: {
        state: redisState,
        detail: redis.detail,
      },
      wireguard: wg,
      network: {
        state: networkState,
        detail: host.network_online
          ? host.network_latency_ms != null
            ? `latency ${host.network_latency_ms}ms`
            : 'online'
          : 'offline',
      },
    },
    admin: {
      connected: adminConnected,
      state: adminConnected ? 'ONLINE' : adminDeviceId ? 'OFFLINE' : 'UNKNOWN',
      device_id: adminDeviceId,
      transport: adminDeviceId ? adminTransport : 'NONE',
      last_seen: adminLastSeen,
    },
    clients: {
      total: clientsTotal,
      online: clientsOnline,
      offline: Math.max(0, clientsTotal - clientsOnline),
      devices: clientDevices.slice(0, 32),
    },
    market,
    trading: {
      enabled: liveEnabled,
      mode,
      detail: liveEnabled
        ? 'LIVE_TRADING_ENABLED=true'
        : `LIVE_TRADING_ENABLED=false MODE=${mode}`,
    },
    system: {
      cpu_percent: host.cpu_percent,
      ram_percent: pct(host.ram_used_bytes, host.ram_total_bytes),
      disk_percent: pct(host.ssd_used_bytes, host.ssd_total_bytes),
      cpu_status: host.cpu_status,
      ram_status: host.ram_status,
      disk_status: host.ssd_status,
    },
    last_error,
    errors,
  };
}

export function renderServerMonitorFrame(s: ServerMonitorSnapshot): string {
  const cell = (st: MonitorState) => st.padEnd(10, ' ');
  const lines: string[] = [];
  lines.push('==================================================');
  lines.push('                 VS CORE SERVER');
  lines.push(`                   ${s.server_id}`);
  lines.push('==================================================');
  lines.push('');
  lines.push(`SERVER          ${cell(s.services.server.state)} ${s.services.server.detail}`);
  lines.push(`API             ${cell(s.services.api.state)} ${s.services.api.detail}`);
  lines.push(`POSTGRES        ${cell(s.services.postgres.state)} ${s.services.postgres.detail}`);
  lines.push(`REDIS           ${cell(s.services.redis.state)} ${s.services.redis.detail}`);
  lines.push(`WIREGUARD       ${cell(s.services.wireguard.state)} ${s.services.wireguard.detail}`);
  lines.push(`NETWORK         ${cell(s.services.network.state)} ${s.services.network.detail}`);
  lines.push('');
  lines.push('--------------------------------------------------');
  lines.push('ADMIN');
  lines.push('');
  lines.push(
    `MSI CONTROL     ${s.admin.connected ? 'CONNECTED' : s.admin.device_id ? 'DISCONNECTED' : 'UNKNOWN'}`
  );
  lines.push(`TRANSPORT       ${s.admin.transport}`);
  lines.push(`LAST SEEN       ${s.admin.last_seen || '-'}`);
  if (s.admin.device_id) lines.push(`DEVICE          ${s.admin.device_id}`);
  lines.push('');
  lines.push('--------------------------------------------------');
  lines.push('CLIENTS');
  lines.push('');
  lines.push(`TOTAL           ${s.clients.total}`);
  lines.push(`ONLINE          ${s.clients.online}`);
  lines.push(`OFFLINE         ${s.clients.offline}`);
  for (const d of s.clients.devices.slice(0, 8)) {
    lines.push(`  - ${d.device_id}  ${d.connection_state}  ${d.status}`);
  }
  lines.push('');
  lines.push('--------------------------------------------------');
  lines.push('MARKET');
  lines.push('');
  lines.push(`MARKET          ${s.market.state}  (${s.market.detail})`);
  lines.push(
    `TRADING         ${s.trading.enabled ? 'ENABLED' : 'DISABLED'}  ${s.trading.mode}`
  );
  lines.push('');
  lines.push('--------------------------------------------------');
  lines.push('SYSTEM');
  lines.push('');
  lines.push(
    `CPU             ${s.system.cpu_percent != null ? `${s.system.cpu_percent} %` : 'UNKNOWN'}  (${s.system.cpu_status})`
  );
  lines.push(
    `RAM             ${s.system.ram_percent != null ? `${s.system.ram_percent} %` : 'UNKNOWN'}  (${s.system.ram_status})`
  );
  lines.push(
    `DISK            ${s.system.disk_percent != null ? `${s.system.disk_percent} %` : 'UNKNOWN'}  (${s.system.disk_status})`
  );
  lines.push(`UPTIME          ${s.uptime_human}`);
  lines.push(`SERVER VERSION  ${s.server_version}`);
  lines.push(`LAST UPDATE     ${s.timestamp}`);
  lines.push('');
  lines.push('--------------------------------------------------');
  lines.push('ERRORS');
  lines.push('');
  if (!s.errors.length) {
    lines.push('(none)');
  } else {
    for (const e of s.errors) lines.push(e);
    if (s.last_error) {
      lines.push('');
      lines.push('LAST ERROR:');
      lines.push(s.last_error);
    }
  }
  lines.push('');
  lines.push('==================================================');
  lines.push('  READ-ONLY MONITOR — closing this does not stop VS');
  lines.push('==================================================');
  return lines.join('\n');
}
