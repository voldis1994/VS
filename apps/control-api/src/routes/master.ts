/** VS MASTER dashboard + control API. LIVE off by default for master mode. */
import type { FastifyInstance } from 'fastify';
import { masterRuntime } from '../master/runtime.js';
import { replayMaster, walkForward } from '../master/replay.js';
import { DEFAULT_MASTER_CONFIG } from '../master/pipeline.js';
import type { Bar, Mode } from '../master/types.js';

export async function registerMasterRoutes(app: FastifyInstance) {
  app.get('/api/master/status', async () => masterRuntime.status());

  app.get('/api/master/config', async () => ({
    ...masterRuntime.cfg,
    note: 'Scores are heuristic 0..1 — not calibrated trade probabilities. LIVE requires explicit setMode(LIVE).',
  }));

  app.post<{ Body: { mode?: Mode; kill_switch?: boolean } }>('/api/master/control', async (req) => {
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
    return { ok: true, status: masterRuntime.status() };
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
  }));

  // Minimal HTML dashboard — why trading / not trading
  app.get('/master', async (_req, reply) => {
    const s = masterRuntime.status();
    const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>VS MASTER</title>
<style>
body{font-family:ui-monospace,Menlo,Consolas,monospace;background:#0b0f14;color:#d7e0ea;margin:0;padding:24px}
h1{color:#7dffa3;margin:0 0 8px} .muted{color:#7a8794}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0}
.card{background:#141b24;border:1px solid #243041;border-radius:8px;padding:12px}
.k{font-size:11px;color:#7a8794;text-transform:uppercase}.v{font-size:20px;margin-top:4px}
.bad{color:#ff7d7d}.ok{color:#7dffa3}
</style></head><body>
<h1>VS MASTER</h1>
<p class="muted">Single runtime · heuristic scores ≠ probability · LIVE off unless MASTER_LIVE_ENABLED=true</p>
<div class="grid">
<div class="card"><div class="k">Mode</div><div class="v">${s.mode}</div></div>
<div class="card"><div class="k">Health</div><div class="v">${s.health}</div></div>
<div class="card"><div class="k">Regime</div><div class="v">${s.regime}</div></div>
<div class="card"><div class="k">BUY score</div><div class="v">${s.buy_score.toFixed(3)}</div></div>
<div class="card"><div class="k">SELL score</div><div class="v">${s.sell_score.toFixed(3)}</div></div>
<div class="card"><div class="k">Decision</div><div class="v">${s.last_decision?.kind ?? '—'}</div></div>
<div class="card"><div class="k">Why</div><div class="v ${s.last_block_reason ? 'bad' : 'ok'}">${s.last_block_reason || s.last_decision?.kind || '—'}</div></div>
<div class="card"><div class="k">Equity</div><div class="v">${s.account?.equity?.toFixed?.(2) ?? '—'}</div></div>
<div class="card"><div class="k">Trades</div><div class="v">${s.traded}</div></div>
<div class="card"><div class="k">Blocked opps</div><div class="v">${s.blocked}</div></div>
<div class="card"><div class="k">Expectancy</div><div class="v">${s.performance.expectancy.toFixed(3)}</div></div>
<div class="card"><div class="k">Max DD</div><div class="v">${s.performance.max_drawdown.toFixed(2)}</div></div>
</div>
<p class="muted">API: GET /api/master/status · POST /api/master/evaluate · POST /api/master/replay · POST /api/master/walk-forward</p>
<script>setTimeout(()=>location.reload(),5000)</script>
</body></html>`;
    return reply.type('text/html').send(html);
  });
}
