/**
 * Shared UI contracts — versioned DTOs for SERVER PANEL / ADMIN / CLIENT.
 * No secrets. No invented LIVE/CONNECTED values.
 */

export const UI_CONTRACT_VERSION = '2.0.0';

export type GlobalStatus =
  | 'OPERATIONAL'
  | 'DEGRADED'
  | 'NOT_READY'
  | 'TRADING_DISABLED'
  | 'CRITICAL';

export type ServiceRuntimeState =
  | 'RUNNING'
  | 'READY'
  | 'DEGRADED'
  | 'FAILED'
  | 'DISCONNECTED'
  | 'NOT_READY'
  | 'CONFIG_REQUIRED'
  | 'UNKNOWN';

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
  /** WireGuard peer state — independent of app heartbeat */
  wg_connected: boolean | null;
  /** Application session — independent of WG */
  app_connected: boolean;
};

export type MarketUiSnapshot = {
  symbol: string;
  status: 'LIVE' | 'STALE' | 'CLOSED' | 'DISCONNECTED' | 'UNKNOWN';
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread: number | null;
  last_update: string | null;
  latency_ms: number | null;
  /** Chart points only when real ticks exist — never fabricate */
  series: Array<{ t: string; v: number }> | null;
};

export type BrokerUiStatus = {
  environment: 'LIVE' | 'DEMO' | 'UNKNOWN' | 'CONFIG_REQUIRED';
  connection: 'CONNECTED' | 'DISCONNECTED' | 'CONFIG_REQUIRED' | 'ERROR';
  account: string | null;
  positions: number | null;
  working_orders: number | null;
  last_sync: string | null;
};

export type ServerPanelSnapshot = {
  contract_version: string;
  server_id: string;
  uptime_seconds: number;
  utc_time: string;
  global_status: GlobalStatus;
  system: {
    os: string | null;
    cpu_percent: number | null;
    ram_used_gb: number | null;
    ram_total_gb: number | null;
    ssd_used_gb: number | null;
    ssd_total_gb: number | null;
    network: string;
    internet: boolean | null;
    time_sync: string;
  };
  services: Array<{ name: string; state: ServiceRuntimeState; detail: string }>;
  market_feeds: Array<{
    name: string;
    status: string;
    latency_ms: number | null;
    last_update: string | null;
  }>;
  broker: BrokerUiStatus;
  admin: PresenceRecord | null;
  clients: {
    registered: number;
    online: number;
    trading: number;
    paused: number;
    disabled: number;
    rows: PresenceRecord[];
  };
  incidents: Array<{
    severity: string;
    code: string;
    message: string;
    created_at: string;
  }>;
  events: Array<{ category: string; message: string; at: string }>;
  connection: 'OK' | 'LOST';
};

export type AdminDashboardSnapshot = {
  contract_version: string;
  server_id: string;
  connected: boolean;
  server_health: 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'UNKNOWN';
  uptime_seconds: number | null;
  clients_registered: number;
  clients_online: number;
  total_pnl_today: number | null;
  open_positions: number | null;
  market: MarketUiSnapshot | null;
  resources: {
    cpu_percent: number | null;
    ram_percent: number | null;
    disk_percent: number | null;
  };
  incidents_open: number;
};

export type ClientHomeSnapshot = {
  contract_version: string;
  connection:
    | 'CONNECTING'
    | 'CONNECTED'
    | 'VPN_OFFLINE'
    | 'SERVER_OFFLINE'
    | 'AUTH_FAILED'
    | 'SESSION_EXPIRED';
  client_name: string | null;
  account_status: 'RUNNING' | 'PAUSED' | 'STOPPED' | 'UNKNOWN';
  trading_participation: boolean;
  market: MarketUiSnapshot | null;
  lot_size: number;
  positions_count: number;
};
