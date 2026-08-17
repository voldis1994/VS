"use strict";
/**
 * VS-CORE supervisor — process readiness vs trading readiness.
 * Never claims TRADING_READY because Node is running.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOOT_ORDER = void 0;
exports.createInitialRegistry = createInitialRegistry;
exports.setSubsystem = setSubsystem;
exports.evaluateTradingReady = evaluateTradingReady;
exports.evaluateProcessReady = evaluateProcessReady;
exports.snapshot = snapshot;
/** Boot order from master task (dependency direction). */
exports.BOOT_ORDER = [
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
function createInitialRegistry() {
    const m = new Map();
    const now = new Date().toISOString();
    for (const name of [...exports.BOOT_ORDER, 'wireguard']) {
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
function setSubsystem(reg, name, state, detail, error = null) {
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
function evaluateTradingReady(input) {
    const blockers = [];
    if (!input.liveTradingEnabled)
        blockers.push('LIVE_TRADING_DISABLED');
    if (!input.operatorAuthorized)
        blockers.push('OPERATOR_NOT_AUTHORIZED');
    if (!input.brokerConnected)
        blockers.push('BROKER_DISCONNECTED');
    if (!input.marketDataLive)
        blockers.push('MARKET_DATA_UNAVAILABLE');
    if (input.marketStale)
        blockers.push('MARKET_DATA_STALE');
    if (!input.databaseOk)
        blockers.push('DATABASE_UNAVAILABLE');
    if (!input.reconciliationOk)
        blockers.push('RECONCILIATION_PENDING');
    if (!input.riskConfigValid)
        blockers.push('RISK_CONFIG_INVALID');
    if (input.killSwitchActive)
        blockers.push('KILL_SWITCH_ACTIVE');
    return { trading_ready: blockers.length === 0, blockers };
}
function evaluateProcessReady(reg) {
    // Minimum for "server brain answering": config, secrets, postgres, control_api
    const required = [
        'configuration',
        'secrets',
        'postgresql',
        'control_api',
    ];
    for (const n of required) {
        const s = reg.get(n);
        if (!s || (s.state !== 'READY' && s.state !== 'DEGRADED'))
            return false;
        if (s.state === 'FAILED' || s.state === 'BLOCKED')
            return false;
    }
    const pg = reg.get('postgresql');
    if (!pg || pg.state !== 'READY')
        return false;
    const api = reg.get('control_api');
    if (!api || api.state !== 'READY')
        return false;
    return true;
}
function snapshot(reg, trading, opts) {
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
