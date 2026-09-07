/**
 * Standalone VS MASTER HTTP server — no Postgres required.
 * Serves real dashboard + paper tick loop.
 *
 *   npx tsx src/master/scripts/standaloneServer.ts
 *   open http://127.0.0.1:3040/master
 */
import Fastify from 'fastify';
import { registerMasterRoutes } from '../../routes/master.js';
import { masterRuntime } from '../runtime.js';
import { DEFAULT_MASTER_CONFIG } from '../pipeline.js';
import type { Bar } from '../types.js';

const PORT = parseInt(process.env.MASTER_STANDALONE_PORT || '3040', 10);
const HOST = process.env.MASTER_STANDALONE_HOST || '127.0.0.1';

function synthBars(n: number, start = 4400, drift = 0.6): Bar[] {
  const out: Bar[] = [];
  let px = start;
  const t0 = Date.now() - n * 60_000;
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = o + drift + (Math.sin(i / 3) * 0.15);
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
  // Memory persist only — no DB
  process.env.MASTER_STANDALONE = 'true';
  masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'PAPER', min_score: 0.4, ai_mode: 'advisory' };
  masterRuntime.ensurePaperBroker();
  await masterRuntime.start();

  const app = Fastify({ logger: false });
  await registerMasterRoutes(app);

  app.get('/health', async () => ({ ok: true, master: true, standalone: true }));

  // Auto paper feed — proves live dashboard updates
  let bars = synthBars(40, 4400, 0.7);
  let tickN = 0;
  setInterval(() => {
    tickN += 1;
    const last = bars.at(-1)!;
    // After ~25 ticks, reverse into a dump so exits fire
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
    // Always tick so open positions can exit; execution gate honors running flag
    void masterRuntime.tick(bars, {
      bid: mid - 0.2,
      ask: mid + 0.2,
      mid,
      spread: 0.4,
      ts_ms: Date.now(),
    });
  }, 1500);

  await app.listen({ port: PORT, host: HOST });
  console.log(`VS MASTER standalone on http://${HOST}:${PORT}/master`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
