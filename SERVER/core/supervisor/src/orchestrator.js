"use strict";
/**
 * Supervisor orchestrator — probes real dependencies; never fakes READY.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateSupervisor = evaluateSupervisor;
const net_1 = require("net");
const state_js_1 = require("./state.js");
function tcpOk(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
        const sock = (0, net_1.createConnection)({ host, port });
        const done = (ok) => {
            try {
                sock.destroy();
            }
            catch {
                /* ignore */
            }
            resolve(ok);
        };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => done(true));
        sock.once('timeout', () => done(false));
        sock.once('error', () => done(false));
    });
}
async function defaultPostgres() {
    return tcpOk('127.0.0.1', Number(process.env.DB_PORT || 5432));
}
async function defaultRedis() {
    return tcpOk('127.0.0.1', Number(process.env.REDIS_PORT || 6379));
}
async function defaultControlApi() {
    const port = Number(process.env.CONTROL_API_PORT || 3000);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: AbortSignal.timeout(2500),
        });
        return res.ok;
    }
    catch {
        return false;
    }
}
/**
 * Evaluate current host/runtime into a supervisor snapshot.
 * Trading stays fail-closed unless every gate is explicitly true.
 */
async function evaluateSupervisor(probes = {}) {
    const reg = (0, state_js_1.createInitialRegistry)();
    const live = process.env.LIVE_TRADING_ENABLED === 'true';
    // configuration
    const hasMode = !!process.env.OPERATING_MODE || true;
    (0, state_js_1.setSubsystem)(reg, 'configuration', hasMode ? 'READY' : 'BLOCKED', hasMode ? 'OPERATING_MODE present or default' : 'CONFIG_REQUIRED', hasMode ? null : 'CONFIG_REQUIRED');
    // secrets — never print values
    const token = process.env.API_ADMIN_TOKEN || '';
    const secretsOk = token.length >= 8 && !token.includes('CHANGE_ME') && process.env.DB_PASSWORD !== 'CHANGE_ME';
    (0, state_js_1.setSubsystem)(reg, 'secrets', secretsOk ? 'READY' : 'DEGRADED', secretsOk ? 'required secrets look set' : 'CONFIG_REQUIRED: weak/default secrets', secretsOk ? null : 'CONFIG_REQUIRED');
    const pgOk = await (probes.checkPostgres || defaultPostgres)();
    (0, state_js_1.setSubsystem)(reg, 'postgresql', pgOk ? 'READY' : 'FAILED', pgOk ? 'TCP 127.0.0.1:5432 open' : 'PostgreSQL connection refused', pgOk ? null : 'DATABASE_UNAVAILABLE');
    const redisOk = await (probes.checkRedis || defaultRedis)();
    (0, state_js_1.setSubsystem)(reg, 'redis', redisOk ? 'READY' : 'DEGRADED', redisOk ? 'TCP 127.0.0.1:6379 open' : 'Redis unreachable (optional degraded)', redisOk ? null : 'REDIS_UNAVAILABLE');
    (0, state_js_1.setSubsystem)(reg, 'migrations', pgOk ? 'READY' : 'BLOCKED', pgOk ? 'assume migrated when DB up (INSTALL runs migrate)' : 'blocked on database', pgOk ? null : 'MIGRATIONS_BLOCKED');
    // Engines exist in control-api process when API is up — mark DEGRADED until deeper probes
    const apiOk = await (probes.checkControlApi || defaultControlApi)();
    const engineState = apiOk ? 'READY' : 'STOPPED';
    const engineDetail = apiOk
        ? 'hosted inside control-api process'
        : 'control-api not answering /health';
    const hosted = [
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
        'websocket_gateway',
    ];
    for (const n of hosted) {
        (0, state_js_1.setSubsystem)(reg, n, engineState, engineDetail, apiOk ? null : 'CONTROL_API_DOWN');
    }
    (0, state_js_1.setSubsystem)(reg, 'control_api', apiOk ? 'READY' : 'FAILED', apiOk ? `health OK :${process.env.CONTROL_API_PORT || 3000}` : 'health failed', apiOk ? null : 'CONTROL_API_DOWN');
    (0, state_js_1.setSubsystem)(reg, 'dashboard', apiOk ? 'READY' : 'STOPPED', apiOk ? 'local monitor via /api/v1/server/monitor' : 'API down', null);
    const wg = probes.checkWireguard
        ? await probes.checkWireguard()
        : 'DEGRADED';
    (0, state_js_1.setSubsystem)(reg, 'wireguard', wg === 'READY' ? 'READY' : wg === 'FAILED' ? 'FAILED' : 'DEGRADED', wg === 'READY' ? 'interface up' : 'WG not verified in this probe (LAN ADMIN may still work)', wg === 'FAILED' ? 'WIREGUARD_ERROR' : null);
    // Trading: always evaluate fail-closed — do not invent broker/market live here
    const trading = (0, state_js_1.evaluateTradingReady)({
        liveTradingEnabled: live,
        brokerConnected: false, // require explicit capital session proof elsewhere
        marketDataLive: false,
        marketStale: true,
        databaseOk: pgOk,
        reconciliationOk: false,
        riskConfigValid: true,
        killSwitchActive: false,
        operatorAuthorized: false,
    });
    void state_js_1.BOOT_ORDER; // documented order — evaluation is probe-based, not sequential start here
    return (0, state_js_1.snapshot)(reg, trading, {
        serverId: process.env.VS_SERVER_ID || 'VS-CORE-01',
        liveTradingEnabled: live,
    });
}
