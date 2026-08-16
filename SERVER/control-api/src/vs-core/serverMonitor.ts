/**
 * Authoritative server monitor status — shared by MSI ADMIN and i3 local monitor.
 * Never invents ONLINE. Never exposes secrets. LIVE trading stays fail-closed elsewhere.
 */

import { createConnection } from 'net';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { collectHostSystemSnapshot } from './hostTelemetry.js';
import { evaluateReadiness, type ProbeResult } from './readiness.js';
import { getDeviceRegistry } from './network/deviceRegistry.js';
import { healthCheck } from '../db/pool.js';
import { CORE_VERSION, versionBundle } from './versions.js';
import { hostname } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);

export type MonitorState =
  | 'ONLINE'
  | 'OFFLINE'
  | 'WARNING'
  | 'UNKNOWN'
  | 'NOT_INSTALLED'
  | 'STARTING'
  | 'ERROR';

export type ServiceCell = {
  status: MonitorState;
  latency_ms: number | null;
  detail: string;
  error: string | null;
};

export type ServerMonitorSnapshot = {
  ok: boolean;
  role: 'server_monitor';
  server_id: string;
  hostname: string;
  server_version: string;
  versions: ReturnType<typeof versionBundle>;
  uptime_seconds: number;
  uptime_human: string;
  timestamp: string;
  live_trading_enabled: boolean;
  operating_mode: string;

  api: ServiceCell & { port: number };
  database: ServiceCell;
  redis: ServiceCell;
  wireguard: ServiceCell & {
    interface: string;
    listen_port: number;
    peers: number;
    peers_active: number;
  };
  network: ServiceCell & { lan_ip: string | null; internet: boolean };

  /** Process / systemd unit — independent from Control API HTTP */
  server_process: ServiceCell;

  /** @deprecated alias mirror — prefer server_process / api */
  services: {
    server: { state: MonitorState; detail: string };
    api: { state: MonitorState; detail: string };
    postgres: { state: MonitorState; detail: string };
    redis: { state: MonitorState; detail: string };
    wireguard: { state: MonitorState; detail: string };
    network: { state: MonitorState; detail: string };
  };

  admin: {
    status: MonitorState;
    connected: boolean;
    device_id: string | null;
    device_name: string | null;
    transport: 'LAN' | 'WIREGUARD' | 'NONE' | 'UNKNOWN';
    last_seen: string | null;
    last_seen_human: string | null;
  };

  clients: {
    total: number;
    online: number;
    offline: number;
    devices: Array<{
      device_id: string;
      status: string;
      connection_state: string;
      transport: string;
      last_seen: string | null;
      last_seen_human: string | null;
      latency_ms: number | null;
    }>;
  };

  market: { status: string; state: 'OPEN' | 'CLOSED' | 'UNKNOWN'; detail: string };
  trading: {
    enabled: boolean;
    readiness: string;
    mode: string;
    detail: string;
  };
  strategy: { status: string; detail: string };
  risk: { status: string; detail: string };
  execution: { status: string; detail: string };
  reconciliation: { status: string; detail: string };

  system: {
    cpu_percent: number | null;
    ram_percent: number | null;
    disk_percent: number | null;
    ram_used: number | null;
    ram_total: number | null;
    disk_used: number | null;
    disk_total: number | null;
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

function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  return fn().then((value) => ({ value, ms: Date.now() - t0 }));
}

function pct(used: number | null, total: number | null): number | null {
  if (used == null || total == null || !total) return null;
  return Math.round((used / total) * 1000) / 10;
}

function ago(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function probeNamed(
  probes: ProbeResult[],
  name: string
): { status: string; detail: string } {
  const p = probes.find((x) => x.name === name);
  if (!p) return { status: 'UNKNOWN', detail: 'NO_DATA' };
  return { status: String(p.status), detail: p.detail || '' };
}

function marketFromProbes(probes: ProbeResult[]): {
  state: 'OPEN' | 'CLOSED' | 'UNKNOWN';
  detail: string;
  status: string;
} {
  const m = probes.find((p) => p.name === 'MARKET');
  if (!m) return { state: 'UNKNOWN', status: 'UNKNOWN', detail: 'NO_DATA' };
  if (m.status === 'OK') return { state: 'OPEN', status: 'OK', detail: m.detail || 'OK' };
  if (m.status === 'ERROR')
    return { state: 'CLOSED', status: 'ERROR', detail: m.detail || 'ERROR' };
  return {
    state: 'UNKNOWN',
    status: String(m.status),
    detail: `${m.status}: ${m.detail || ''}`.trim(),
  };
}

function inferAdminTransport(
  privateAddress: string | null | undefined
): ServerMonitorSnapshot['admin']['transport'] {
  if (process.env.VS_LAN_MANAGEMENT === '1' || process.env.VS_LAN_MANAGEMENT === 'true') {
    return 'LAN';
  }
  if (privateAddress?.startsWith('10.77.')) return 'WIREGUARD';
  if (privateAddress) return 'LAN';
  return 'UNKNOWN';
}

async function detectLanIp(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ip', ['-4', 'route', 'get', '1.1.1.1'], {
      timeout: 1500,
    });
    const m = stdout.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)\b/);
    return m?.[1] || null;
  } catch {
    return process.env.VS_SERVER_LAN_IP || process.env.VS_SERVER_ENDPOINT_IP || null;
  }
}

export async function defaultPostgresCheck(): Promise<{
  ok: boolean;
  detail: string;
  latency_ms: number | null;
}> {
  try {
    const { value, ms } = await timed(() => healthCheck());
    return {
      ok: value,
      detail: value ? 'healthCheck OK' : 'Postgres healthCheck failed',
      latency_ms: ms,
    };
  } catch (e) {
    return {
      ok: false,
      detail: e instanceof Error ? e.message : 'Postgres probe error',
      latency_ms: null,
    };
  }
}

export async function defaultRedisCheck(): Promise<{
  ok: boolean;
  detail: string;
  warning?: boolean;
  not_installed?: boolean;
  latency_ms: number | null;
}> {
  const port = Number(process.env.REDIS_PORT || 6379);
  const t0 = Date.now();
  const up = await tcpProbe('127.0.0.1', port);
  if (!up) {
    return {
      ok: false,
      detail: `connection refused on 127.0.0.1:${port}`,
      latency_ms: Date.now() - t0,
    };
  }
  try {
    const { stdout } = await execFileAsync(
      'redis-cli',
      ['-h', '127.0.0.1', '-p', String(port), 'ping'],
      { timeout: 1500 }
    );
    if (/PONG/i.test(stdout)) {
      return { ok: true, detail: 'PONG', latency_ms: Date.now() - t0 };
    }
    return {
      ok: false,
      detail: 'unexpected redis-cli reply',
      warning: true,
      latency_ms: Date.now() - t0,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ENOENT|not found/i.test(msg)) {
      return {
        ok: false,
        detail: 'redis-cli not installed; port open',
        warning: true,
        not_installed: true,
        latency_ms: Date.now() - t0,
      };
    }
    return {
      ok: false,
      detail: 'port open; redis-cli ping unavailable',
      warning: true,
      latency_ms: Date.now() - t0,
    };
  }
}

export async function defaultWireguardCheck(iface: string): Promise<{
  state: MonitorState;
  detail: string;
  listen_port: number;
  peers_iface: number | null;
}> {
  const listen_port = Number(process.env.VS_WG_LISTEN_PORT || 51820);
  try {
    const { stdout } = await execFileAsync('ip', ['-4', '-br', 'addr', 'show', 'dev', iface], {
      timeout: 1500,
    });
    const line = stdout.trim();
    if (!line || !/\d+\.\d+\.\d+\.\d+/.test(line)) {
      return {
        state: 'OFFLINE',
        detail: `${iface} has no IPv4`,
        listen_port,
        peers_iface: null,
      };
    }
    let peers_iface: number | null = null;
    try {
      const { stdout: wgOut } = await execFileAsync('wg', ['show', iface, 'peers'], {
        timeout: 1500,
      });
      const peers = wgOut
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      peers_iface = peers.length;
    } catch {
      /* wg binary optional — registry peers still used */
    }
    return {
      state: 'ONLINE',
      detail: line.replace(/\s+/g, ' '),
      listen_port,
      peers_iface,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/does not exist|Cannot find device|No such device/i.test(msg)) {
      // Interface missing — may be intentional when LAN-only; WARNING not fake ONLINE
      return {
        state: 'WARNING',
        detail: `${iface} down (LAN ADMIN may still work with VS_LAN_MANAGEMENT=1)`,
        listen_port,
        peers_iface: null,
      };
    }
    if (/ENOENT|not found/i.test(msg)) {
      return {
        state: 'NOT_INSTALLED',
        detail: 'ip/wg tools unavailable',
        listen_port,
        peers_iface: null,
      };
    }
    return {
      state: 'WARNING',
      detail: `${iface} probe failed: ${msg}`,
      listen_port,
      peers_iface: null,
    };
  }
}

export async function defaultServerProcessCheck(): Promise<ServiceCell> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['is-active', 'vs-server.service'], {
      timeout: 2000,
    });
    const st = stdout.trim();
    if (st === 'active') {
      return {
        status: 'ONLINE',
        latency_ms: null,
        detail: 'systemd vs-server active',
        error: null,
      };
    }
    if (st === 'activating') {
      return {
        status: 'STARTING',
        latency_ms: null,
        detail: 'systemd activating',
        error: null,
      };
    }
    return {
      status: 'OFFLINE',
      latency_ms: null,
      detail: `systemd ${st}`,
      error: `vs-server ${st}`,
    };
  } catch {
    const data = dataRootDefault();
    const pidFile = join(data, 'vs-server.pid');
    if (existsSync(pidFile)) {
      try {
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        process.kill(pid, 0);
        return {
          status: 'ONLINE',
          latency_ms: null,
          detail: `pid=${pid}`,
          error: null,
        };
      } catch {
        return {
          status: 'OFFLINE',
          latency_ms: null,
          detail: 'stale pidfile',
          error: 'process not running',
        };
      }
    }
    // Running inside the API process itself — process is up if we are answering
    return {
      status: 'ONLINE',
      latency_ms: null,
      detail: 'control-api process (no systemd unit visible)',
      error: null,
    };
  }
}

export type BuildMonitorDeps = {
  getProbes: () => ProbeResult[] | Promise<ProbeResult[]>;
  apiSelfOnline?: boolean;
  dataRoot?: string;
  checkPostgres?: () => Promise<{ ok: boolean; detail: string; latency_ms?: number | null }>;
  checkRedis?: () => Promise<{
    ok: boolean;
    detail: string;
    warning?: boolean;
    not_installed?: boolean;
    latency_ms?: number | null;
  }>;
  checkWireguard?: () => Promise<{
    state: MonitorState;
    detail: string;
    listen_port?: number;
    peers_iface?: number | null;
  }>;
  checkServerProcess?: () => Promise<ServiceCell>;
};

export function offlineServerMonitorSnapshot(reason: string): ServerMonitorSnapshot {
  const detail = reason || 'API unreachable';
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
  const cell = (status: MonitorState, d: string): ServiceCell => ({
    status,
    latency_ms: null,
    detail: d,
    error: status === 'OFFLINE' || status === 'ERROR' ? d : null,
  });
  const unknown = cell('UNKNOWN', 'not probed (API down)');
  const port = Number(process.env.CONTROL_API_PORT || 3000);
  const snap: ServerMonitorSnapshot = {
    ok: false,
    role: 'server_monitor',
    server_id: process.env.VS_SERVER_ID || host?.server_id || `VS-CORE-${hostname()}`,
    hostname: host?.hostname || hostname(),
    server_version: CORE_VERSION,
    versions: versionBundle(),
    uptime_seconds: host?.uptime_seconds ?? 0,
    uptime_human: host?.uptime_human || 'UNKNOWN',
    timestamp: new Date().toISOString(),
    live_trading_enabled: process.env.LIVE_TRADING_ENABLED === 'true',
    operating_mode: process.env.OPERATING_MODE || 'PAPER',
    api: { ...cell('OFFLINE', detail), port },
    database: unknown,
    redis: unknown,
    wireguard: {
      ...unknown,
      interface: process.env.VS_WG_INTERFACE || 'vs0',
      listen_port: Number(process.env.VS_WG_LISTEN_PORT || 51820),
      peers: 0,
      peers_active: 0,
    },
    network: { ...unknown, lan_ip: null, internet: false },
    server_process: cell('UNKNOWN', 'cannot confirm (API down)'),
    services: {
      server: { state: 'UNKNOWN', detail: 'cannot confirm (API down)' },
      api: { state: 'OFFLINE', detail },
      postgres: { state: 'UNKNOWN', detail: 'not probed (API down)' },
      redis: { state: 'UNKNOWN', detail: 'not probed (API down)' },
      wireguard: { state: 'UNKNOWN', detail: 'not probed (API down)' },
      network: { state: 'UNKNOWN', detail: 'not probed (API down)' },
    },
    admin: {
      status: 'UNKNOWN',
      connected: false,
      device_id: null,
      device_name: null,
      transport: 'UNKNOWN',
      last_seen: null,
      last_seen_human: null,
    },
    clients: { total: 0, online: 0, offline: 0, devices: [] },
    market: { status: 'UNKNOWN', state: 'UNKNOWN', detail: 'API unavailable' },
    trading: {
      enabled: process.env.LIVE_TRADING_ENABLED === 'true',
      readiness: 'UNKNOWN',
      mode: process.env.OPERATING_MODE || 'PAPER',
      detail: 'status unavailable while API offline',
    },
    strategy: { status: 'UNKNOWN', detail: 'API unavailable' },
    risk: { status: 'UNKNOWN', detail: 'API unavailable' },
    execution: { status: 'UNKNOWN', detail: 'API unavailable' },
    reconciliation: { status: 'UNKNOWN', detail: 'API unavailable' },
    system: {
      cpu_percent: host?.cpu_percent ?? null,
      ram_percent: host ? pct(host.ram_used_bytes, host.ram_total_bytes) : null,
      disk_percent: host ? pct(host.ssd_used_bytes, host.ssd_total_bytes) : null,
      ram_used: host?.ram_used_bytes ?? null,
      ram_total: host?.ram_total_bytes ?? null,
      disk_used: host?.ssd_used_bytes ?? null,
      disk_total: host?.ssd_total_bytes ?? null,
      cpu_status: host?.cpu_status || 'UNKNOWN',
      ram_status: host?.ram_status || 'UNKNOWN',
      disk_status: host?.ssd_status || 'UNKNOWN',
    },
    last_error: `API: ${detail}`,
    errors: [`API: ${detail}`],
  };
  return snap;
}

export async function buildServerMonitorSnapshot(
  deps: BuildMonitorDeps
): Promise<ServerMonitorSnapshot> {
  const errors: string[] = [];
  const probes = await deps.getProbes();
  const readiness = evaluateReadiness(probes);
  const root = deps.dataRoot || dataRootDefault();
  const host = collectHostSystemSnapshot({
    cpuSampleMs: 50,
    probeNetwork: true,
    dataRoot: root,
  });
  const port = Number(process.env.CONTROL_API_PORT || 3000);
  const apiOnline = deps.apiSelfOnline !== false;

  const serverProc = await (deps.checkServerProcess || defaultServerProcessCheck)();

  const pg = await (deps.checkPostgres || defaultPostgresCheck)();
  if (!pg.ok) errors.push(`POSTGRES: ${pg.detail}`);

  const redis = await (deps.checkRedis || defaultRedisCheck)();
  if (!redis.ok) errors.push(`REDIS: ${redis.detail}`);

  const wgIface = process.env.VS_WG_INTERFACE || 'vs0';
  const wg = await (deps.checkWireguard || (() => defaultWireguardCheck(wgIface)))();
  if (wg.state === 'OFFLINE' || wg.state === 'ERROR') errors.push(`WIREGUARD: ${wg.detail}`);

  const networkOnline = !!host.network_online;
  const networkState: MonitorState = networkOnline
    ? host.network_status === 'OK'
      ? 'ONLINE'
      : 'WARNING'
    : 'OFFLINE';
  if (networkState === 'OFFLINE') errors.push('NETWORK: offline');

  let adminConnected = false;
  let adminDeviceId: string | null = null;
  let adminDeviceName: string | null = null;
  let adminLastSeen: string | null = null;
  let adminTransport: ServerMonitorSnapshot['admin']['transport'] = 'UNKNOWN';
  const clientDevices: ServerMonitorSnapshot['clients']['devices'] = [];
  let clientsOnline = 0;
  let clientsTotal = 0;
  let peerCount = 0;
  let peersActive = 0;

  try {
    const reg = getDeviceRegistry(root);
    peerCount = reg.activePeers().length;
    const devices = reg.list();
    for (const d of devices) {
      if (d.device_type === 'ADMIN') {
        const online =
          d.status === 'ACTIVE' &&
          (d.connection_state === 'CONNECTED' || d.connection_state === 'ONLINE');
        if (online || (!adminConnected && d.status === 'ACTIVE')) {
          adminDeviceId = d.device_id;
          adminDeviceName = d.device_name || d.device_id;
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
        if (online) {
          clientsOnline += 1;
          peersActive += 1;
        }
        clientDevices.push({
          device_id: d.device_id,
          status: d.status,
          connection_state: d.connection_state || 'UNKNOWN',
          transport: 'WireGuard',
          last_seen: d.last_seen,
          last_seen_human: ago(d.last_seen),
          latency_ms: d.latency_ms ?? null,
        });
      }
    }
    if (!adminDeviceId) adminTransport = 'NONE';
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
  const strategy = probeNamed(probes, 'STRATEGY');
  const risk = probeNamed(probes, 'RISK');
  const execution = probeNamed(probes, 'EXECUTION');
  const reconciliation = probeNamed(probes, 'RECONCILIATION');

  const redisState: MonitorState = redis.ok
    ? 'ONLINE'
    : redis.not_installed
      ? 'NOT_INSTALLED'
      : redis.warning
        ? 'WARNING'
        : 'OFFLINE';

  const apiCell: ServerMonitorSnapshot['api'] = {
    status: apiOnline ? 'ONLINE' : 'OFFLINE',
    latency_ms: null,
    detail: apiOnline ? `listening :${port}` : 'no /health',
    error: apiOnline ? null : 'API not serving',
    port,
  };

  const dbCell: ServiceCell = {
    status: pg.ok ? 'ONLINE' : 'OFFLINE',
    latency_ms: pg.latency_ms ?? null,
    detail: pg.detail,
    error: pg.ok ? null : pg.detail,
  };

  const redisCell: ServiceCell = {
    status: redisState,
    latency_ms: redis.latency_ms ?? null,
    detail: redis.detail,
    error: redis.ok ? null : redis.detail,
  };

  const wgCell: ServerMonitorSnapshot['wireguard'] = {
    status: wg.state,
    latency_ms: null,
    detail: wg.detail,
    error: wg.state === 'ONLINE' || wg.state === 'WARNING' ? null : wg.detail,
    interface: wgIface,
    listen_port: wg.listen_port ?? Number(process.env.VS_WG_LISTEN_PORT || 51820),
    peers: peerCount,
    peers_active: peersActive || (wg.peers_iface ?? 0),
  };

  const lanIp = await detectLanIp();
  const netCell: ServerMonitorSnapshot['network'] = {
    status: networkState,
    latency_ms: host.network_latency_ms ?? null,
    detail: networkOnline
      ? host.network_latency_ms != null
        ? `latency ${host.network_latency_ms}ms`
        : 'online'
      : 'offline',
    error: networkState === 'OFFLINE' ? 'offline' : null,
    lan_ip: lanIp,
    internet: networkOnline,
  };

  const last_error = errors.length ? errors[errors.length - 1] : null;

  return {
    ok: pg.ok && apiOnline,
    role: 'server_monitor',
    server_id: host.server_id || process.env.VS_SERVER_ID || `VS-CORE-${hostname()}`,
    hostname: host.hostname,
    server_version: CORE_VERSION,
    versions: versionBundle(),
    uptime_seconds: host.uptime_seconds,
    uptime_human: host.uptime_human,
    timestamp: new Date().toISOString(),
    live_trading_enabled: liveEnabled,
    operating_mode: mode,
    api: apiCell,
    database: dbCell,
    redis: redisCell,
    wireguard: wgCell,
    network: netCell,
    server_process: serverProc,
    services: {
      server: { state: serverProc.status, detail: serverProc.detail },
      api: { state: apiCell.status, detail: apiCell.detail },
      postgres: { state: dbCell.status, detail: dbCell.detail },
      redis: { state: redisCell.status, detail: redisCell.detail },
      wireguard: { state: wgCell.status, detail: wgCell.detail },
      network: { state: netCell.status, detail: netCell.detail },
    },
    admin: {
      status: adminConnected ? 'ONLINE' : adminDeviceId ? 'OFFLINE' : 'UNKNOWN',
      connected: adminConnected,
      device_id: adminDeviceId,
      device_name: adminDeviceName,
      transport: adminDeviceId ? adminTransport : 'NONE',
      last_seen: adminLastSeen,
      last_seen_human: ago(adminLastSeen),
    },
    clients: {
      total: clientsTotal,
      online: clientsOnline,
      offline: Math.max(0, clientsTotal - clientsOnline),
      devices: clientDevices.slice(0, 32),
    },
    market: {
      status: market.status,
      state: market.state,
      detail: market.detail,
    },
    trading: {
      enabled: liveEnabled,
      readiness: readiness.state || 'UNKNOWN',
      mode,
      detail: liveEnabled
        ? 'LIVE_TRADING_ENABLED=true'
        : `LIVE_TRADING_ENABLED=false MODE=${mode}`,
    },
    strategy,
    risk,
    execution,
    reconciliation,
    system: {
      cpu_percent: host.cpu_percent,
      ram_percent: pct(host.ram_used_bytes, host.ram_total_bytes),
      disk_percent: pct(host.ssd_used_bytes, host.ssd_total_bytes),
      ram_used: host.ram_used_bytes,
      ram_total: host.ram_total_bytes,
      disk_used: host.ssd_used_bytes,
      disk_total: host.ssd_total_bytes,
      cpu_status: host.cpu_status,
      ram_status: host.ram_status,
      disk_status: host.ssd_status,
    },
    last_error,
    errors,
  };
}

function dot(st: MonitorState | string): string {
  const s = String(st).toUpperCase();
  if (s === 'ONLINE' || s === 'OK' || s === 'CONNECTED') return '●';
  if (s === 'WARNING' || s === 'STARTING' || s === 'DEGRADED') return '◐';
  if (s === 'UNKNOWN' || s === 'NOT_INSTALLED') return '○';
  return '●';
}

function pad(label: string, width: number): string {
  return label.length >= width ? label.slice(0, width) : label + ' '.repeat(width - label.length);
}

export function renderServerMonitorFrame(s: ServerMonitorSnapshot): string {
  const W = 60;
  const bar = (ch: string) => ch.repeat(W);
  const row = (label: string, status: string, extra = '') => {
    const left = `  ${pad(label, 20)} ${dot(status)} ${pad(status, 12)}`;
    return extra ? `${left} ${extra}` : left;
  };
  const lines: string[] = [];
  lines.push(`╔${bar('═')}╗`);
  lines.push(`║${'VS CORE SERVER'.padStart(37).padEnd(W)}║`);
  lines.push(`║${s.server_id.padStart(Math.floor((W + s.server_id.length) / 2)).padEnd(W)}║`);
  lines.push(`╠${bar('═')}╣`);
  lines.push(`║  CORE SERVICES${' '.repeat(W - 16)}║`);
  lines.push(`║${' '.repeat(W)}║`);
  const coreRows = [
    row('SERVER PROCESS', s.server_process.status, s.server_process.detail.slice(0, 18)),
    row('CONTROL API', s.api.status, `:${s.api.port}`),
    row('POSTGRES', s.database.status),
    row('REDIS', s.redis.status),
    row(
      'WIREGUARD',
      s.wireguard.status,
      `UDP :${s.wireguard.listen_port}`
    ),
    row('NETWORK', s.network.status, s.network.lan_ip || ''),
  ];
  for (const r of coreRows) lines.push(`║${pad(r, W)}║`);
  lines.push(`╠${bar('═')}╣`);
  lines.push(`║  ADMIN${' '.repeat(W - 8)}║`);
  lines.push(`║${' '.repeat(W)}║`);
  lines.push(
    `║${pad(
      row(
        'MSI CONTROL PANEL',
        s.admin.connected ? 'CONNECTED' : s.admin.device_id ? 'DISCONNECTED' : 'UNKNOWN'
      ),
      W
    )}║`
  );
  lines.push(`║${pad(`  TRANSPORT            ${s.admin.transport}`, W)}║`);
  lines.push(
    `║${pad(`  DEVICE               ${s.admin.device_name || s.admin.device_id || '-'}`, W)}║`
  );
  lines.push(
    `║${pad(`  LAST SEEN            ${s.admin.last_seen_human || s.admin.last_seen || '-'}`, W)}║`
  );
  lines.push(`╠${bar('═')}╣`);
  lines.push(`║  CLIENTS${' '.repeat(W - 10)}║`);
  lines.push(`║${' '.repeat(W)}║`);
  lines.push(`║${pad(`  TOTAL                ${s.clients.total}`, W)}║`);
  lines.push(`║${pad(`  ONLINE               ${s.clients.online}`, W)}║`);
  lines.push(`║${pad(`  OFFLINE              ${s.clients.offline}`, W)}║`);
  for (const d of s.clients.devices.slice(0, 6)) {
    const st =
      d.connection_state === 'CONNECTED' || d.connection_state === 'ONLINE'
        ? 'ONLINE'
        : 'OFFLINE';
    lines.push(
      `║${pad(`  ${pad(d.device_id, 18)} ${dot(st)} ${pad(st, 8)} ${d.transport}`, W)}║`
    );
  }
  lines.push(`╠${bar('═')}╣`);
  lines.push(`║  TRADING${' '.repeat(W - 10)}║`);
  lines.push(`║${' '.repeat(W)}║`);
  lines.push(`║${pad(`  MARKET               ${s.market.state}`, W)}║`);
  lines.push(
    `║${pad(`  LIVE TRADING         ${s.trading.enabled ? 'ENABLED' : 'DISABLED'}`, W)}║`
  );
  lines.push(`║${pad(`  STRATEGY             ${s.strategy.status}`, W)}║`);
  lines.push(`║${pad(`  RISK                 ${s.risk.status}`, W)}║`);
  lines.push(`║${pad(`  EXECUTION            ${s.execution.status}`, W)}║`);
  lines.push(`║${pad(`  RECONCILIATION       ${s.reconciliation.status}`, W)}║`);
  lines.push(`╠${bar('═')}╣`);
  lines.push(`║  SYSTEM${' '.repeat(W - 9)}║`);
  lines.push(`║${' '.repeat(W)}║`);
  lines.push(
    `║${pad(
      `  CPU                  ${s.system.cpu_percent != null ? `${s.system.cpu_percent}%` : 'UNKNOWN'}`,
      W
    )}║`
  );
  lines.push(
    `║${pad(
      `  RAM                  ${s.system.ram_percent != null ? `${s.system.ram_percent}%` : 'UNKNOWN'}`,
      W
    )}║`
  );
  lines.push(
    `║${pad(
      `  DISK                 ${s.system.disk_percent != null ? `${s.system.disk_percent}%` : 'UNKNOWN'}`,
      W
    )}║`
  );
  lines.push(`║${pad(`  UPTIME               ${s.uptime_human}`, W)}║`);
  lines.push(`║${pad(`  SERVER VERSION       ${s.server_version}`, W)}║`);
  lines.push(`╠${bar('═')}╣`);
  lines.push(`║  LAST ERROR${' '.repeat(W - 13)}║`);
  lines.push(`║${' '.repeat(W)}║`);
  lines.push(`║${pad(`  ${s.last_error || 'NONE'}`, W)}║`);
  lines.push(`╠${bar('═')}╣`);
  lines.push(`║${pad(`  Last update: ${s.timestamp}`, W)}║`);
  lines.push(`║${pad('  READ-ONLY — closing does not stop VS', W)}║`);
  lines.push(`╚${bar('═')}╝`);
  return lines.join('\n');
}
