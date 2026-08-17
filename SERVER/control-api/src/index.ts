import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { pool, healthCheck } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { registerClientRoutes } from './routes/clients.js';
import { registerBrokerRoutes } from './routes/brokers.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerTradeRoutes } from './routes/trades.js';
import { registerMarketRoutes } from './routes/market.js';
import { registerMarketIntelligenceRoutes } from './routes/marketIntelligence.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTradingRoutes } from './routes/trading.js';
import { registerRobotReaderRoutes } from './routes/robotReader.js';
import { registerRobotDeskRoutes } from './routes/robotDesk.js';
import { registerClientAuthRoutes } from './routes/clientAuth.js';
import { registerClientPanelRoutes } from './routes/clientPanel.js';
import { registerPipelineRoutes } from './routes/pipeline.js';
import { registerClientPanelStatic } from './services/clientPanelStatic.js';
import { TelemetryBroadcaster } from './ws/telemetry.js';
import { ClientEventHub, setClientEventHub } from './services/clientEvents.js';
import { authMiddleware } from './middleware/auth.js';
import {
  extractClientToken,
  resolveClientSession,
} from './security/clientSession.js';
import { registerMobileApiV1 } from './vs-core/mobileApiV1.js';
import { MobileAuthService } from './vs-core/mobileAuth.js';
import { pool as dbPool } from './db/pool.js';
import { verifyAccessCode } from './security/accessCode.js';
import { probe } from './vs-core/readiness.js';
import { registerAdminAgentRoutes } from './vs-core/adminAgent.js';
import { registerCanonicalV1Routes } from './routes/canonicalV1.js';
import { registerLiveControlRoutes } from './routes/liveControl.js';
import {
  probeStrategyRuntime,
  probeRiskRuntime,
  probeExecutionRuntime,
} from './vs-core/runtimeHealth.js';
import { resolveManagementBind } from './vs-core/network/networkBind.js';
import { registerPrivateNetworkRoutes } from './vs-core/network/networkApi.js';

const PORT = parseInt(process.env.CONTROL_API_PORT || '3000', 10);
// Production default is localhost / VS private IP — never silent 0.0.0.0
const HOST = (() => {
  try {
    return resolveManagementBind(process.env).host;
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
})();

function corsOrigins(): boolean | string | string[] {
  const raw = [process.env.CORS_ORIGIN, process.env.CLIENT_CORS_ORIGIN]
    .filter(Boolean)
    .join(',');
  // Native VS Admin.exe does not use browser CORS. CLIENT traffic is :443 gateway.
  const lanTrust = ['1', 'true', 'yes'].includes(
    String(process.env.VS_LAN_TRUST_ADMIN || '').trim().toLowerCase()
  );
  if (lanTrust && !raw) return true;
  if (!raw) return [];
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes('*')) return true;
  return list.length === 1 ? list[0]! : list;
}

function trustProxyOption(): boolean | string | string[] | number {
  const raw = (process.env.TRUST_PROXY || '').trim();
  if (!raw || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  // FAIL CLOSED: LIVE never defaults on
  if (process.env.LIVE_TRADING_ENABLED === undefined || process.env.LIVE_TRADING_ENABLED === '') {
    process.env.LIVE_TRADING_ENABLED = 'false';
  }
  if (process.env.OPERATING_MODE === undefined || process.env.OPERATING_MODE === '') {
    process.env.OPERATING_MODE = 'PAPER';
  }

  // B6: refuse missing/default encryption key for ALL modes (broker secrets)
  const { isUnsafeMasterEncryptionKey } = await import('./security/encryption.js');
  if (isUnsafeMasterEncryptionKey(process.env.MASTER_ENCRYPTION_KEY)) {
    throw new Error(
      'BOOT_FAIL: MASTER_ENCRYPTION_KEY missing or unsafe (CHANGE_ME/default/short) — refuse start'
    );
  }

  if (process.env.LIVE_TRADING_ENABLED === 'true') {
    const badSecrets = [
      !process.env.MASTER_ENCRYPTION_KEY || process.env.MASTER_ENCRYPTION_KEY.includes('CHANGE_ME'),
      !process.env.DB_PASSWORD || process.env.DB_PASSWORD === 'CHANGE_ME',
      !process.env.API_ADMIN_TOKEN || process.env.API_ADMIN_TOKEN === 'CHANGE_ME_ADMIN_TOKEN',
    ].some(Boolean);
    if (badSecrets) {
      throw new Error(
        'LIVE_STARTUP_FAIL: default/CHANGE_ME secrets present — refuse LIVE start'
      );
    }
  }

  await runMigrations();

  // B5: durable money-path recovery BEFORE trading routes accept opens
  const { runBootMoneyPathRecovery, moneyPathStatusPayload } = await import(
    './vs-core/bootMoneyPathRecovery.js'
  );
  const { markServiceRunning } = await import('./vs-core/moneyPathGate.js');
  markServiceRunning();
  const recovery = runBootMoneyPathRecovery();
  if (!recovery.ok) {
    console.error(
      `MONEY_PATH_RECOVERY_BLOCKED code=${recovery.reason_code} · ${recovery.detail} · entries disabled`
    );
  } else {
    console.log(`MONEY_PATH_RECOVERY_OK · ${recovery.detail}`);
  }

  const app = Fastify({
    logger: true,
    trustProxy: trustProxyOption(),
    connectionTimeout: 0,
    requestTimeout: 0,
    keepAliveTimeout: 650_000,
  });
  const telemetry = new TelemetryBroadcaster();
  const clientEvents = new ClientEventHub();
  setClientEventHub(clientEvents);

  await app.register(cors, {
    origin: corsOrigins(),
    credentials: true,
  });

  await app.register(websocket);

  app.addHook('onRequest', authMiddleware);

  // Distinguish service-up vs money-path-ready
  app.get('/api/system/money-path', async () => moneyPathStatusPayload());

  await registerSystemRoutes(app, telemetry);
  await registerClientRoutes(app);
  await registerBrokerRoutes(app);
  await registerAccountRoutes(app);
  await registerTradeRoutes(app);
  await registerMarketRoutes(app, telemetry);
  await registerMarketIntelligenceRoutes(app);
  await registerTradingRoutes(app);
  await registerRobotReaderRoutes(app);
  await registerRobotDeskRoutes(app);
  await registerClientAuthRoutes(app);
  await registerClientPanelRoutes(app);
  await registerPipelineRoutes(app);
  await registerAuditRoutes(app);
  await registerSettingsRoutes(app);
  await registerClientPanelStatic(app);

  // Mobile Control API v1 — own Bearer auth; Capital credentials never returned.
  const mobileAuth = new MobileAuthService(async (clientId, password) => {
    const { rows } = await dbPool.query(
      `SELECT access_code_hash FROM clients WHERE id = $1 AND access_enabled = true LIMIT 1`,
      [clientId]
    );
    if (!rows.length) return false;
    return verifyAccessCode(password, rows[0].access_code_hash as string);
  });
  const getProbes = async () => [
    probe('NETWORK', 'OK', 'control-api up'),
    probe('TIME', 'OK', 'local'),
    probe('STORAGE', 'OK', 'ok'),
    probe('DATABASE', (await healthCheck()) ? 'OK' : 'ERROR', 'pg'),
    probe('MARKET', 'WARNING', 'probe via robotDesk runtime', 'MARKET_RUNTIME'),
    probe('CAPITAL', 'ERROR', 'Capital session not verified at API boot', 'CAPITAL_UNVERIFIED'),
    probeStrategyRuntime(),
    probeRiskRuntime(),
    probeExecutionRuntime(false),
    probe('RECONCILIATION', 'WARNING', 'in-cycle reconcile', 'RECONCILE_RUNTIME'),
    probe('CONTROL_API', 'OK', 'listening'),
  ];

  await registerMobileApiV1(app, {
    auth: mobileAuth,
    isAdmin: () => false,
    getProbes,
  });

  // Admin Agent API + canonical /api/v1 read surfaces for MSI ADMIN.
  await registerAdminAgentRoutes(app, { getProbes });
  await registerCanonicalV1Routes(app, { getProbes });

  // Admin live-control API (GET/POST /api/admin/live-control)
  await registerLiveControlRoutes(app);

  // VS Private Network device registry / heartbeat / registration
  await registerPrivateNetworkRoutes(app);

  app.get('/ws', { websocket: true }, (socket) => {
    telemetry.addClient(socket);
    socket.on('close', () => telemetry.removeClient(socket));
  });

  // Prefer HttpOnly cookie. Optional first-message auth — never put token in URL.
  app.get('/ws/client', { websocket: true }, async (socket, request) => {
    const tryAuth = async (token: string | null) => {
      const session = await resolveClientSession(token);
      if (!session || !session.client_enabled || !session.access_enabled) return null;
      return session;
    };

    let session = await tryAuth(extractClientToken(request));
    if (!session) {
      const authed = await new Promise<Awaited<ReturnType<typeof tryAuth>>>((resolve) => {
        const timer = setTimeout(() => resolve(null), 3000);
        socket.once('message', async (raw) => {
          clearTimeout(timer);
          try {
            const msg = JSON.parse(String(raw)) as { type?: string; token?: string };
            if (msg.type === 'auth' && msg.token) {
              resolve(await tryAuth(msg.token));
              return;
            }
          } catch {
            /* ignore */
          }
          resolve(null);
        });
      });
      session = authed;
    }

    if (!session) {
      socket.send(
        JSON.stringify({
          type: 'error',
          message: 'Unauthorized client websocket',
          timestamp: new Date().toISOString(),
        })
      );
      socket.close();
      return;
    }

    const clientId = session.client_id;
    clientEvents.add(clientId, socket);
    socket.send(
      JSON.stringify({
        type: 'connection_status',
        client_id: clientId,
        status: 'ONLINE',
        timestamp: new Date().toISOString(),
      })
    );
    socket.on('close', () => clientEvents.remove(clientId, socket));
  });

  app.addHook('onClose', async () => {
    await pool.end();
  });

  await app.listen({ port: PORT, host: HOST });
  console.log(`Control API listening on ${HOST}:${PORT}`);

  setInterval(() => {
    telemetry.broadcast({
      type: 'heartbeat',
      timestamp: new Date().toISOString(),
      db: healthCheck(),
    });
  }, 5000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
