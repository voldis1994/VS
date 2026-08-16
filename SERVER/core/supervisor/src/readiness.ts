/**
 * VS CORE supervisor readiness — PROCESS/SYSTEM/TRADING are distinct.
 * Never invent READY. Absent probes → false / UNKNOWN.
 */

export type ReadyFlag =
  | 'PROCESS_READY'
  | 'DATABASE_READY'
  | 'REDIS_READY'
  | 'NETWORK_READY'
  | 'MARKET_DATA_READY'
  | 'BROKER_READY'
  | 'STRATEGY_READY'
  | 'RISK_READY'
  | 'EXECUTION_READY'
  | 'RECONCILIATION_READY'
  | 'CONTROL_API_READY'
  | 'CLIENT_API_READY'
  | 'WIREGUARD_READY'
  | 'SYSTEM_READY'
  | 'TRADING_READY';

export type Probe = {
  name: ReadyFlag | string;
  ok: boolean;
  detail: string;
  configRequired?: boolean;
};

export type SupervisorSnapshot = {
  process_ready: boolean;
  system_ready: boolean;
  trading_ready: boolean;
  flags: Record<string, boolean>;
  probes: Probe[];
  trading_blockers: string[];
  checked_at: string;
};

export function computeSupervisor(probes: Probe[]): SupervisorSnapshot {
  const flags: Record<string, boolean> = {};
  for (const p of probes) flags[p.name] = p.ok;

  const need = (n: string) => flags[n] === true;

  const process_ready = need('PROCESS_READY') && need('CONTROL_API_READY');
  const system_ready =
    process_ready &&
    need('DATABASE_READY') &&
    need('CLIENT_API_READY');

  const trading_blockers: string[] = [];
  const tradingGates: Array<[string, string]> = [
    ['BROKER_READY', 'BROKER_NOT_READY'],
    ['MARKET_DATA_READY', 'MARKET_DATA_NOT_READY'],
    ['STRATEGY_READY', 'STRATEGY_NOT_READY'],
    ['RISK_READY', 'RISK_NOT_READY'],
    ['EXECUTION_READY', 'EXECUTION_NOT_READY'],
    ['RECONCILIATION_READY', 'RECONCILIATION_NOT_READY'],
  ];
  for (const [flag, code] of tradingGates) {
    if (!need(flag)) trading_blockers.push(code);
  }
  for (const p of probes) {
    if (p.configRequired) trading_blockers.push(`${p.name}_CONFIG_REQUIRED`);
  }

  const trading_ready = system_ready && trading_blockers.length === 0;

  return {
    process_ready,
    system_ready,
    trading_ready,
    flags,
    probes,
    trading_blockers: [...new Set(trading_blockers)],
    checked_at: new Date().toISOString(),
  };
}
