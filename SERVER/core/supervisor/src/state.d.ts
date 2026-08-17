/**
 * VS-CORE supervisor — process readiness vs trading readiness.
 * Never claims TRADING_READY because Node is running.
 */
export type SubsystemState = 'STARTING' | 'READY' | 'DEGRADED' | 'BLOCKED' | 'FAILED' | 'STOPPING' | 'STOPPED';
export type SubsystemName = 'configuration' | 'secrets' | 'postgresql' | 'redis' | 'migrations' | 'event_bus' | 'audit' | 'account_engine' | 'client_device_registry' | 'broker_gateway' | 'market_data' | 'indicators' | 'regime_engine' | 'strategy_engine' | 'signal_engine' | 'risk_engine' | 'execution_engine' | 'position_engine' | 'reconciliation' | 'client_api' | 'control_api' | 'websocket_gateway' | 'dashboard' | 'wireguard';
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
export declare const BOOT_ORDER: SubsystemName[];
export declare function createInitialRegistry(): Map<SubsystemName, SubsystemStatus>;
export declare function setSubsystem(reg: Map<SubsystemName, SubsystemStatus>, name: SubsystemName, state: SubsystemState, detail: string, error?: string | null): void;
/**
 * Trading readiness is STRICTLY separate from process readiness.
 * Default: blocked. Never invent READY.
 */
export declare function evaluateTradingReady(input: {
    liveTradingEnabled: boolean;
    brokerConnected: boolean;
    marketDataLive: boolean;
    marketStale: boolean;
    databaseOk: boolean;
    reconciliationOk: boolean;
    riskConfigValid: boolean;
    killSwitchActive: boolean;
    operatorAuthorized: boolean;
}): {
    trading_ready: boolean;
    blockers: string[];
};
export declare function evaluateProcessReady(reg: Map<SubsystemName, SubsystemStatus>): boolean;
export declare function snapshot(reg: Map<SubsystemName, SubsystemStatus>, trading: {
    trading_ready: boolean;
    blockers: string[];
}, opts?: {
    serverId?: string;
    liveTradingEnabled?: boolean;
}): SupervisorSnapshot;
