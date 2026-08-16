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
  devices: [],
  presenceClients: [],
  lastError: null,
  raw: null,
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
          app_version: 'admin-dashboard-v2',
        }),
      });
    }

    async function tick() {
      try {
        await heartbeat();
        const res = await fetch(apiBase() + '/api/v1/server/monitor', { headers: headers() });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const snap = await res.json();
        let presenceClients: LiveState['presenceClients'] = [];
        try {
          const pr = await fetch(apiBase() + '/api/v1/presence', { headers: headers() });
          if (pr.ok) {
            const p = await pr.json();
            presenceClients = p.clients || [];
          }
        } catch {
          /* ignore */
        }
        if (stop) return;
        const sys = snap.system || {};
        setState({
          connected: true,
          serverId: snap.server_id || 'VS-CORE-01',
          adminName: deviceId(),
          uptime: snap.uptime_human || null,
          health:
            snap.api?.status === 'ONLINE' && snap.database?.status === 'ONLINE'
              ? 'HEALTHY'
              : snap.api?.status === 'ONLINE'
                ? 'DEGRADED'
                : 'FAILED',
          clientsRegistered: snap.clients?.total ?? 0,
          clientsOnline: snap.clients?.online ?? 0,
          openPositions: null,
          totalPnlToday: null,
          cpu: sys.cpu_percent ?? null,
          ram: sys.ram_percent ?? null,
          disk: sys.disk_percent ?? null,
          marketStatus: snap.market?.status || 'UNKNOWN',
          marketDetail: snap.market?.detail || 'NO DATA',
          devices: snap.clients?.devices || [],
          presenceClients,
          lastError: snap.last_error || null,
          raw: snap,
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
