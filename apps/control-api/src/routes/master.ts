/** VS MASTER dashboard + control API. LIVE off by default for master mode. */
import type { FastifyInstance } from 'fastify';
import { Mt4FileBroker } from '../master/broker.js';
import { masterRuntime } from '../master/runtime.js';
import { replayMaster, walkForward, abCompareAi } from '../master/replay.js';
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

  app.post<{ Body: { mode?: Mode; kill_switch?: boolean; epic?: string; ai_mode?: 'off' | 'advisory' | 'required' } }>(
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
      if (body.ai_mode) {
        masterRuntime.cfg = { ...masterRuntime.cfg, ai_mode: body.ai_mode };
      }
      return { ok: true, status: masterRuntime.status() };
    }
  );

  app.post('/api/master/start', async () => {
    if (masterRuntime.cfg.mode === 'LIVE' && process.env.MASTER_LIVE_ENABLED !== 'true') {
      return { ok: false, detail: 'LIVE blocked — MASTER_LIVE_ENABLED not set' };
    }
    const { resolveBrokerFromEnv } = await import('../master/envBroker.js');
    const resolved = await resolveBrokerFromEnv();
    if (resolved.mode === 'LIVE' && process.env.MASTER_LIVE_ENABLED !== 'true') {
      return { ok: false, detail: 'LIVE broker resolved but MASTER_LIVE_ENABLED not set' };
    }
    masterRuntime.attachBroker(resolved.broker);
    masterRuntime.broker_detail = resolved.detail;
    if (resolved.mode === 'LIVE') masterRuntime.setMode('LIVE');
    else if (masterRuntime.cfg.mode !== 'LIVE') masterRuntime.setMode('PAPER');
    const live_feed =
      resolved.broker.paper && (process.env.MASTER_LIVE_FEED || 'public') !== 'off';
    await masterRuntime.start({ broker: resolved.broker, live_feed });
    return {
      ok: true,
      broker: resolved.broker.name,
      detail: resolved.detail,
      live_feed,
      status: masterRuntime.status(),
    };
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
    const result = await masterRuntime.evaluate(bars, quote);
    return {
      ok: true,
      decision: result.decision,
      risk: result.risk,
      analysis: result.analysis,
      ai: result.ai,
      status: masterRuntime.status(),
      why:
        result.decision.block_reason ||
        result.risk.reasons.join(', ') ||
        (result.decision.kind === 'WAIT' ? 'WAIT — no valid edge' : `TRADE ${result.decision.kind}`),
    };
  });

  /** Credential-free Capital connectivity probe — fails closed honestly without secrets. */
  app.post('/api/master/broker/capital/probe', async () => {
    const { openCapitalSession } = await import('../services/capitalCom.js');
    const { capitalEnvPresent } = await import('../master/envBroker.js');
    if (!capitalEnvPresent()) {
      return {
        ok: false,
        status: 'NO_CREDENTIALS',
        detail:
          'CAPITAL_API_KEY / CAPITAL_IDENTIFIER / CAPITAL_API_PASSWORD not set — cannot open live Capital session',
      };
    }
    const opened = await openCapitalSession({
      environment: (process.env.CAPITAL_ENVIRONMENT || 'demo').trim(),
      apiKey: (process.env.CAPITAL_API_KEY || '').trim(),
      identifier: (process.env.CAPITAL_IDENTIFIER || '').trim(),
      password: (
        process.env.CAPITAL_API_PASSWORD ||
        process.env.CAPITAL_PASSWORD ||
        ''
      ).trim(),
      capitalAccountId: process.env.CAPITAL_ACCOUNT_ID || null,
    });
    return {
      ok: opened.ok,
      status: opened.ok ? 'CONNECTED' : 'CONNECT_FAILED',
      detail: opened.detail,
      environment: process.env.CAPITAL_ENVIRONMENT || 'demo',
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
    const result = await replayMaster({
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
    const wf = await walkForward({
      bars,
      train: req.body?.train ?? 60,
      test: req.body?.test ?? 30,
      step: req.body?.step ?? 40,
    });
    return { ok: true, windows: wf.windows };
  });

  app.post<{
    Body: { bars: Bar[]; spread?: number; slippage_pts?: number; commission?: number };
  }>('/api/master/ab-ai', async (req) => {
    const bars = req.body?.bars || [];
    if (bars.length < 40) return { ok: false, detail: 'need ≥40 bars' };
    const ab = await abCompareAi({
      bars,
      spread: req.body?.spread,
      slippage_pts: req.body?.slippage_pts,
      commission: req.body?.commission,
    });
    return {
      ok: true,
      delta_expectancy: ab.delta_expectancy,
      note: ab.note,
      off: {
        trades: ab.off.performance.trades,
        expectancy: ab.off.performance.expectancy,
        total_pnl: ab.off.performance.total_pnl,
      },
      on: {
        trades: ab.on.performance.trades,
        expectancy: ab.on.performance.expectancy,
        total_pnl: ab.on.performance.total_pnl,
      },
    };
  });

  app.get('/api/master/journal', async () => ({
    opportunities: masterRuntime.pipeline.journal.opportunities.slice(-200),
    expectancy: masterRuntime.pipeline.expectancy.all(),
    open_positions: masterRuntime.positions.list(),
  }));

  // Live dashboard — polls status; start/stop controls; shows why trading / not
  app.get('/master', async (_req, reply) => {
    const html = `<!doctype html>
<html><head><meta charset="utf-8"/><title>VS MASTER</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
:root{--bg:#0b0f14;--card:#141b24;--line:#243041;--txt:#d7e0ea;--muted:#7a8794;--ok:#7dffa3;--bad:#ff7d7d;--accent:#5ec8ff}
*{box-sizing:border-box}body{font-family:ui-monospace,Menlo,Consolas,monospace;background:radial-gradient(1200px 600px at 10% -10%,#132033 0%,var(--bg) 55%);color:var(--txt);margin:0;padding:24px;min-height:100vh}
h1{color:var(--ok);margin:0 0 4px;font-size:28px;letter-spacing:.04em}
.muted{color:var(--muted);margin:0 0 16px}
.row{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 4px}
button{background:#1a2433;color:var(--txt);border:1px solid var(--line);padding:8px 14px;border-radius:6px;cursor:pointer;font:inherit}
button:hover{border-color:var(--accent);color:var(--accent)}
button.primary{background:#163528;border-color:#2a5a45;color:var(--ok)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
.k{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.v{font-size:17px;margin-top:6px;word-break:break-word}
.bad{color:var(--bad)}.ok{color:var(--ok)}
h2{font-size:13px;color:#9fb0c0;margin:22px 0 8px;text-transform:uppercase;letter-spacing:.08em}
#log{background:#0a1018;border:1px solid var(--line);border-radius:8px;padding:12px;max-height:180px;overflow:auto;font-size:12px;color:#9fb0c0;white-space:pre-wrap}
</style></head><body>
<h1>VS MASTER</h1>
<p class="muted">Single authoritative pipeline · scores are heuristic — not probability · LIVE gated unless MASTER_LIVE_ENABLED</p>
<div class="row">
  <button class="primary" id="btnStart">Start PAPER</button>
  <button id="btnStop">Stop</button>
  <button id="btnRecover">Recover</button>
  <button id="btnKill">Kill switch</button>
  <button id="btnAi">AI advisory toggle</button>
</div>
<div class="grid" id="cards"></div>
<h2>Open positions</h2>
<div class="grid" id="positions"></div>
<h2>Journal (recent traded)</h2>
<div class="grid" id="journal"></div>
<h2>Activity</h2>
<div id="log"></div>
<script>
const cards=document.getElementById('cards');
const positions=document.getElementById('positions');
const journal=document.getElementById('journal');
const logEl=document.getElementById('log');
let kill=false, ai='off';
function card(k,v,cls){return '<div class="card"><div class="k">'+k+'</div><div class="v '+(cls||'')+'">'+v+'</div></div>'}
function pushLog(msg){const t=new Date().toISOString().slice(11,19);logEl.textContent='['+t+'] '+msg+'\\n'+logEl.textContent.slice(0,4000)}
async function refresh(){
  try{
    const s=await fetch('/api/master/status').then(r=>r.json());
    kill=!!s.kill_switch;
    const why=s.last_block_reason||s.last_execution_detail||s.last_decision?.kind||'—';
    const whyCls=s.last_block_reason?'bad':'ok';
    cards.innerHTML=[
      card('Mode',s.mode),
      card('Epic',s.epic||'—'),
      card('Health',s.health,s.health.includes('KILL')?'bad':'ok'),
      card('Broker',s.broker||'—'),
      card('Broker detail',s.broker_detail||'—'),
      card('Owns pipeline',s.owns_pipeline?'YES':'no'),
      card('AI mode',s.ai_mode||'—'),
      card('Running',s.running?'YES':'NO',s.running?'ok':''),
      card('Regime',s.regime),
      card('BUY',Number(s.buy_score||0).toFixed(3)),
      card('SELL',Number(s.sell_score||0).toFixed(3)),
      card('Decision',s.last_decision?.kind||'—'),
      card('Why',why,whyCls),
      card('Last exit',s.last_exit_reason||'—'),
      card('Equity',s.account?.equity!=null?Number(s.account.equity).toFixed(2):'—'),
      card('Daily PnL',s.account?.daily_pnl!=null?Number(s.account.daily_pnl).toFixed(2):'—'),
      card('Open',s.open_positions),
      card('Trades',s.traded),
      card('Blocked',s.blocked),
      card('Expectancy',Number(s.performance?.expectancy||0).toFixed(3)),
      card('Max DD',Number(s.performance?.max_drawdown||0).toFixed(2)),
      card('Recovered',s.recovered?'YES':'—'),
    ].join('');
    const pos=await fetch('/api/master/positions').then(r=>r.json());
    const list=pos.positions||[];
    positions.innerHTML=list.length?list.map(p=>card(p.side+' '+p.epic, Number(p.entry).toFixed(2)+' · sz '+p.size+' · MFE '+Number(p.mfe).toFixed(2))).join('')
      :card('Open','FLAT');
    const j=await fetch('/api/master/journal').then(r=>r.json());
    const traded=(j.opportunities||[]).filter(o=>o.executed&&o.outcome).slice(-8).reverse();
    journal.innerHTML=traded.length?traded.map(o=>{
      const pn=Number(o.outcome.pnl);
      return card(o.decision?.kind+' '+o.epic, pn.toFixed(2)+' · '+String(o.outcome.exit_reason||'').slice(0,40), pn>=0?'ok':'bad');
    }).join(''):card('Journal','no closed trades yet');
  }catch(e){pushLog('status error '+e)}
}
document.getElementById('btnStart').onclick=async()=>{await fetch('/api/master/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'PAPER'})});const r=await fetch('/api/master/start',{method:'POST'}).then(r=>r.json());pushLog('start '+JSON.stringify(r.ok));refresh()};
document.getElementById('btnStop').onclick=async()=>{const r=await fetch('/api/master/stop',{method:'POST'}).then(r=>r.json());pushLog('stop');refresh()};
document.getElementById('btnRecover').onclick=async()=>{const r=await fetch('/api/master/recover',{method:'POST'}).then(r=>r.json());pushLog('recover positions='+r.positions+' journal='+r.opportunities);refresh()};
document.getElementById('btnKill').onclick=async()=>{kill=!kill;await fetch('/api/master/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kill_switch:kill})});pushLog('kill_switch='+kill);refresh()};
document.getElementById('btnAi').onclick=async()=>{ai=ai==='off'?'advisory':'off';await fetch('/api/master/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ai_mode:ai})});pushLog('ai_mode='+ai);refresh()};
refresh();setInterval(refresh,2000);
</script>
</body></html>`;
    return reply.type('text/html').send(html);
  });
}
