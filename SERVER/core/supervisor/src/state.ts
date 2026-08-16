/**
 * VS-CORE supervisor — process readiness vs trading readiness.
 * Never claims TRADING_READY because Node is running.
 */

export type SubsystemState =
  | 'STARTING'
  | 'READY'
  | 'DEGRADED'
  | 'BLOCKED'
  | 'FAILED'
  | 'STOPPING'
  | 'STOPPED';

export type SubsystemName =
  | 'configuration'
  | 'secrets'
  | 'postgresql'
  | 'redis'
  | 'migrations'
  | 'event_bus'
  | 'audit'
  | 'account_engine'
  | 'client_device_registry'
  | 'broker_gateway'
  | 'market_data'
  | 'indicators'
  | 'regime_engine'
  | 'strategy_engine'
  | 'signal_engine'
  | 'risk_engine'
  | 'execution_engine'
  | 'position_engine'
  | 'reconciliation'
  | 'client_api'
  | 'control_api'
  | 'websocket_gateway'
  | 'dashboard'
  | 'wireguard';

export type SubsystemStatus = {
  name: SubsystemName;
  state: SubsystemState;
  detail: string;
  updated_at: string;
  error: string | null;
};

export type SupervisorSnapshot = {
  server_id: string;
  process_ready: boolean;
  trading_ready: boolean;
  trading_blockers: string[];
  live_trading_enabled: boolean;
  subsystems: SubsystemStatus[];
  timestamp: string;
};

/** Boot order from master task (dependency direction). */
export const BOOT_ORDER: SubsystemName[] = [
  'configuration',
  'secrets',
  'postgresql',
  'redis',
  'migrations',
  'event_bus',
  'audit',
  'account_engine',
  'client_device_registry',
  'broker_gateway',
  'market_data',
  'indicators',
  'regime_engine',
  'strategy_engine',
  'signal_engine',
  'risk_engine',
  'execution_engine',
  'position_engine',
  'reconciliation',
  'client_api',
  'control_api',
  'websocket_gateway',
  'dashboard',
];

export function createInitialRegistry(): Map<SubsystemName, SubsystemStatus> {
  const m = new Map<SubsystemName, SubsystemStatus>();
  const now = new Date().toISOString();
  for (const name of [...BOOT_ORDER, 'wireguard'] as SubsystemName[]) {
    m.set(name, {
      name,
      state: 'STOPPED',
      detail: 'not started',
      updated_at: now,
      error: null,
    });
  }
  return m;
}

export function setSubsystem(
  reg: Map<SubsystemName, SubsystemStatus>,
  name: SubsystemName,
  state: SubsystemState,
  detail: string,
  error: string | null = null
): void {
  reg.set(name, {
    name,
    state,
    detail,
    updated_at: new Date().toISOString(),
    error,
  });
}

/**
 * Trading readiness is STRICTLY separate from process readiness.
 * Default: blocked. Never invent READY.
 */
export function evaluateTradingReady(input: {
  liveTradingEnabled: boolean;
  brokerConnected: boolean;
  marketDataLive: boolean;
  marketStale: boolean;
  databaseOk: boolean;
  reconciliationOk: boolean;
  riskConfigValid: boolean;
  killSwitchActive: boolean;
  operatorAuthorized: boolean;
}): { trading_ready: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (!input.liveTradingEnabled) blockers.push('LIVE_TRADING_DISABLED');
  if (!input.operatorAuthorized) blockers.push('OPERATOR_NOT_AUTHORIZED');
  if (!input.brokerConnected) blockers.push('BROKER_DISCONNECTED');
  if (!input.marketDataLive) blockers.push('MARKET_DATA_UNAVAILABLE');
  if (input.marketStale) blockers.push('MARKET_DATA_STALE');
  if (!input.databaseOk) blockers.push('DATABASE_UNAVAILABLE');
  if (!input.reconciliationOk) blockers.push('RECONCILIATION_PENDING');
  if (!input.riskConfigValid) blockers.push('RISK_CONFIG_INVALID');
  if (input.killSwitchActive) blockers.push('KILL_SWITCH_ACTIVE');
  return { trading_ready: blockers.length === 0, blockers };
}

export function evaluateProcessReady(
  reg: Map<SubsystemName, SubsystemStatus>
): boolean {
  // Minimum for "server brain answering": config, secrets, postgres, control_api
  const required: SubsystemName[] = [
    'configuration',
    'secrets',
    'postgresql',
    'control_api',
  ];
  for (const n of required) {
    const s = reg.get(n);
    if (!s || (s.state !== 'READY' && s.state !== 'DEGRADED')) return false;
    if (s.state === 'FAILED' || s.state === 'BLOCKED') return false;
  }
  const pg = reg.get('postgresql');
  if (!pg || pg.state !== 'READY') return false;
  const api = reg.get('control_api');
  if (!api || api.state !== 'READY') return false;
  return true;
}

export function snapshot(
  reg: Map<SubsystemName, SubsystemStatus>,
  trading: { trading_ready: boolean; blockers: string[] },
  opts?: { serverId?: string; liveTradingEnabled?: boolean }
): SupervisorSnapshot {
  return {
    server_id: opts?.serverId || process.env.VS_SERVER_ID || 'VS-CORE-01',
    process_ready: evaluateProcessReady(reg),
    trading_ready: trading.trading_ready,
    trading_blockers: trading.blockers,
    live_trading_enabled: opts?.liveTradingEnabled === true,
    subsystems: [...reg.values()],
    timestamp: new Date().toISOString(),
  };
}
