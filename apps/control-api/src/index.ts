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
import { TelemetryBroadcaster } from './ws/telemetry.js';
import { authMiddleware } from './middleware/auth.js';

const PORT = parseInt(process.env.CONTROL_API_PORT || '3000', 10);
const HOST = process.env.CONTROL_API_HOST || '0.0.0.0';

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

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
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
  await registerAuditRoutes(app);
  await registerSettingsRoutes(app);

  app.get('/ws', { websocket: true }, (socket) => {
    telemetry.addClient(socket);
    socket.on('close', () => telemetry.removeClient(socket));
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
