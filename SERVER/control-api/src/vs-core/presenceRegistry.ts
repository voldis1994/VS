/**
 * In-memory presence registry for ADMIN / CLIENT / MONITOR heartbeats.
 * Derived ONLINE/DEGRADED/OFFLINE from last_heartbeat — never invent CONNECTED.
 */

export type PresenceStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'UNKNOWN';
export type PresenceRole = 'ADMIN' | 'CLIENT' | 'MONITOR';

export type PresenceRecord = {
  device_id: string;
  display_name: string;
  role: PresenceRole;
  status: PresenceStatus;
  connected_at: string | null;
  last_heartbeat: string | null;
  heartbeat_age_ms: number | null;
  transport: 'LAN' | 'WIREGUARD' | 'NONE' | 'UNKNOWN';
  source_ip: string | null;
  vpn_ip: string | null;
  app_version: string | null;
  session_id: string | null;
  wg_connected: boolean | null;
  app_connected: boolean;
};

export type PresenceConfig = {
  onlineMs: number;
  degradedMs: number;
};

const DEFAULT_CFG: PresenceConfig = {
  onlineMs: Number(process.env.VS_PRESENCE_ONLINE_MS || 10_000),
  degradedMs: Number(process.env.VS_PRESENCE_DEGRADED_MS || 30_000),
};

type Internal = {
  device_id: string;
  display_name: string;
  role: PresenceRole;
  connected_at: string;
  last_heartbeat: string;
  transport: PresenceRecord['transport'];
  source_ip: string | null;
  vpn_ip: string | null;
  app_version: string | null;
  session_id: string | null;
  wg_connected: boolean | null;
};

const store = new Map<string, Internal>();

function statusOf(lastHb: string, cfg: PresenceConfig, now = Date.now()): {
  status: PresenceStatus;
  age: number;
} {
  const t = Date.parse(lastHb);
  const age = Number.isFinite(t) ? Math.max(0, now - t) : Number.POSITIVE_INFINITY;
  if (age <= cfg.onlineMs) return { status: 'ONLINE', age };
  if (age <= cfg.degradedMs) return { status: 'DEGRADED', age };
  return { status: 'OFFLINE', age };
}

export function heartbeatPresence(input: {
  device_id: string;
  display_name?: string;
  role: PresenceRole;
  transport?: PresenceRecord['transport'];
  source_ip?: string | null;
  vpn_ip?: string | null;
  app_version?: string | null;
  session_id?: string | null;
  wg_connected?: boolean | null;
}): PresenceRecord {
  const nowIso = new Date().toISOString();
  const prev = store.get(input.device_id);
  let connected_at = prev?.connected_at || nowIso;
  if (prev) {
    const st = statusOf(prev.last_heartbeat, DEFAULT_CFG);
    if (st.status === 'OFFLINE') connected_at = nowIso;
  }
  const rec: Internal = {
    device_id: input.device_id,
    display_name: input.display_name || prev?.display_name || input.device_id,
    role: input.role,
    connected_at,
    last_heartbeat: nowIso,
    transport: input.transport || prev?.transport || 'UNKNOWN',
    source_ip: input.source_ip ?? prev?.source_ip ?? null,
    vpn_ip: input.vpn_ip ?? prev?.vpn_ip ?? null,
    app_version: input.app_version ?? prev?.app_version ?? null,
    session_id: input.session_id ?? prev?.session_id ?? null,
    wg_connected: input.wg_connected ?? prev?.wg_connected ?? null,
  };
  store.set(input.device_id, rec);
  return toRecord(rec);
}

export function listPresence(role?: PresenceRole): PresenceRecord[] {
  const out: PresenceRecord[] = [];
  for (const rec of store.values()) {
    if (role && rec.role !== role) continue;
    out.push(toRecord(rec));
  }
  return out.sort((a, b) => a.display_name.localeCompare(b.display_name));
}

export function getAdminPresence(): PresenceRecord | null {
  const live = listPresence('ADMIN')
    .filter((a) => a.status === 'ONLINE' || a.status === 'DEGRADED')
    .sort((a, b) => (a.heartbeat_age_ms ?? 9e9) - (b.heartbeat_age_ms ?? 9e9));
  return live[0] || null;
}

function toRecord(rec: Internal): PresenceRecord {
  const { status, age } = statusOf(rec.last_heartbeat, DEFAULT_CFG);
  const app_connected = status === 'ONLINE' || status === 'DEGRADED';
  return {
    device_id: rec.device_id,
    display_name: rec.display_name,
    role: rec.role,
    status,
    connected_at: rec.connected_at,
    last_heartbeat: rec.last_heartbeat,
    heartbeat_age_ms: Number.isFinite(age) ? age : null,
    transport: rec.transport,
    source_ip: rec.source_ip,
    vpn_ip: rec.vpn_ip,
    app_version: rec.app_version,
    session_id: rec.session_id,
    wg_connected: rec.wg_connected,
    app_connected,
  };
}

export function _resetPresenceForTests(): void {
  store.clear();
}
