/**
 * Real OS / host telemetry for VS CORE TUI.
 * No hardcoded CPU/RAM/SSD — reads from /proc and filesystem.
 */

import { readFileSync, existsSync, statfsSync } from 'fs';
import { networkInterfaces, hostname, release, arch, uptime as osUptime } from 'os';
import { execFileSync } from 'child_process';

export type HostSystemSnapshot = {
  server_id: string;
  hostname: string;
  os: string;
  arch: string;
  uptime_seconds: number;
  uptime_human: string;
  time_utc: string;
  cpu_percent: number | null;
  cpu_status: 'OK' | 'WARNING' | 'ERROR' | 'NO_DATA';
  ram_used_bytes: number | null;
  ram_total_bytes: number | null;
  ram_status: 'OK' | 'WARNING' | 'ERROR' | 'NO_DATA';
  ssd_used_bytes: number | null;
  ssd_total_bytes: number | null;
  ssd_status: 'OK' | 'WARNING' | 'ERROR' | 'NO_DATA';
  network_online: boolean;
  network_latency_ms: number | null;
  network_status: 'OK' | 'WARNING' | 'ERROR' | 'NO_DATA';
  time_sync_ok: boolean | null;
  time_sync_status: 'OK' | 'WARNING' | 'ERROR' | 'NO_DATA';
  detail: string;
};

function humanUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
}

function readMeminfo(): { total: number; available: number } | null {
  try {
    const raw = readFileSync('/proc/meminfo', 'utf8');
    const total = Number(/MemTotal:\s+(\d+)/.exec(raw)?.[1] || 0) * 1024;
    const available = Number(/MemAvailable:\s+(\d+)/.exec(raw)?.[1] || 0) * 1024;
    if (!total) return null;
    return { total, available };
  } catch {
    return null;
  }
}

/** Sample /proc/stat twice for a real CPU % (not a constant). */
export function sampleCpuPercent(sampleMs = 100): number | null {
  try {
    const read = () => {
      const line = readFileSync('/proc/stat', 'utf8').split('\n')[0] || '';
      const parts = line.trim().split(/\s+/).slice(1).map(Number);
      const idle = (parts[3] || 0) + (parts[4] || 0);
      const total = parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
      return { idle, total };
    };
    const a = read();
    const AtomicsWait = (ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        /* spin briefly — TUI sample only */
      }
    };
    AtomicsWait(sampleMs);
    const b = read();
    const idleDelta = b.idle - a.idle;
    const totalDelta = b.total - a.total;
    if (totalDelta <= 0) return null;
    const used = 1 - idleDelta / totalDelta;
    return Math.max(0, Math.min(100, Math.round(used * 1000) / 10));
  } catch {
    return null;
  }
}

function diskUsage(path: string): { used: number; total: number } | null {
  try {
    if (!existsSync(path)) return null;
    const st = statfsSync(path);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { total, used: Math.max(0, total - free) };
  } catch {
    return null;
  }
}

function hasIpv4(): boolean {
  const nets = networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) return true;
    }
  }
  return false;
}

/** Optional ICMP/TCP latency probe — returns null if blocked (NO_DATA, not fake). */
export function probeNetworkLatencyMs(
  host = process.env.VS_NET_PROBE_HOST || '1.1.1.1'
): number | null {
  try {
    const start = Date.now();
    // Prefer TCP connect to DNS:53 — works without raw ICMP privileges
    execFileSync(
      'bash',
      ['-c', `timeout 2 bash -c "echo >/dev/tcp/${host}/53" 2>/dev/null`],
      { stdio: 'ignore' }
    );
    return Date.now() - start;
  } catch {
    return null;
  }
}

function ntpSynchronized(): boolean | null {
  try {
    const out = execFileSync('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out === 'yes') return true;
    if (out === 'no') return false;
    return null;
  } catch {
    return null;
  }
}

function fmtBytes(n: number | null): string {
  if (n == null) return 'NO DATA';
  const gb = n / (1024 * 1024 * 1024);
  return `${gb.toFixed(1)} GB`;
}

export function collectHostSystemSnapshot(opts?: {
  serverId?: string;
  dataRoot?: string;
  cpuSampleMs?: number;
  probeNetwork?: boolean;
}): HostSystemSnapshot {
  const server_id = opts?.serverId || process.env.VS_SERVER_ID || `VS-CORE-${hostname()}`;
  const mem = readMeminfo();
  const disk = diskUsage(opts?.dataRoot || process.env.VS_CORE_DATA || '/');
  const cpu = sampleCpuPercent(opts?.cpuSampleMs ?? 80);
  const online = hasIpv4();
  const latency =
    opts?.probeNetwork === false ? null : online ? probeNetworkLatencyMs() : null;
  const sync = ntpSynchronized();

  const ramUsed = mem ? mem.total - mem.available : null;
  const ramPct = mem && ramUsed != null ? ramUsed / mem.total : null;
  const ssdPct = disk ? disk.used / disk.total : null;

  return {
    server_id,
    hostname: hostname(),
    os: `Linux ${release()}`,
    arch: arch(),
    uptime_seconds: Math.floor(osUptime()),
    uptime_human: humanUptime(Math.floor(osUptime())),
    time_utc: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC'),
    cpu_percent: cpu,
    cpu_status: cpu == null ? 'NO_DATA' : cpu > 90 ? 'ERROR' : cpu > 75 ? 'WARNING' : 'OK',
    ram_used_bytes: ramUsed,
    ram_total_bytes: mem?.total ?? null,
    ram_status:
      ramPct == null ? 'NO_DATA' : ramPct > 0.92 ? 'ERROR' : ramPct > 0.8 ? 'WARNING' : 'OK',
    ssd_used_bytes: disk?.used ?? null,
    ssd_total_bytes: disk?.total ?? null,
    ssd_status:
      ssdPct == null ? 'NO_DATA' : ssdPct > 0.92 ? 'ERROR' : ssdPct > 0.8 ? 'WARNING' : 'OK',
    network_online: online,
    network_latency_ms: latency,
    network_status: !online
      ? 'ERROR'
      : latency == null
        ? 'NO_DATA'
        : latency > 500
          ? 'WARNING'
          : 'OK',
    time_sync_ok: sync,
    time_sync_status: sync == null ? 'NO_DATA' : sync ? 'OK' : 'ERROR',
    detail: `ram=${fmtBytes(ramUsed)}/${fmtBytes(mem?.total ?? null)} disk=${fmtBytes(disk?.used ?? null)}/${fmtBytes(disk?.total ?? null)}`,
  };
}

export function formatBytesPair(used: number | null, total: number | null): string {
  if (used == null || total == null) return 'NO DATA';
  const u = used / (1024 * 1024 * 1024);
  const t = total / (1024 * 1024 * 1024);
  return `${u.toFixed(1)} / ${t.toFixed(0)} GB`;
}
