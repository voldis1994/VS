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
import { registerAuditRoutes } from './routes/audit.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTradingRoutes } from './routes/trading.js';
import { registerRobotReaderRoutes } from './routes/robotReader.js';
import { registerRobotDeskRoutes } from './routes/robotDesk.js';
import { registerClientAuthRoutes } from './routes/clientAuth.js';
import { registerClientPanelRoutes } from './routes/clientPanel.js';
import { TelemetryBroadcaster } from './ws/telemetry.js';
import { ClientEventHub, setClientEventHub } from './services/clientEvents.js';
import { authMiddleware } from './middleware/auth.js';
import {
  extractClientToken,
  resolveClientSession,
} from './security/clientSession.js';

const PORT = parseInt(process.env.CONTROL_API_PORT || '3000', 10);
const HOST = process.env.CONTROL_API_HOST || '0.0.0.0';

function corsOrigins(): boolean | string | string[] {
  const raw = [process.env.CORS_ORIGIN, process.env.CLIENT_CORS_ORIGIN]
    .filter(Boolean)
    .join(',');
  if (!raw) return 'http://localhost:5173';
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes('*')) return true;
  return list.length === 1 ? list[0]! : list;
}

async function main() {
  // Operator risk accepted — LIVE ready unless explicitly set false
  if (process.env.LIVE_TRADING_ENABLED === undefined || process.env.LIVE_TRADING_ENABLED === '') {
    process.env.LIVE_TRADING_ENABLED = 'true';
  }
  if (process.env.OPERATING_MODE === undefined || process.env.OPERATING_MODE === '') {
    process.env.OPERATING_MODE = 'LIVE';
  }

  await runMigrations();

  const app = Fastify({
    logger: true,
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

  await registerSystemRoutes(app, telemetry);
  await registerClientRoutes(app);
  await registerBrokerRoutes(app);
  await registerAccountRoutes(app);
  await registerTradeRoutes(app);
  await registerMarketRoutes(app, telemetry);
  await registerTradingRoutes(app);
  await registerRobotReaderRoutes(app);
  await registerRobotDeskRoutes(app);
  await registerClientAuthRoutes(app);
  await registerClientPanelRoutes(app);
  await registerAuditRoutes(app);
  await registerSettingsRoutes(app);

  app.get('/ws', { websocket: true }, (socket) => {
    telemetry.addClient(socket);
    socket.on('close', () => telemetry.removeClient(socket));
  });

  app.get('/ws/client', { websocket: true }, async (socket, request) => {
    const q = request.query as { token?: string };
    const token =
      (typeof q.token === 'string' && q.token) || extractClientToken(request) || null;
    const session = await resolveClientSession(token);
    if (!session || !session.client_enabled || !session.access_enabled) {
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
