/** Shared types for GET /api/v1/server/monitor */

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

export type ServerMonitor = {
  ok: boolean;
  role: 'server_monitor';
  server_id: string;
  hostname?: string;
  server_version: string;
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
  server_process: ServiceCell;
  admin: {
    status: MonitorState;
    connected: boolean;
    device_id: string | null;
    device_name: string | null;
    transport: string;
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
    }>;
  };
  market: { status: string; state: string; detail: string };
  trading: { enabled: boolean; readiness: string; mode: string; detail: string };
  strategy: { status: string; detail: string };
  risk: { status: string; detail: string };
  execution: { status: string; detail: string };
  reconciliation: { status: string; detail: string };
  system: {
    cpu_percent: number | null;
    ram_percent: number | null;
    disk_percent: number | null;
  };
  last_error: string | null;
  errors: string[];
};

export function isOnline(st: string | undefined | null): boolean {
  return String(st || '').toUpperCase() === 'ONLINE';
}

export function infraHealthy(m: ServerMonitor | null): boolean {
  if (!m) return false;
  return (
    isOnline(m.api.status) &&
    isOnline(m.database.status) &&
    (isOnline(m.redis.status) || m.redis.status === 'WARNING')
  );
}
