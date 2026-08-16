/**
 * Local read-only SERVER MONITOR for the physical i3 console.
 * Observational only — closing this process must NOT stop vs-server / Postgres / Redis / WG.
 *
 * Usage: npm run vs-server:monitor
 *        SERVER/MONITOR_SERVER
 */

import {
  offlineServerMonitorSnapshot,
  renderServerMonitorFrame,
  type ServerMonitorSnapshot,
} from './serverMonitor.js';
import { normalizeNetworkSecret } from './network/networkSecrets.js';

const REFRESH_MS = Math.max(250, Number(process.env.VS_MONITOR_REFRESH_MS || 800));
const PORT = process.env.CONTROL_API_PORT || '3000';
const BASE = (process.env.VS_MONITOR_API_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');

function adminToken(): string {
  return normalizeNetworkSecret(process.env.API_ADMIN_TOKEN || '');
}

async function fetchMonitor(): Promise<ServerMonitorSnapshot> {
  const token = adminToken();
  if (!token || token === 'CHANGE_ME_ADMIN_TOKEN') {
    return offlineServerMonitorSnapshot('API_ADMIN_TOKEN missing in monitor env');
  }

  // Health first — distinguishes API down from auth failure
  try {
    const h = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2500) });
    if (!h.ok) {
      return offlineServerMonitorSnapshot(`/health HTTP ${h.status}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'fetch failed';
    return offlineServerMonitorSnapshot(msg);
  }

  try {
    const res = await fetch(`${BASE}/api/v1/server/monitor`, {
      headers: { 'x-admin-token': token },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) {
      return offlineServerMonitorSnapshot('UNAUTHORIZED (admin token rejected)');
    }
    if (!res.ok) {
      return offlineServerMonitorSnapshot(`monitor HTTP ${res.status}`);
    }
    const body = (await res.json()) as ServerMonitorSnapshot;
    if (!body || body.role !== 'server_monitor') {
      return offlineServerMonitorSnapshot('invalid monitor payload');
    }
    return body;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'monitor fetch failed';
    return offlineServerMonitorSnapshot(msg);
  }
}

async function tick(): Promise<void> {
  const snap = await fetchMonitor();
  const frame = renderServerMonitorFrame(snap);
  if (process.stdout.isTTY) {
    process.stdout.write('\x1Bc');
  }
  process.stdout.write(frame + '\n');
}

async function main(): Promise<void> {
  console.error('VS SERVER MONITOR starting (read-only; exit does not stop VS)');
  await tick();
  const timer = setInterval(() => {
    tick().catch((e) => console.error('monitor frame error', e));
  }, REFRESH_MS);

  const stop = () => {
    clearInterval(timer);
    console.error('\nVS SERVER MONITOR stopped — backend services continue independently.');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
