/** VS MASTER dashboard + control API. LIVE off by default for master mode. */
import type { FastifyInstance } from 'fastify';
import { Mt4FileBroker } from '../master/broker.js';
import { masterRuntime } from '../master/runtime.js';
import { replayMaster, walkForward } from '../master/replay.js';
import { DEFAULT_MASTER_CONFIG } from '../master/pipeline.js';
import type { Bar, Mode } from '../master/types.js';

export async function registerMasterRoutes(app: FastifyInstance) {
  app.get('/api/master/status', async () => masterRuntime.status());

  app.get('/api/master/config', async () => ({
    ...masterRuntime.cfg,
    note: 'Scores are heuristic 0..1 — not calibrated trade probabilities. LIVE requires MASTER_LIVE_ENABLED=true.',
    owns_pipeline: process.env.MASTER_OWNS_PIPELINE === 'true',
    live_enabled: process.env.MASTER_LIVE_ENABLED === 'true',
  }));

  app.get('/api/master/positions', async () => ({
    positions: masterRuntime.positions.list(),
  }));

  app.post<{ Body: { mode?: Mode; kill_switch?: boolean; epic?: string } }>(
    '/api/master/control',
    async (req) => {
      const body = req.body || {};
      if (body.mode) {
        if (body.mode === 'LIVE' && process.env.MASTER_LIVE_ENABLED !== 'true') {
          return {
            ok: false,
            detail:
              'LIVE blocked — set MASTER_LIVE_ENABLED=true explicitly. Safe default is PAPER/BACKTEST.',
          };
        }
        masterRuntime.setMode(body.mode);
      }
      if (typeof body.kill_switch === 'boolean') {
        masterRuntime.setKillSwitch(body.kill_switch);
      }
      if (body.epic) masterRuntime.setEpic(body.epic);
      return { ok: true, status: masterRuntime.status() };
    }
  );

  app.post('/api/master/start', async () => {
    if (masterRuntime.cfg.mode === 'LIVE' && process.env.MASTER_LIVE_ENABLED !== 'true') {
      return { ok: false, detail: 'LIVE blocked — MASTER_LIVE_ENABLED not set' };
    }
    if (!masterRuntime.broker) masterRuntime.ensurePaperBroker();
    await masterRuntime.start();
    return { ok: true, status: masterRuntime.status() };
  });

  app.post('/api/master/stop', async () => {
    masterRuntime.stop();
    return { ok: true, status: masterRuntime.status() };
  });

  app.post('/api/master/recover', async () => {
    const r = await masterRuntime.recover();
    return { ok: true, ...r, status: masterRuntime.status() };
  });

  app.post<{
    Body: {
      bars: Bar[];
      bid?: number;
      ask?: number;
      mid?: number;
      spread?: number;
    };
  }>('/api/master/tick', async (req) => {
    const bars = req.body?.bars || [];
    if (bars.length < 5) return { ok: false, detail: 'need ≥5 bars' };
    const last = bars[bars.length - 1]!;
    const spread = req.body?.spread ?? 0.4;
    const mid = req.body?.mid ?? last.close;
    const quote = {
      bid: req.body?.bid ?? mid - spread / 2,
      ask: req.body?.ask ?? mid + spread / 2,
      mid,
      spread,
      ts_ms: Date.now(),
    };
    if (!masterRuntime.running) await masterRuntime.start();
    const result = await masterRuntime.tick(bars, quote);
    return {
      ok: true,
      ...result,
      status: masterRuntime.status(),
      why:
        result.execution_detail ||
        result.decision.block_reason ||
        result.risk.reasons.join(', ') ||
        (result.decision.kind === 'WAIT' ? 'WAIT — no valid edge' : `TRADE ${result.decision.kind}`),
    };
  });

  app.post<{
    Body: {
      bars: Bar[];
      bid?: number;
      ask?: number;
      mid?: number;
      spread?: number;
    };
  }>('/api/master/evaluate', async (req) => {
    const bars = req.body?.bars || [];
    if (bars.length < 5) return { ok: false, detail: 'need ≥5 bars' };
    const last = bars[bars.length - 1]!;
    const spread = req.body?.spread ?? 0.4;
    const mid = req.body?.mid ?? last.close;
    const quote = {
      bid: req.body?.bid ?? mid - spread / 2,
      ask: req.body?.ask ?? mid + spread / 2,
      mid,
      spread,
      ts_ms: Date.now(),
    };
    const result = masterRuntime.evaluate(bars, quote);
    return {
      ok: true,
      decision: result.decision,
      risk: result.risk,
      analysis: result.analysis,
      status: masterRuntime.status(),
      why:
        result.decision.block_reason ||
        result.risk.reasons.join(', ') ||
        (result.decision.kind === 'WAIT' ? 'WAIT — no valid edge' : `TRADE ${result.decision.kind}`),
    };
  });

  app.post<{ Body: { bridge_root?: string } }>('/api/master/broker/mt4', async (req) => {
    const root =
      req.body?.bridge_root ||
      process.env.MASTER_MT4_BRIDGE ||
      '/tmp/vs-master-mt4-bridge';
    const broker = new Mt4FileBroker(root);
    const connected = await broker.connect();
    if (!connected.ok) return { ok: false, detail: connected.detail };
    masterRuntime.attachBroker(broker);
    return { ok: true, broker: broker.name, root, detail: connected.detail };
  });

  app.post<{
    Body: {
      bars: Bar[];
      spread?: number;
      slippage_pts?: number;
      commission?: number;
    };
  }>('/api/master/replay', async (req) => {
    const bars = req.body?.bars || [];
    if (bars.length < 40) return { ok: false, detail: 'need ≥40 bars for replay' };
    const result = replayMaster({
      bars,
      spread: req.body?.spread,
      slippage_pts: req.body?.slippage_pts,
      commission: req.body?.commission,
      cfg: { ...DEFAULT_MASTER_CONFIG, mode: 'BACKTEST' },
    });
    return {
      ok: true,
      performance: result.performance,
      monte_carlo: result.monte_carlo,
      opportunities: result.opportunities.length,
      traded: result.opportunities.filter((o) => o.executed).length,
      blocked: result.opportunities.filter((o) => !o.executed).length,
      equity_end: result.equity_curve.at(-1),
    };
  });

  app.post<{
    Body: { bars: Bar[]; train?: number; test?: number; step?: number };
  }>('/api/master/walk-forward', async (req) => {
    const bars = req.body?.bars || [];
    if (bars.length < 120) return { ok: false, detail: 'need ≥120 bars' };
    const wf = walkForward({
      bars,
      train: req.body?.train ?? 60,
      test: req.body?.test ?? 30,
      step: req.body?.step ?? 40,
    });
    return { ok: true, windows: wf.windows };
  });

  app.get('/api/master/journal', async () => ({
    opportunities: masterRuntime.pipeline.journal.opportunities.slice(-200),
    expectancy: masterRuntime.pipeline.expectancy.all(),
    open_positions: masterRuntime.positions.list(),
  }));

  // Dashboard — why trading / not trading + open risk
  app.get('/master', async (_req, reply) => {
    const s = masterRuntime.status();
    const positions = masterRuntime.positions.list();
    const posHtml = positions.length
      ? positions
          .map(
            (p) =>
              `<div class="card"><div class="k">${p.side} ${p.epic}</div><div class="v">${p.entry.toFixed(2)} · sz ${p.size} · MFE ${p.mfe.toFixed(2)}</div></div>`
          )
          .join('')
      : `<div class="card"><div class="k">Open</div><div class="v">FLAT</div></div>`;
    const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>VS MASTER</title>
<meta http-equiv="refresh" content="5"/>
<style>
body{font-family:ui-monospace,Menlo,Consolas,monospace;background:#0b0f14;color:#d7e0ea;margin:0;padding:24px}
h1{color:#7dffa3;margin:0 0 8px} .muted{color:#7a8794}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0}
.card{background:#141b24;border:1px solid #243041;border-radius:8px;padding:12px}
.k{font-size:11px;color:#7a8794;text-transform:uppercase}.v{font-size:18px;margin-top:4px;word-break:break-word}
.bad{color:#ff7d7d}.ok{color:#7dffa3}
h2{font-size:14px;color:#9fb0c0;margin:24px 0 8px}
</style></head><body>
<h1>VS MASTER</h1>
<p class="muted">Authoritative pipeline · heuristic scores ≠ probability · LIVE=${process.env.MASTER_LIVE_ENABLED === 'true' ? 'armed' : 'gated'} · desk ownership=${process.env.MASTER_OWNS_PIPELINE === 'true' ? 'ON' : 'OFF'}</p>
<div class="grid">
<div class="card"><div class="k">Mode</div><div class="v">${s.mode}</div></div>
<div class="card"><div class="k">Health</div><div class="v">${s.health}</div></div>
<div class="card"><div class="k">Broker</div><div class="v">${s.broker || '—'}</div></div>
<div class="card"><div class="k">Running</div><div class="v">${s.running ? 'YES' : 'NO'}</div></div>
<div class="card"><div class="k">Regime</div><div class="v">${s.regime}</div></div>
<div class="card"><div class="k">BUY score</div><div class="v">${s.buy_score.toFixed(3)}</div></div>
<div class="card"><div class="k">SELL score</div><div class="v">${s.sell_score.toFixed(3)}</div></div>
<div class="card"><div class="k">Decision</div><div class="v">${s.last_decision?.kind ?? '—'}</div></div>
<div class="card"><div class="k">Why</div><div class="v ${s.last_block_reason ? 'bad' : 'ok'}">${s.last_block_reason || s.last_execution_detail || s.last_decision?.kind || '—'}</div></div>
<div class="card"><div class="k">Last exit</div><div class="v">${s.last_exit_reason || '—'}</div></div>
<div class="card"><div class="k">Equity</div><div class="v">${s.account?.equity?.toFixed?.(2) ?? '—'}</div></div>
<div class="card"><div class="k">Daily PnL</div><div class="v">${s.account?.daily_pnl?.toFixed?.(2) ?? '—'}</div></div>
<div class="card"><div class="k">Open pos</div><div class="v">${s.open_positions}</div></div>
<div class="card"><div class="k">Trades</div><div class="v">${s.traded}</div></div>
<div class="card"><div class="k">Blocked opps</div><div class="v">${s.blocked}</div></div>
<div class="card"><div class="k">Expectancy</div><div class="v">${s.performance.expectancy.toFixed(3)}</div></div>
<div class="card"><div class="k">Max DD</div><div class="v">${s.performance.max_drawdown.toFixed(2)}</div></div>
<div class="card"><div class="k">Recovered</div><div class="v">${s.recovered ? 'YES' : '—'}</div></div>
</div>
<h2>Open positions</h2>
<div class="grid">${posHtml}</div>
<p class="muted">API: /api/master/status · /tick · /start · /stop · /recover · /replay · /positions</p>
</body></html>`;
    return reply.type('text/html').send(html);
  });
}
