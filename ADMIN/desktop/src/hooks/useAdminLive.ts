import { useEffect, useMemo, useState } from 'react';

export type LiveState = {
  connected: boolean;
  serverId: string;
  adminName: string;
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

const empty: LiveState = {
  connected: false,
  serverId: 'VS-CORE-01',
  adminName: 'VS-ADMIN-01',
  uptime: null,
  health: 'UNKNOWN',
  clientsRegistered: 0,
  clientsOnline: 0,
  openPositions: null,
  totalPnlToday: null,
  cpu: null,
  ram: null,
  disk: null,
  marketStatus: 'UNKNOWN',
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
  return localStorage.getItem('VS_API_BASE') || 'http://127.0.0.1:3000';
}
function token(): string {
  return localStorage.getItem('VS_ADMIN_TOKEN') || '';
}
function deviceId(): string {
  let id = localStorage.getItem('VS_ADMIN_DEVICE_ID');
  if (!id) {
    id = 'VS-ADMIN-01';
    localStorage.setItem('VS_ADMIN_DEVICE_ID', id);
  }
  return id;
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

  useEffect(() => {
    let stop = false;
    let backoff = 1500;

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
        await heartbeat();
        const base = apiBase();
        const h = headers();
        const res = await fetch(base + '/api/v1/server/monitor', { headers: h });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const snap = (await res.json()) as Record<string, unknown>;
        const [presence, supervisor, broker, market] = await Promise.all([
          safeJson(base + '/api/v1/presence', h),
          safeJson(base + '/api/v1/system/supervisor', h),
          safeJson(base + '/api/v1/broker/health', h),
          safeJson(base + '/api/v1/market', h),
        ]);
        if (stop) return;
        const sys = (snap.system || {}) as Record<string, unknown>;
        const clients = (snap.clients || {}) as Record<string, unknown>;
        const marketSnap = (snap.market || {}) as Record<string, unknown>;
        const m = market || {};
        setState({
          connected: true,
          serverId: String(snap.server_id || 'VS-CORE-01'),
          adminName: deviceId(),
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
          openPositions: null,
          totalPnlToday: null,
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
          presenceClients: ((presence?.clients as LiveState['presenceClients']) || []),
          lastError: (snap.last_error as string) || null,
          raw: snap,
          supervisor: (supervisor as LiveState['supervisor']) || null,
          broker: broker
            ? { state: String(broker.state || broker.status || 'UNKNOWN'), detail: String(broker.detail || '') }
            : null,
          accounts: [],
          positions: [],
          orders: [],
          incidents: [],
          events: [],
          backupHint: null,
        });
        backoff = 1500;
      } catch {
        if (stop) return;
        setState((s) => ({ ...s, connected: false, health: 'UNKNOWN' }));
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
  }, []);

  return useMemo(() => state, [state]);
}
