/**
 * Local read-only SERVER MONITOR for the physical i3 console.
 * Observational only — closing this process must NOT stop vs-server / Postgres / Redis / WG.
 *
 * Prefers localhost console API (no API_ADMIN_TOKEN / no server.env secrets).
 * Falls back to admin-token monitor only if console route is unavailable.
 *
 * Usage: npm run vs-server:monitor
 *        SERVER/MONITOR_SERVER
 *        vs-monitor
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

async function fetchJson(url: string, headers?: HeadersInit): Promise<Response> {
  return fetch(url, { headers, signal: AbortSignal.timeout(8000) });
}

async function fetchMonitor(): Promise<ServerMonitorSnapshot> {
  // Health first — distinguishes API down from auth failure
  try {
    const h = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2500) });
    if (!h.ok) {
      return offlineServerMonitorSnapshot(`/health HTTP ${h.status}`);
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : 'fetch failed';
    const msg =
      /fetch failed|ECONNREFUSED|NetworkError|aborted/i.test(raw)
        ? `OFFLINE ${BASE}/health (${raw}) — run: sudo bash SERVER/FIX_CONTROL_API.sh`
        : raw;
    return offlineServerMonitorSnapshot(msg);
  }

  // Preferred: localhost console (no secrets)
  try {
    const res = await fetchJson(`${BASE}/api/v1/server/monitor/console`);
    if (res.ok) {
      const body = (await res.json()) as ServerMonitorSnapshot;
      if (body && body.role === 'server_monitor') return body;
    }
    if (res.status === 403) {
      // Unexpected from localhost — still try text/admin below
    }
  } catch {
    /* fall through */
  }

  // Optional admin-token path (systemd EnvironmentFile may inject token)
  const token = adminToken();
  if (token && token !== 'CHANGE_ME_ADMIN_TOKEN') {
    try {
      const res = await fetchJson(`${BASE}/api/v1/server/monitor`, {
        'x-admin-token': token,
      });
      if (res.status === 401) {
        return offlineServerMonitorSnapshot('UNAUTHORIZED (admin token rejected)');
      }
      if (res.ok) {
        const body = (await res.json()) as ServerMonitorSnapshot;
        if (body && body.role === 'server_monitor') return body;
      }
      return offlineServerMonitorSnapshot(`monitor HTTP ${res.status}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'monitor fetch failed';
      return offlineServerMonitorSnapshot(msg);
    }
  }

  // Last resort: plaintext console frame if JSON path missing on older builds
  try {
    const res = await fetchJson(`${BASE}/api/v1/server/monitor/console/text`);
    if (res.ok) {
      // Caller expects snapshot; synthesize offline-ok wrapper is wrong.
      // Return a minimal online snap so tick can still clear+print via text path.
      return {
        ...offlineServerMonitorSnapshot('console-text-only'),
        ok: true,
        api: {
          status: 'ONLINE',
          latency_ms: null,
          detail: 'console/text',
          error: null,
          port: Number(PORT),
        },
        last_error: null,
        errors: [],
      };
    }
  } catch {
    /* ignore */
  }

  return offlineServerMonitorSnapshot(
    'monitor API unavailable (console route missing — restart vs-server after install)'
  );
}

let lastTextFallback: string | null = null;

async function tick(): Promise<void> {
  // Prefer plaintext console frame when available (single hop, no secrets)
  try {
    const textRes = await fetch(`${BASE}/api/v1/server/monitor/console/text`, {
      signal: AbortSignal.timeout(8000),
    });
    if (textRes.ok) {
      const frame = await textRes.text();
      lastTextFallback = frame;
      if (process.stdout.isTTY) process.stdout.write('\x1Bc');
      process.stdout.write(frame.endsWith('\n') ? frame : frame + '\n');
      return;
    }
  } catch {
    /* fall through to JSON path */
  }

  const snap = await fetchMonitor();
  const frame = lastTextFallback && !snap.ok ? lastTextFallback : renderServerMonitorFrame(snap);
  if (process.stdout.isTTY) {
    process.stdout.write('\x1Bc');
  }
  process.stdout.write(frame + '\n');
}

async function main(): Promise<void> {
  console.error('VS SERVER MONITOR starting (read-only; exit does not stop VS)');
  console.error(`API ${BASE}  refresh ${REFRESH_MS}ms  (localhost console; no server.env required)`);
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
