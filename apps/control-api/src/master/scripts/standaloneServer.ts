/**
 * Standalone VS MASTER HTTP server — no Postgres required.
 * PAPER by default; LIVE if MASTER_LIVE_ENABLED + CAPITAL_* env present.
 *
 *   npx tsx src/master/scripts/standaloneServer.ts
 *   open http://127.0.0.1:3040/master
 */
import 'dotenv/config';
import Fastify from 'fastify';
import { registerMasterRoutes } from '../../routes/master.js';
import { masterRuntime } from '../runtime.js';
import { DEFAULT_MASTER_CONFIG } from '../pipeline.js';
import { installFilePersist } from '../filePersist.js';
import { resolveBrokerFromEnv } from '../envBroker.js';
import type { Bar } from '../types.js';

const PORT = parseInt(process.env.MASTER_STANDALONE_PORT || '3040', 10);
const HOST = process.env.MASTER_STANDALONE_HOST || '127.0.0.1';

function synthBars(n: number, start = 4400, drift = 0.6): Bar[] {
  const out: Bar[] = [];
  let px = start;
  const t0 = Date.now() - n * 60_000;
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = o + drift + Math.sin(i / 3) * 0.15;
    out.push({
      open: o,
      high: Math.max(o, c) + 0.4,
      low: Math.min(o, c) - 0.2,
      close: c,
      ts_ms: t0 + i * 60_000,
    });
    px = c;
  }
  return out;
}

async function main() {
  process.env.MASTER_STANDALONE = 'true';
  const stateDir = process.env.MASTER_STATE_DIR || '/tmp/vs-master-state';
  installFilePersist(stateDir);

  const resolved = await resolveBrokerFromEnv();
  masterRuntime.cfg = {
    ...DEFAULT_MASTER_CONFIG,
    mode: resolved.mode,
    min_score: 0.4,
    ai_mode: (process.env.MASTER_AI_MODE as any) || 'advisory',
  };
  masterRuntime.attachBroker(resolved.broker);
  masterRuntime.broker_detail = resolved.detail;

  const useLive =
    resolved.mode === 'PAPER' &&
    resolved.broker.paper &&
    (process.env.MASTER_LIVE_FEED || 'public') !== 'synthetic' &&
    (process.env.MASTER_LIVE_FEED || 'public') !== 'off';

  await masterRuntime.start({ broker: resolved.broker, live_feed: useLive });

  const app = Fastify({ logger: false });
  await registerMasterRoutes(app);
  app.get('/health', async () => ({
    ok: true,
    master: true,
    standalone: true,
    state_dir: stateDir,
    broker: resolved.broker.name,
    detail: resolved.detail,
    mode: resolved.mode,
    live_feed: useLive,
  }));

  // Synthetic-only PAPER loop when live feed disabled
  if (resolved.mode === 'PAPER' && resolved.broker.paper && !useLive) {
    let bars = synthBars(40, 4400, 0.7);
    let tickN = 0;
    setInterval(() => {
      tickN += 1;
      const last = bars.at(-1)!;
      const drift = tickN < 25 ? 0.55 : -2.2;
      const o = last.close;
      const c = o + drift;
      bars = [
        ...bars.slice(-50),
        {
          open: o,
          high: Math.max(o, c) + 0.35,
          low: Math.min(o, c) - 0.25,
          close: c,
          ts_ms: Date.now(),
        },
      ];
      const mid = c;
      void masterRuntime.tick(bars, {
        bid: mid - 0.2,
        ask: mid + 0.2,
        mid,
        spread: 0.4,
        ts_ms: Date.now(),
      });
    }, 1500);
  }

  await app.listen({ port: PORT, host: HOST });
  console.log(`VS MASTER standalone on http://${HOST}:${PORT}/master`);
  console.log(
    `broker=${resolved.broker.name} mode=${resolved.mode} live_feed=${useLive} ${resolved.detail}`
  );
  console.log(`state dir: ${stateDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
