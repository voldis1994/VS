import { useEffect, useMemo, useState } from 'react';

export type LiveState = {
  connected: boolean;
  connectionPhase: 'CONNECTED' | 'RECONNECTING' | 'DEGRADED' | 'DISCONNECTED';
  serverId: string;
  adminName: string;
  transport: 'LAN' | 'UNKNOWN';
  heartbeatAgeSec: number | null;
  uptime: string | null;
  health: 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'UNKNOWN';
  clientsRegistered: number;
  clientsOnline: number;
  openPositions: number | null;
  totalPnlToday: number | null;
  cpu: number | null;
  ram: number | null;
  disk: number | null;
  marketStatus: string;
  marketDetail: string;
  marketBid: number | null;
  marketAsk: number | null;
  marketSpread: number | null;
  marketFreshness: string | null;
  devices: Array<{
    device_id: string;
    status: string;
    connection_state: string;
    transport: string;
    last_seen_human: string | null;
  }>;
  presenceClients: Array<{
    device_id: string;
    display_name: string;
    status: string;
    app_connected: boolean;
    wg_connected: boolean | null;
  }>;
  lastError: string | null;
  raw: Record<string, unknown> | null;
  supervisor: {
    process_ready?: boolean;
    trading_ready?: boolean;
    trading_blockers?: string[];
    kill_switch?: { active?: boolean; reason?: string | null };
  } | null;
  broker: { state?: string; detail?: string } | null;
  accounts: Array<{ id: string; status: string; balance: number | null }>;
  positions: Array<{ symbol: string; side: string; size: string | number; pnl: number | null }>;
  orders: Array<Record<string, unknown>>;
  incidents: Array<{ severity?: string; message?: string; code?: string }>;
  events: Array<{ type?: string; event?: string; at?: string; timestamp?: string }>;
  backupHint: string | null;
};

type RuntimeCfg = {
  apiBase?: string;
  adminToken?: string;
  deviceId?: string;
  transport?: string;
  serverId?: string;
};

declare global {
  interface Window {
    VS_ADMIN_RUNTIME?: RuntimeCfg;
  }
}

function applyRuntimeBootstrap() {
  const rt = typeof window !== 'undefined' ? window.VS_ADMIN_RUNTIME : undefined;
  if (!rt) return;
  if (rt.apiBase) {
    const base = rt.apiBase.replace(/\/$/, '');
    // Never keep MSI localhost as API — Control API is on i3
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(base)) {
      localStorage.setItem('VS_API_BASE', base);
    } else if (!localStorage.getItem('VS_API_BASE')) {
      localStorage.setItem('VS_API_BASE', base);
    }
  }
  if (rt.adminToken) localStorage.setItem('VS_ADMIN_TOKEN', rt.adminToken);
  if (rt.deviceId) localStorage.setItem('VS_ADMIN_DEVICE_ID', rt.deviceId);
  if (rt.transport) localStorage.setItem('VS_ADMIN_TRANSPORT', rt.transport);
}

const empty: LiveState = {
  connected: false,
  connectionPhase: 'DISCONNECTED',
  serverId: 'VS-CORE-01',
  adminName: 'VS-ADMIN-01',
  transport: 'LAN',
  heartbeatAgeSec: null,
  uptime: null,
  health: 'FAILED',
  clientsRegistered: 0,
  clientsOnline: 0,
  openPositions: null,
  totalPnlToday: null,
  cpu: null,
  ram: null,
  disk: null,
  marketStatus: 'NOT_READY',
  marketDetail: 'NO DATA',
  marketBid: null,
  marketAsk: null,
  marketSpread: null,
  marketFreshness: null,
  devices: [],
  presenceClients: [],
  lastError: null,
  raw: null,
  supervisor: null,
  broker: null,
  accounts: [],
  positions: [],
  orders: [],
  incidents: [],
  events: [],
  backupHint: null,
};

function apiBase(): string {
  applyRuntimeBootstrap();
  const fromLs = localStorage.getItem('VS_API_BASE');
  if (fromLs && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(fromLs)) {
    return fromLs.replace(/\/$/, '');
  }
  const rt = typeof window !== 'undefined' ? window.VS_ADMIN_RUNTIME?.apiBase : undefined;
  if (rt) return rt.replace(/\/$/, '');
  const vite = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL;
  if (vite) return vite.replace(/\/$/, '');
  if (fromLs) return fromLs.replace(/\/$/, '');
  return '';
}
function token(): string {
  applyRuntimeBootstrap();
  const fromLs = localStorage.getItem('VS_ADMIN_TOKEN');
  if (fromLs) return fromLs;
  const vite = (import.meta as { env?: { VITE_API_ADMIN_TOKEN?: string } }).env?.VITE_API_ADMIN_TOKEN;
  return vite || '';
}
function deviceId(): string {
  applyRuntimeBootstrap();
  let id = localStorage.getItem('VS_ADMIN_DEVICE_ID');
  if (!id) {
    id = 'VS-ADMIN-01';
    localStorage.setItem('VS_ADMIN_DEVICE_ID', id);
  }
  return id;
}
function transport(): LiveState['transport'] {
  const t = (
    localStorage.getItem('VS_ADMIN_TRANSPORT') ||
    window.VS_ADMIN_RUNTIME?.transport ||
    'LAN'
  ).toUpperCase();
  return t === 'UNKNOWN' ? 'UNKNOWN' : 'LAN';
}

async function safeJson(url: string, headers: HeadersInit): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function useAdminLive(): LiveState {
  const [state, setState] = useState<LiveState>(empty);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let stop = false;
    let backoff = 1500;
    applyRuntimeBootstrap();

    const headers = (): HeadersInit => {
      const h: Record<string, string> = { 'content-type': 'application/json' };
      const t = token();
      if (t) h['x-admin-token'] = t;
      return h;
    };

    async function heartbeat() {
      const t = token();
      if (!t) return;
      await fetch(apiBase() + '/api/v1/presence/heartbeat', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          device_id: deviceId(),
          display_name: deviceId(),
          role: 'ADMIN',
          transport: 'LAN',
          app_version: 'admin-desktop',
        }),
      });
    }

    async function tick() {
      try {
        const base = apiBase();
        if (!base) throw new Error('NO_API_BASE — runtime-config.js missing apiBase');
        const h = headers();

        // Prove link with /health first (no token) — surfaces real CONNECTED even if token empty
        const healthRes = await fetch(base + '/health', { signal: AbortSignal.timeout(5000) });
        if (!healthRes.ok) throw new Error('HEALTH HTTP ' + healthRes.status);
        const healthBody = (await healthRes.json()) as { service?: string; server_id?: string };
        if (healthBody.service !== 'VS-CORE') throw new Error('NOT_VS_CORE');

        await heartbeat();
        const res = await fetch(base + '/api/v1/server/monitor', { headers: h });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const snap = (await res.json()) as Record<string, unknown>;
        const [presence, supervisor, broker, market, position, incidents] = await Promise.all([
          safeJson(base + '/api/v1/presence', h),
          safeJson(base + '/api/v1/system/supervisor', h),
          safeJson(base + '/api/v1/broker/health', h),
          safeJson(base + '/api/v1/market', h),
          safeJson(base + '/api/v1/position', h),
          safeJson(base + '/api/v1/incidents', h),
        ]);
        if (stop) return;
        const sys = (snap.system || {}) as Record<string, unknown>;
        const clients = (snap.clients || {}) as Record<string, unknown>;
        const marketSnap = (snap.market || {}) as Record<string, unknown>;
        const m = market || {};
        const posList = Array.isArray(position?.positions)
          ? (position!.positions as LiveState['positions'])
          : Array.isArray(position?.items)
            ? (position!.items as LiveState['positions'])
            : [];
        const openCount =
          typeof position?.open_count === 'number'
            ? (position!.open_count as number)
            : posList.length > 0
              ? posList.length
              : null;
        const pnlToday =
          typeof position?.pnl_today === 'number'
            ? (position!.pnl_today as number)
            : typeof position?.total_pnl_today === 'number'
              ? (position!.total_pnl_today as number)
              : null;
        const incidentList = Array.isArray(incidents?.incidents)
          ? (incidents!.incidents as LiveState['incidents'])
          : Array.isArray(incidents?.items)
            ? (incidents!.items as LiveState['incidents'])
            : [];
        const okAt = Date.now();
        setLastOkAt(okAt);
        setState({
          connected: true,
          connectionPhase: 'CONNECTED',
          serverId: String(
            snap.server_id || healthBody.server_id || window.VS_ADMIN_RUNTIME?.serverId || 'VS-CORE-01'
          ),
          adminName: deviceId(),
          transport: transport(),
          heartbeatAgeSec: 0,
          uptime: (snap.uptime_human as string) || null,
          health:
            (snap.api as { status?: string })?.status === 'ONLINE' &&
            (snap.database as { status?: string })?.status === 'ONLINE'
              ? 'HEALTHY'
              : (snap.api as { status?: string })?.status === 'ONLINE'
                ? 'DEGRADED'
                : 'FAILED',
          clientsRegistered: Number(clients.total ?? 0),
          clientsOnline: Number(clients.online ?? 0),
          openPositions: openCount,
          totalPnlToday: pnlToday,
          cpu: (sys.cpu_percent as number) ?? null,
          ram: (sys.ram_percent as number) ?? null,
          disk: (sys.disk_percent as number) ?? null,
          marketStatus: String(marketSnap.status || m.status || 'UNKNOWN'),
          marketDetail: String(marketSnap.detail || m.detail || 'NO DATA'),
          marketBid: typeof m.bid === 'number' ? m.bid : null,
          marketAsk: typeof m.ask === 'number' ? m.ask : null,
          marketSpread: typeof m.spread === 'number' ? m.spread : null,
          marketFreshness: (m.freshness as string) || (marketSnap.freshness as string) || null,
          devices: (clients.devices as LiveState['devices']) || [],
          presenceClients: (presence?.clients as LiveState['presenceClients']) || [],
          lastError: (snap.last_error as string) || null,
          raw: snap,
          supervisor: (supervisor as LiveState['supervisor']) || null,
          broker: broker
            ? { state: String(broker.state || broker.status || 'UNKNOWN'), detail: String(broker.detail || '') }
            : null,
          accounts: [],
          positions: posList,
          orders: [],
          incidents: incidentList,
          events: [],
          backupHint: null,
        });
        backoff = 1500;
      } catch {
        if (stop) return;
        setState((s) => {
          const age =
            lastOkAt == null ? null : Math.max(0, Math.round((Date.now() - lastOkAt) / 1000));
          // CONNECTED → reconnecting/degraded → DISCONNECTED (never fake CONNECTED)
          let connectionPhase: LiveState['connectionPhase'] = 'DISCONNECTED';
          let health: LiveState['health'] = 'FAILED';
          if (lastOkAt != null && age != null && age < 15) {
            connectionPhase = 'RECONNECTING';
            health = 'DEGRADED';
          } else if (lastOkAt != null && age != null && age < 45) {
            connectionPhase = 'DEGRADED';
            health = 'DEGRADED';
          }
          return {
            ...s,
            connected: false,
            connectionPhase,
            health,
            heartbeatAgeSec: age,
          };
        });
        backoff = Math.min(backoff * 2, 12000);
      }
    }

    const loop = async () => {
      await tick();
      if (!stop) setTimeout(loop, backoff);
    };
    loop();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useMemo(() => {
    const age =
      state.connected && lastOkAt != null
        ? Math.max(0, Math.round((now - lastOkAt) / 1000))
        : state.heartbeatAgeSec;
    return { ...state, heartbeatAgeSec: age };
  }, [state, lastOkAt, now]);
}
