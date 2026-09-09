/** VS MASTER dashboard + control API. LIVE off by default for master mode. */
import type { FastifyInstance } from 'fastify';
import { CapitalBroker, Mt4FileBroker } from '../master/broker.js';
import { ensureMasterPersist } from '../master/dualPersist.js';
import { masterRuntime } from '../master/runtime.js';
import { replayMaster, walkForward, abCompareAi } from '../master/replay.js';
import { DEFAULT_MASTER_CONFIG } from '../master/pipeline.js';
import type { Bar, Mode } from '../master/types.js';

export async function registerMasterRoutes(app: FastifyInstance) {
  // Postgres + file mirror so recover survives DB blips (standalone uses file-only)
  ensureMasterPersist();
  masterRuntime.hydrateOwnsPipelinePref();
  masterRuntime.hydrateManageConfig();
  masterRuntime.hydrateRuntimeGatesFromDisk();
  masterRuntime.hydrateMonitorFromDisk();
  // Opens/journal KPIs — do not leave dashboard forged-empty until Recover
  await masterRuntime.hydrateBookFromDisk();
  // Crash resume: feed/entries when desired_running; always manage leftover opens
  await masterRuntime.resumeDesiredSession();

  app.get('/api/master/status', async () => masterRuntime.statusAsync());

  app.get('/api/master/config', async () => ({
    ...masterRuntime.cfg,
    note: 'Scores are heuristic 0..1 — not calibrated trade probabilities. Primary LIVE venue = Capital.com API. LIVE requires MASTER_LIVE_ENABLED=true + CAPITAL_* env or Brokers-page Capital credentials.',
    owns_pipeline: masterRuntime.ownsPipelineEffective(),
    live_enabled: process.env.MASTER_LIVE_ENABLED === 'true',
    manage: masterRuntime.status().manage,
  }));

  app.patch<{ Body: Record<string, unknown> }>('/api/master/config', async (req) => {
    const body = (req.body || {}) as Record<string, unknown>;
    masterRuntime.patchManageConfig(body as never);
    return {
      ok: true,
      manage: masterRuntime.status().manage,
      cfg: masterRuntime.cfg,
      status: masterRuntime.status(),
    };
  });

  app.post('/api/master/config/scalp-preset', async () => {
    const cfg = masterRuntime.armScalpManagePreset();
    return { ok: true, manage: masterRuntime.status().manage, cfg, status: masterRuntime.status() };
  });

  app.get('/api/master/positions', async () => ({
    positions: masterRuntime.positionsForApi(),
    floating_pnl: masterRuntime.status().floating_pnl,
  }));

  app.post<{ Params: { id: string } }>(
    '/api/master/positions/:id/close',
    async (req) => {
      const r = await masterRuntime.closePositionManual(
        req.params.id,
        'OPERATOR_CLOSE'
      );
      return { ...r, status: masterRuntime.status() };
    }
  );

  app.post('/api/master/flatten', async () => {
    const r = await masterRuntime.flattenAll('OPERATOR_FLATTEN');
    return { ...r, status: masterRuntime.status() };
  });

  app.post<{
    Body: {
      mode?: Mode;
      kill_switch?: boolean;
      epic?: string;
      ai_mode?: 'off' | 'advisory' | 'required';
      owns_pipeline?: boolean;
      entries_armed?: boolean;
      entries_pause_reason?: string;
    };
  }>('/api/master/control', async (req) => {
      const body = req.body || {};
      if (body.mode) {
        if (body.mode === 'LIVE' && process.env.MASTER_LIVE_ENABLED !== 'true') {
          return {
            ok: false,
            detail:
              'LIVE blocked — set MASTER_LIVE_ENABLED=true explicitly. Safe default is PAPER/BACKTEST.',
          };
        }
        // Refuse paper-as-LIVE — Attach Capital first (Start LIVE already refuses)
        if (body.mode === 'LIVE' && !masterRuntime.capitalBrokerAttached()) {
          return {
            ok: false,
            detail:
              'LIVE blocked — Capital.com not attached (refusing paper-as-LIVE). Attach Capital first.',
            status: masterRuntime.status(),
          };
        }
        if (body.mode === 'LIVE') {
          const owns = masterRuntime.ensureOwnsPipelineForCapitalLive();
          if (!owns.ok) {
            return { ok: false, detail: owns.detail, status: masterRuntime.status() };
          }
        }
        masterRuntime.setMode(body.mode);
      }
      if (typeof body.kill_switch === 'boolean') {
        masterRuntime.setKillSwitch(body.kill_switch);
      }
      if (body.epic) masterRuntime.setEpic(body.epic);
      if (body.ai_mode) {
        masterRuntime.setAiMode(body.ai_mode);
      }
      if (typeof body.owns_pipeline === 'boolean') {
        const owns = masterRuntime.setOwnsPipeline(body.owns_pipeline);
        if (!owns.ok) {
          return { ok: false, detail: owns.detail, status: masterRuntime.status() };
        }
        if (body.owns_pipeline) {
          const { disableDeskEntryBrainsWhileOwns } = await import(
            '../services/robotDesk.js'
          );
          disableDeskEntryBrainsWhileOwns();
        }
      }
      if (typeof body.entries_armed === 'boolean') {
        masterRuntime.setEntriesArmed(
          body.entries_armed,
          body.entries_pause_reason || 'operator_entries_pause'
        );
      }
      return { ok: true, status: masterRuntime.status() };
    }
  );

  app.post<{
    Body: { mode?: 'PAPER' | 'LIVE' | 'BACKTEST'; live_feed?: boolean; connection_id?: number };
  }>(
    '/api/master/start',
    async (req) => {
      const wantMode = req.body?.mode;
      // Explicit PAPER from UI must not be upgraded to LIVE by env credentials
      if (wantMode === 'PAPER') {
        const gate = await masterRuntime.refuseDetachCapitalWithOpens();
        if (!gate.ok) {
          return {
            ok: false,
            detail: gate.detail,
            broker: masterRuntime.broker?.name ?? null,
            status: masterRuntime.status(),
          };
        }
        masterRuntime.stop();
        masterRuntime.setMode('PAPER');
        masterRuntime.detachToPaperBroker();
        masterRuntime.broker_detail = 'paper_explicit';
        const live_feed =
          req.body?.live_feed === true ||
          (req.body?.live_feed !== false &&
            (process.env.MASTER_LIVE_FEED || 'public') !== 'off');
        await masterRuntime.start({
          broker: masterRuntime.ensurePaperBroker(),
          live_feed,
        });
        return {
          ok: true,
          broker: 'PAPER',
          detail: 'paper_explicit',
          live_feed,
          status: masterRuntime.status(),
        };
      }
      if (
        (wantMode === 'LIVE' || masterRuntime.cfg.mode === 'LIVE') &&
        process.env.MASTER_LIVE_ENABLED !== 'true'
      ) {
        masterRuntime.setMode('PAPER');
        return { ok: false, detail: 'LIVE blocked — MASTER_LIVE_ENABLED not set', status: masterRuntime.status() };
      }
      const { resolveBrokerFromEnv } = await import('../master/envBroker.js');
      const resolved = await resolveBrokerFromEnv({
        deskConnectionId: req.body?.connection_id ?? null,
      });
      if (!resolved.ok) {
        masterRuntime.setMode('PAPER');
        return {
          ok: false,
          detail: resolved.detail,
          broker: resolved.broker.name,
          status: masterRuntime.status(),
        };
      }
      if (resolved.mode === 'LIVE' && process.env.MASTER_LIVE_ENABLED !== 'true') {
        masterRuntime.setMode('PAPER');
        return { ok: false, detail: 'LIVE broker resolved but MASTER_LIVE_ENABLED not set', status: masterRuntime.status() };
      }
      const wantLive =
        wantMode === 'LIVE' || masterRuntime.cfg.mode === 'LIVE';
      const liveOk =
        resolved.mode === 'LIVE' && !resolved.broker.paper && resolved.ok;
      // Never label PAPER fills as LIVE — refuse rather than silent paper-as-live
      if (wantLive && !liveOk) {
        masterRuntime.setMode('PAPER');
        return {
          ok: false,
          detail: resolved.detail || 'LIVE unavailable — refusing paper-as-live',
          broker: resolved.broker.name,
          status: masterRuntime.status(),
        };
      }
      // Start LIVE is Capital.com only — MT4 legacy is a separate attach path
      if (wantLive && liveOk && resolved.broker.name !== 'CAPITAL') {
        masterRuntime.setMode('PAPER');
        return {
          ok: false,
          detail: `Start LIVE requires Capital.com (got ${resolved.broker.name}) — MT4 only via /api/master/broker/mt4 when MASTER_ALLOW_MT4_LEGACY=true`,
          broker: resolved.broker.name,
          status: masterRuntime.status(),
        };
      }
      // Single-owner: Capital LIVE defaults owns_pipeline ON; refuse explicit OFF
      if (wantLive && liveOk) {
        const owns = masterRuntime.ensureOwnsPipelineForCapitalLive();
        if (!owns.ok) {
          masterRuntime.setMode('PAPER');
          return {
            ok: false,
            detail: owns.detail,
            broker: resolved.broker.name,
            status: masterRuntime.status(),
          };
        }
      }
      // Do not swap Capital env/account while LIVE opens remain on the prior identity
      if (wantLive && liveOk) {
        const swap = await masterRuntime.refuseCapitalIdentitySwap(resolved.broker);
        if (!swap.ok) {
          return {
            ok: false,
            detail: swap.detail,
            broker: masterRuntime.broker?.name ?? null,
            status: masterRuntime.status(),
          };
        }
      }
      // Stop first so PAPER Yahoo feed cannot stick after Capital attach
      masterRuntime.stop();
      masterRuntime.attachBroker(resolved.broker);
      masterRuntime.broker_detail = resolved.detail;
      masterRuntime.noteCapitalCredentialSource(resolved.detail);
      if (liveOk) masterRuntime.setMode('LIVE');
      else masterRuntime.setMode('PAPER');
      const live_feed =
        req.body?.live_feed === true ||
        (resolved.broker.paper && (process.env.MASTER_LIVE_FEED || 'public') !== 'off');
      await masterRuntime.start({ broker: resolved.broker, live_feed });
      return {
        ok: true,
        broker: resolved.broker.name,
        detail: resolved.detail,
        live_feed,
        status: masterRuntime.status(),
      };
    }
  );

  app.post('/api/master/stop', async () => {
    masterRuntime.stop();
    return { ok: true, status: masterRuntime.status() };
  });

  app.post('/api/master/recover', async () => {
    const r = await masterRuntime.recover();
    // Opens must not sit unmanaged until Start — same bootstrap as start()
    await masterRuntime.bootstrapManageAfterRecoverPublic();
    // If operator was running before crash, resume feed/entries (PAPER/public or attached LIVE)
    const resume = await masterRuntime.resumeDesiredSession();
    return { ok: true, ...r, resume, status: masterRuntime.status() };
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

  /** Credential-free Capital connectivity probe — fails closed honestly without secrets.
   * Uses shared MASTER CST pool — never bare openCapitalSession (second POST kills LIVE).
   * Tries env CAPITAL_* first, then Brokers-page DB credentials. */
  app.post('/api/master/broker/capital/probe', async () => {
    const { acquireCapitalSession } = await import('../services/capitalCom.js');
    const { capitalEnvPresent } = await import('../master/envBroker.js');
    const { masterCapitalConnectionId } = await import('../master/capitalFactory.js');
    const { loadDeskCapitalCredentials } = await import('../master/capitalDeskCreds.js');

    let environment = (process.env.CAPITAL_ENVIRONMENT || 'demo').trim();
    let apiKey = (process.env.CAPITAL_API_KEY || '').trim();
    let identifier = (process.env.CAPITAL_IDENTIFIER || '').trim();
    let password = (
      process.env.CAPITAL_API_PASSWORD ||
      process.env.CAPITAL_PASSWORD ||
      ''
    ).trim();
    let source = 'env';

    if (!capitalEnvPresent()) {
      const desk = await loadDeskCapitalCredentials();
      if (!desk.ok) {
        return {
          ok: false,
          status: 'NO_CREDENTIALS',
          detail:
            'CAPITAL_* env missing and no Brokers-page Capital credentials — cannot open live Capital session',
          desk_detail: desk.detail,
        };
      }
      environment = desk.creds.environment;
      apiKey = desk.creds.apiKey;
      identifier = desk.creds.identifier;
      password = desk.creds.password;
      source = desk.creds.detail;
    }

    const connectionId = masterCapitalConnectionId();
    const opened = await acquireCapitalSession({
      environment,
      apiKey,
      identifier,
      password,
      connectionId,
    });
    // Leave session in pool — do not close/DELETE
    return {
      ok: opened.ok,
      status: opened.ok ? 'CONNECTED' : 'CONNECT_FAILED',
      detail: opened.ok
        ? `session_ok:pool=${connectionId}:source=${source}`
        : opened.result.detail,
      environment,
      connectionId,
      source,
    };
  });

  /**
   * Attach Capital.com broker into MASTER from env or Brokers DB.
   * Primary LIVE venue — not MT4. Requires MASTER_LIVE_ENABLED for LIVE mode.
   */
  app.post<{ Body: { connection_id?: number } }>('/api/master/broker/capital/attach', async (req) => {
    const { resolveBrokerFromEnv } = await import('../master/envBroker.js');
    const prevLive = process.env.MASTER_LIVE_ENABLED;
    if (prevLive !== 'true') {
      return {
        ok: false,
        detail:
          'Capital attach refused — set MASTER_LIVE_ENABLED=true (primary LIVE = Capital.com API)',
      };
    }
    process.env.MASTER_LIVE_ENABLED = 'true';
    const resolved = await resolveBrokerFromEnv({
      deskConnectionId: req.body?.connection_id ?? null,
    });
    if (!resolved.ok || resolved.broker.name !== 'CAPITAL') {
      return {
        ok: false,
        detail: resolved.detail,
        broker: resolved.broker.name,
        mode: resolved.mode,
      };
    }
    const swap = await masterRuntime.refuseCapitalIdentitySwap(resolved.broker);
    if (!swap.ok) {
      return {
        ok: false,
        detail: swap.detail,
        broker: masterRuntime.broker?.name ?? null,
      };
    }
    const owns = masterRuntime.ensureOwnsPipelineForCapitalLive();
    if (!owns.ok) {
      return {
        ok: false,
        detail: owns.detail,
        broker: resolved.broker.name,
        mode: resolved.mode,
      };
    }
    masterRuntime.stop();
    masterRuntime.attachBroker(resolved.broker);
    masterRuntime.broker_detail = resolved.detail;
    masterRuntime.noteCapitalCredentialSource(resolved.detail);
    masterRuntime.setMode('LIVE');
    await masterRuntime.start({ broker: resolved.broker, live_feed: false });
    return {
      ok: true,
      broker: resolved.broker.name,
      mode: masterRuntime.cfg.mode,
      running: masterRuntime.running,
      detail: resolved.detail,
      owns_pipeline: masterRuntime.ownsPipelineEffective(),
    };
  });

  /** Legacy MT4 file bridge — opt-in only. Primary LIVE venue is Capital.com API. */
  app.post<{ Body: { bridge_root?: string } }>('/api/master/broker/mt4', async (req) => {
    if ((process.env.MASTER_ALLOW_MT4_LEGACY || '').trim() !== 'true') {
      return {
        ok: false,
        detail:
          'MT4 bridge refused — primary LIVE is Capital.com API. Set MASTER_ALLOW_MT4_LEGACY=true only for legacy opt-in.',
      };
    }
    const root =
      req.body?.bridge_root ||
      process.env.MASTER_MT4_BRIDGE ||
      '/tmp/vs-master-mt4-bridge';
    const broker = new Mt4FileBroker(root);
    const connected = await broker.connect();
    if (!connected.ok) return { ok: false, detail: connected.detail };
    // Do not detach Capital while LIVE opens remain (orphans venue deals)
    const gate = await masterRuntime.refuseDetachCapitalWithOpens();
    if (!gate.ok) {
      return { ok: false, detail: gate.detail, broker: masterRuntime.broker?.name ?? null };
    }
    if (masterRuntime.broker instanceof CapitalBroker) {
      masterRuntime.broker.stopMarketStream();
    }
    // Legacy path — do not treat as primary LIVE venue
    masterRuntime.stop();
    masterRuntime.attachBroker(broker);
    const liveOk = process.env.MASTER_LIVE_ENABLED === 'true';
    if (liveOk) masterRuntime.setMode('LIVE');
    else masterRuntime.setMode('PAPER');
    await masterRuntime.start({ broker, live_feed: false });
    return {
      ok: true,
      broker: broker.name,
      root,
      mode: masterRuntime.cfg.mode,
      running: masterRuntime.running,
      live_enabled: liveOk,
      legacy: true,
      detail: liveOk
        ? `mt4_legacy:${connected.detail}`
        : `${connected.detail || 'ok'};LIVE gate off — MASTER_LIVE_ENABLED required; primary venue remains Capital.com`,
    };
  });

  app.get('/api/master/bars', async (req) => {
    const limRaw = Number((req.query as { limit?: string })?.limit ?? 200);
    const bars = masterRuntime.barsSnapshot(limRaw);
    return {
      ok: true,
      count: bars.length,
      bars,
      epic: masterRuntime.epic,
      structure_seed_source: masterRuntime.structure_seed_source,
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
    const { pickManageConfig } = await import('../master/manageConfig.js');
    const result = await replayMaster({
      bars,
      spread: req.body?.spread,
      slippage_pts: req.body?.slippage_pts,
      commission: req.body?.commission,
      cfg: {
        ...DEFAULT_MASTER_CONFIG,
        ...pickManageConfig(masterRuntime.cfg),
        mode: 'BACKTEST',
      },
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
    const { pickManageConfig } = await import('../master/manageConfig.js');
    const wf = await walkForward({
      bars,
      train: req.body?.train ?? 60,
      test: req.body?.test ?? 30,
      step: req.body?.step ?? 40,
      cfg: {
        ...DEFAULT_MASTER_CONFIG,
        ...pickManageConfig(masterRuntime.cfg),
        mode: 'BACKTEST',
      },
    });
    return { ok: true, windows: wf.windows };
  });

  app.post<{
    Body: { bars: Bar[]; spread?: number; slippage_pts?: number; commission?: number };
  }>('/api/master/ab-ai', async (req) => {
    const bars = req.body?.bars || [];
    if (bars.length < 40) return { ok: false, detail: 'need ≥40 bars' };
    const { pickManageConfig } = await import('../master/manageConfig.js');
    const ab = await abCompareAi({
      bars,
      spread: req.body?.spread,
      slippage_pts: req.body?.slippage_pts,
      commission: req.body?.commission,
      cfg: {
        ...DEFAULT_MASTER_CONFIG,
        ...pickManageConfig(masterRuntime.cfg),
        mode: 'BACKTEST',
      },
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

  app.get('/api/master/journal', async () => {
    const surface = masterRuntime.pipeline.journal.surfaceForApi();
    return {
      opportunities: surface.opportunities,
      traded_count: surface.traded_count,
      expectancy: masterRuntime.pipeline.expectancy.all(),
      open_positions: masterRuntime.positionsForApi(),
    };
  });

  app.get('/api/master/errors', async () => {
    const { loadMasterErrors } = await import('../master/errorJournal.js');
    return { errors: loadMasterErrors(50) };
  });

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
.bad{color:var(--bad)}.ok{color:var(--ok)}.warn{color:#b8860b}
h2{font-size:13px;color:#9fb0c0;margin:22px 0 8px;text-transform:uppercase;letter-spacing:.08em}
#log{background:#0a1018;border:1px solid var(--line);border-radius:8px;padding:12px;max-height:180px;overflow:auto;font-size:12px;color:#9fb0c0;white-space:pre-wrap}
</style></head><body>
<h1>VS MASTER</h1>
<p class="muted">Primary LIVE = Capital.com API (direct) · MT4 only legacy opt-in · scores heuristic — not probability · LIVE gated unless MASTER_LIVE_ENABLED</p>
<div class="row">
  <button class="primary" id="btnStart">Start PAPER</button>
  <button id="btnLive">Start LIVE (Capital)</button>
  <button id="btnStop">Stop</button>
  <button id="btnRecover">Recover</button>
  <button id="btnKill">Kill switch</button>
  <button id="btnScalp">Arm SCALP manage</button>
  <button id="btnFlatten">Flatten all</button>
  <button id="btnAi">AI mode cycle</button>
  <button id="btnOwns">MASTER owns toggle</button>
  <button id="btnCapital">Capital probe</button>
  <button id="btnCapitalAttach">Attach Capital</button>
  <button id="btnMt4">MT4 legacy</button>
</div>
<div class="grid" id="cards"></div>
<h2>Open positions</h2>
<div class="grid" id="positions"></div>
<h2>Decision journal (recent cycles)</h2>
<div class="grid" id="decisions"></div>
<h2>Trade events (OPEN/MODIFY/CLOSE)</h2>
<div class="grid" id="trades"></div>
<h2>Journal (recent traded)</h2>
<div class="grid" id="journal"></div>
<h2>Activity</h2>
<div id="log"></div>
<script>
const cards=document.getElementById('cards');
const positions=document.getElementById('positions');
const decisions=document.getElementById('decisions');
const trades=document.getElementById('trades');
const journal=document.getElementById('journal');
const logEl=document.getElementById('log');
let kill=false, ai='off';
function card(k,v,cls){return '<div class="card"><div class="k">'+k+'</div><div class="v '+(cls||'')+'">'+v+'</div></div>'}
function pushLog(msg){const t=new Date().toISOString().slice(11,19);logEl.textContent='['+t+'] '+msg+'\\n'+logEl.textContent.slice(0,4000)}
async function refresh(){
  try{
    const s=await fetch('/api/master/status').then(r=>r.json());
    kill=!!s.kill_switch;
    const cyclePending=!s.last_market;
    const whyRaw=s.last_block_reason||s.monitoring?.entry_block_reason||s.last_execution_detail||s.last_decision?.kind||'—';
    const why=(cyclePending&&whyRaw!=='—')?(String(whyRaw).indexOf('hydrated ·')===0?String(whyRaw):('hydrated · '+whyRaw)):whyRaw;
    const whyCls=String(why).indexOf('hydrated ·')===0?'warn':(s.last_block_reason||s.monitoring?.entry_block_reason?'bad':'ok');
    const monHydrated=!!(s.monitoring&&s.monitoring.hydrated)||(cyclePending&&!!(s.monitoring&&(s.monitoring.entry_block_reason||(s.monitoring.active_alerts&&s.monitoring.active_alerts.length)||s.monitoring.relative_spread!=null||s.monitoring.instance_health)));
    cards.innerHTML=[
      card('Mode',s.mode),
      card('Epic',s.epic||'—'),
      card('Health',s.health,(s.health.includes('KILL')||s.health==='PERSIST_DEGRADED'||s.health==='LIVE_NO_CAPITAL'||s.health==='LIVE_UNATTACHED'||s.health==='LIVE_ACCOUNT_UNPROVEN'||s.health==='LIVE_QUOTE_STALE'||s.health==='LIVE_VENUE_UNPROVEN'||s.health==='OPENS_UNMANAGED'||s.health==='RESUME_PENDING')?'bad':'ok'),
      card('Broker',s.broker||'—'),
      card('Broker detail',s.broker_detail||'—'),
      card('Capital LIVE',s.capital_live_attached?'ATTACHED':(s.capital_creds_available?(s.capital_credential_source==='desk'?'creds Brokers':'creds env'):'need keys'),s.capital_live_attached?'ok':(s.mode==='LIVE'?'bad':'')),
      card('Quote',s.quote?((s.quote.cached?'cached · ':'')+Number(s.quote.mid).toFixed(2)+' · '+Math.round((s.quote.age_ms||0)/1000)+'s'+(s.quote.stream_healthy===true?' · WS':s.quote.stream_healthy===false?' · REST':'')):'—', (s.quote&&s.quote.cached?'warn':(s.quote&&(s.quote.stale===true||(s.quote.stale==null&&s.quote.age_ms>(s.quote.stale_quote_ms||15000)))?'bad':(s.quote?'ok':''))),
      card('Float UPL',s.floating_pnl!=null?((s.floating_pnl_cached?'cached · ':'')+(s.floating_pnl_epic_scoped?'epic · ':'')+Number(s.floating_pnl).toFixed(2)):(s.floating_pnl_epic_scoped?'epic · —':'—'), s.floating_pnl==null?'':(s.floating_pnl_cached?'warn':(s.floating_pnl<0?'bad':(s.floating_pnl>0?'ok':''))),
      card('Manage epics',(function(){var m=s.manage_epics;if(!m)return'—';var managed=(m.managed||[]).join(',')||'—';var fail=[].concat(m.quote_fetch_failed||[],m.unmanaged_open||[]);var seen={};var uniq=[];for(var i=0;i<fail.length;i++){var e=fail[i];if(!seen[e]){seen[e]=1;uniq.push(e);}}return uniq.length?(managed+' · skip '+uniq.join(',')).slice(0,80):managed;})(),s.manage_epics&&s.manage_epics.unmanaged_open&&s.manage_epics.unmanaged_open.length?'bad':(s.manage_epics&&s.manage_epics.managed&&s.manage_epics.managed.length?'ok':'')),
      card('Manage',s.manage&&s.manage.scalp_pct_chase?'SCALP chase on':'structure/MFE'),
      card('Owns pipeline',s.owns_pipeline?'YES':'no',s.owns_pipeline?'ok':(s.mode==='LIVE'?'bad':'')),
      card('Market Core intents',s.market_core_intents_allowed?'allowed':'BLOCKED (MASTER owns)',s.market_core_intents_allowed?(s.owns_pipeline?'bad':'ok'):(s.owns_pipeline?'ok':'')),
      card('Client fanout',s.last_client_fanout?(s.last_client_fanout.attempted?(s.last_client_fanout.detail||'—'):'idle'):'—',s.last_client_fanout&&s.last_client_fanout.attempted&&s.last_client_fanout.ok_count>0?'ok':(s.last_client_fanout&&s.last_client_fanout.attempted&&s.last_client_fanout.fail_count>0&&!s.last_client_fanout.ok_count?'bad':'')),
      card('Cycles by epic',(function(){var c=s.cycles_by_epic;if(!c)return'—';var keys=Object.keys(c).sort();if(!keys.length)return'—';var active=String(s.epic||'').trim().toUpperCase();var body=keys.map(function(epic){var row=c[epic]||{};var setup=row.market_setup;var setupBit=setup?((setup.status||'?')+(setup.side?(' '+setup.side):'')):'no-setup';var mark=active&&epic.toUpperCase()===active?'*':'';return mark+epic+':'+setupBit+' · '+(row.decision_kind||'—');}).join(' · ').slice(0,220);return s.cycles_by_epic_hydrated?('hydrated · '+body):body;})(),s.cycles_by_epic&&Object.keys(s.cycles_by_epic).length>=2&&!s.cycles_by_epic_hydrated?'ok':(s.cycles_by_epic_hydrated?'warn':'')),
      card('Manage owner',s.manage_owner||'—',s.manage_owner==='MASTER'?'ok':(s.manage_owner==='DESK_DEFERRED_HARD'||(s.mode==='LIVE'&&s.manage_owner==='DESK')?'bad':'')),
      card('Persist',s.persist_backend||'—',s.persist_backend==='dual'||s.persist_backend==='file'?'ok':''),
      card('Journal audit',s.journal_audit?('D'+s.journal_audit.decisions+'/T'+s.journal_audit.trades+(s.journal_audit.healed_from_persist?' · healed':'')+(!s.journal_audit.decision_sidecar||!s.journal_audit.trade_sidecar?' · sidecar missing':'')):'—',s.journal_audit&&(!s.journal_audit.decision_sidecar||!s.journal_audit.trade_sidecar)&&!s.journal_audit.decisions&&!s.journal_audit.trades?'bad':(s.journal_audit&&(s.journal_audit.decisions||s.journal_audit.trades||s.journal_audit.healed_from_persist)?'ok':'')),
      card('Entries',s.entries_armed===false?('PAUSED'+(s.entries_pause_reason?' · '+s.entries_pause_reason:'')):'armed',s.entries_armed===false?'bad':'ok'),
      card('SETUP',s.market_setup?((s.setup_gate_armed?'gate · ':'')+s.market_setup.status+(s.market_setup.side?' '+s.market_setup.side:'')+' · '+s.market_setup.kind):'—',s.setup_gate_armed&&(!s.market_setup||s.market_setup.status!=='ARMED')?'bad':(s.market_setup&&s.market_setup.status==='ARMED'?'ok':(s.market_setup&&String(s.market_setup.reason||'').indexOf('hydrated ·')===0?'warn':''))),
      card('Structure seed',s.structure_seed_source||'—'),
      card('Bars cache',s.bars_cached?('cached · '+(s.bars_available||0)):String(s.bars_available||0),(s.bars_available||0)<40?'bad':(s.bars_cached?'warn':((s.bars_available||0)>=40?'ok':''))),
      card('AI mode',s.ai_mode||'—'),
      card('AI allow close',s.ai_mode==='off'?'n/a':(s.last_ai_allow_close===false?'VETO':s.last_ai_allow_close===true?'allow':'—'),s.ai_mode!=='off'&&s.last_ai_allow_close===false?'bad':''),
      card('Close fail',s.last_close_failed?((s.last_close_failed.exit_reason||'')+' · '+(s.last_close_failed.detail||'')).slice(0,80):'—',s.last_close_failed?'bad':''),
      card('Running',s.running?'YES':'NO',s.running?'ok':''),
      card('Desired run',s.desired_running?'YES':'no',s.desired_running&&!s.running?'bad':s.desired_running&&s.running?'ok':''),
      card('Regime',s.regime,String(s.regime||'').indexOf('hydrated ·')===0?'warn':''),
      card('Market state',s.market_state||'—',s.market_state&&String(s.market_state).indexOf('invalid:')>=0?'bad':(String(s.market_state||'').indexOf('hydrated ·')===0?'warn':'')),
      card('Norm',s.last_market?('Q='+Number(s.last_market.quality).toFixed(2)+' · '+s.last_market.bars_out+'/'+s.last_market.bars_in+(s.last_market.reasons&&s.last_market.reasons.length?' · '+s.last_market.reasons.slice(0,2).join('|'):'')):(s.pipeline_stages&&s.pipeline_stages.normalization&&String(s.pipeline_stages.normalization.detail||'').indexOf('hydrated ·')===0?s.pipeline_stages.normalization.detail:'—'),s.last_market&&(!s.last_market.ok||s.last_market.quality<0.5)?'bad':(s.last_market&&s.last_market.ok?'ok':(s.pipeline_stages&&s.pipeline_stages.normalization&&String(s.pipeline_stages.normalization.detail||'').indexOf('hydrated ·')===0?'warn':'')),
      card('BUY',cyclePending?('hydrated · '+Number(s.buy_score||0).toFixed(3)):Number(s.buy_score||0).toFixed(3),cyclePending?'warn':''),
      card('BUY filter',s.buy_filter?(s.buy_filter.reason==='hydrated'?('hydrated · '+Number(s.buy_filter.score).toFixed(3)):(s.buy_filter.ok?('ok · '+Number(s.buy_filter.score).toFixed(3)):((s.buy_filter.reason||'fail')+' · '+Number(s.buy_filter.score).toFixed(3)))):'—',s.buy_filter&&s.buy_filter.reason==='hydrated'?'warn':(s.buy_filter&&!s.buy_filter.ok?'bad':(s.buy_filter&&s.buy_filter.ok?'ok':''))),
      card('SELL',cyclePending?('hydrated · '+Number(s.sell_score||0).toFixed(3)):Number(s.sell_score||0).toFixed(3),cyclePending?'warn':''),
      card('SELL filter',s.sell_filter?(s.sell_filter.reason==='hydrated'?('hydrated · '+Number(s.sell_filter.score).toFixed(3)):(s.sell_filter.ok?('ok · '+Number(s.sell_filter.score).toFixed(3)):((s.sell_filter.reason||'fail')+' · '+Number(s.sell_filter.score).toFixed(3)))):'—',s.sell_filter&&s.sell_filter.reason==='hydrated'?'warn':(s.sell_filter&&!s.sell_filter.ok?'bad':(s.sell_filter&&s.sell_filter.ok?'ok':''))),
      ...(s.pipeline_stages?['market_validation','normalization','analysis_regime','dual_candidates','filters','decision','risk','execution','broker','position_manager','exit','journal','performance'].map(function(id){var st=s.pipeline_stages[id];var lab={market_validation:'Stage·validate',normalization:'Stage·normalize',analysis_regime:'Stage·regime',dual_candidates:'Stage·dual',filters:'Stage·filters',decision:'Stage·decision',risk:'Stage·risk',execution:'Stage·exec',broker:'Stage·broker',position_manager:'Stage·position',exit:'Stage·exit',journal:'Stage·journal',performance:'Stage·perf'}[id]||id;var det=st?String(st.detail||''):'';var awaiting=det.indexOf('hydrated ·')>=0||det.indexOf('no cycle')>=0;return card(lab,st?((st.ok?'ok':'—')+' · '+st.detail):'—',st&&st.ok?'ok':(st&&awaiting?'warn':(st?'bad':''))}):[]),
      card('Decision',s.last_decision?(cyclePending?('hydrated · '+s.last_decision.kind):s.last_decision.kind):'—',cyclePending&&s.last_decision?'warn':''),
      card('Why',why,whyCls),
      card('Entry gates',s.entry_gates?([s.entry_gates.weekend?'weekend':null,'session='+s.entry_gates.session,s.entry_gates.hours_ok?'hoursOK':'hoursBLOCK',s.entry_gates.news_cfg_on?(s.entry_gates.news_blocks?('newsBLOCK'+(s.entry_gates.news_detail?'·'+s.entry_gates.news_detail:'')):'newsClear'):'newsOff'].filter(Boolean).join(' · ')):'—',s.entry_gates&&s.entry_gates.session_hydrated?'warn':(s.entry_gates&&(s.entry_gates.weekend||s.entry_gates.session_blocks||!s.entry_gates.hours_ok||s.entry_gates.news_blocks)?'bad':(s.entry_gates?'ok':''))),
      card('Last exit',s.last_exit_reason?(cyclePending?('hydrated · '+s.last_exit_reason):s.last_exit_reason):'—',cyclePending&&s.last_exit_reason?'warn':''),
      card('Equity',s.capital_account_proven===false?'UNPROVEN':(s.account?.equity!=null?Number(s.account.equity).toFixed(2):'—'),s.capital_account_proven===false?'bad':''),
      card('Available',s.capital_account_proven===false?'—':(s.account?.available_to_deal!=null?Number(s.account.available_to_deal).toFixed(2):'—')),
      card('Trade allowed',s.account?.trade_allowed===false?'NO':s.account?.trade_allowed===true?'YES':'—',s.account?.trade_allowed===false?'bad':s.account?.trade_allowed===true?'ok':''),
      card('News',s.news_window?.window_active?(s.news_window.impact+' · '+s.news_window.source):'clear',s.news_window?.window_active&&s.news_window?.impact==='high'?'bad':''),
      card('Daily PnL',s.capital_account_proven===false?'—':(s.account?.daily_pnl!=null?Number(s.account.daily_pnl).toFixed(2):'—')),
      card('Closed PnL',s.performance?.trades?((cyclePending?'hydrated · ':'')+Number(s.performance.total_pnl||0).toFixed(2)):'—',cyclePending?'warn':(s.performance?.trades?(Number(s.performance.total_pnl||0)<0?'bad':(Number(s.performance.total_pnl||0)>0?'ok':'')):'')),
      card('Day start eq',s.capital_account_proven===false?'UNPROVEN':(s.account?.day_start_equity!=null?Number(s.account.day_start_equity).toFixed(2):'—'),s.capital_account_proven===false?'bad':''),
      card('Peak eq',s.capital_account_proven===false?'UNPROVEN':(s.account?.peak_equity!=null?Number(s.account.peak_equity).toFixed(2):'—'),s.capital_account_proven===false?'bad':''),
      card('Reject cool',(s.reject_cooldown_ms||0)>0?(Math.ceil((s.reject_cooldown_ms||0)/1000)+'s'):'—',(s.reject_cooldown_ms||0)>0?'bad':''),
      card('Post-exit cool',(s.post_exit_cooldown_ms||0)>0?(Math.ceil((s.post_exit_cooldown_ms||0)/1000)+'s'):'—',(s.post_exit_cooldown_ms||0)>0?'bad':''),
      card('Open',s.open_positions,(s.open_positions||0)>0&&(!s.running||s.health==='OPENS_UNMANAGED'||s.health==='OPENS_MANAGE_ONLY')?'bad':''),
      card('Venue',s.capital_live_attached?(s.capital_venue_opens_proven===false?'unproven':String(s.capital_venue_opens||0)):'—',s.capital_live_attached&&(s.capital_venue_opens_proven===false||(s.capital_venue_opens||0)>0)?'bad':''),
      card('Trades',s.traded),
      card('Blocked',s.blocked),
      card('Expectancy',s.performance?.trades?Number(s.performance.expectancy||0).toFixed(3):'—'),
      card('Fees',s.performance?.trades?Number(s.performance.total_fees||0).toFixed(2):'—'),
      card('Win rate',s.performance?.trades?((Number(s.performance.win_rate||0)*100).toFixed(1)+'%'):'—'),
      card('Profit factor',s.performance?.trades&&s.performance?.profit_factor!=null&&Number.isFinite(s.performance.profit_factor)?Number(s.performance.profit_factor).toFixed(2):'—'),
      card('Loss streak',s.capital_account_proven===false?'—':(s.account?.consecutive_losses!=null?String(s.account.consecutive_losses):'—'),s.capital_account_proven!==false&&(s.account?.consecutive_losses||0)>=3?'bad':''),
      card('MC p50',s.monte_carlo?.equity_p50!=null?Number(s.monte_carlo.equity_p50).toFixed(2):(s.monte_carlo?.p50!=null?Number(s.monte_carlo.p50).toFixed(2):'—')),
      card('Rel spread',s.monitoring?.relative_spread!=null?((monHydrated?'hydrated · ':'')+Number(s.monitoring.relative_spread).toFixed(2)):'—',monHydrated?'warn':(s.monitoring?.relative_spread!=null&&s.monitoring.relative_spread>1.5?'bad':'')),
      card('Cycle ms',s.monitoring?.last_cycle_ms!=null?((monHydrated?'hydrated · ':'')+String(s.monitoring.last_cycle_ms)):'—',monHydrated?'warn':''),
      card('ACK ms',s.monitoring?.ack_latency_ms!=null?((monHydrated?'hydrated · ':'')+String(s.monitoring.ack_latency_ms)):'—',monHydrated?'warn':''),
      card('Inst health',s.monitoring?.instance_health?((monHydrated?'hydrated · ':'')+s.monitoring.instance_health):'—',monHydrated?'warn':(s.monitoring?.instance_health==='CRITICAL'||s.monitoring?.instance_health==='DEGRADED'?'bad':s.monitoring?.instance_health==='OK'?'ok':'')),
      card('Alert block',s.monitoring?.entry_block_reason?((String(s.monitoring.entry_block_reason).indexOf('hydrated ·')===0||!monHydrated)?String(s.monitoring.entry_block_reason):('hydrated · '+s.monitoring.entry_block_reason)):'—',monHydrated?'warn':(s.monitoring?.entry_block_reason?'bad':'')),
      card('Alerts',(s.monitoring?.active_alerts&&s.monitoring.active_alerts.length)?((monHydrated?'hydrated · ':'')+s.monitoring.active_alerts.slice(0,3).map(a=>a.code).join(' · ')):'—',monHydrated?'warn':((s.monitoring?.active_alerts&&s.monitoring.active_alerts.length)?'bad':'')),
      card('Err/min',s.monitoring?.error_rate_per_min!=null?((monHydrated?'hydrated · ':'')+String(s.monitoring.error_rate_per_min)):'—',monHydrated?'warn':((s.monitoring?.error_rate_per_min||0)>0?'bad':'')),
      card('Max DD',s.performance?.trades?Number(s.performance.max_drawdown||0).toFixed(2):'—'),
      card('Recovered',s.recovered?'YES':'—'),
      card('Persist',s.persist_ok===false?'DEGRADED':'OK',s.persist_ok===false?'bad':'ok'),
      card('Persist err',s.last_persist_error||'—',s.last_persist_error?'bad':''),
      card('Last error',(s.recent_errors&&s.recent_errors[0])?((cyclePending||monHydrated?'hydrated · ':'')+s.recent_errors[0].error_type+': '+s.recent_errors[0].message).slice(0,80):'—',(!cyclePending&&!monHydrated&&s.recent_errors&&s.recent_errors.length)?'bad':((cyclePending||monHydrated)&&s.recent_errors&&s.recent_errors.length?'warn':'')),
    ].join('');
    const pos=await fetch('/api/master/positions').then(r=>r.json());
    const list=pos.positions||[];
    positions.innerHTML=list.length?list.map(p=>{
      const upl=p.upl;
      const uplTxt=upl!=null&&Number.isFinite(Number(upl))?Number(upl).toFixed(2):'—';
      const uplCls=upl==null?'':(Number(upl)>=0?'ok':'bad');
      return '<div class="card"><div class="k">'+p.side+' '+p.epic+' <button data-close="'+p.position_id+'" style="float:right;font-size:11px;padding:2px 8px">Close</button></div><div class="v">'+Number(p.entry).toFixed(2)+(p.stop_loss!=null&&Number(p.stop_loss)>0?' · SL '+Number(p.stop_loss).toFixed(2):' · SL —')+' · UPL <span class="'+uplCls+'">'+uplTxt+'</span></div></div>';
    }).join('')
      :card('Open','FLAT');
    positions.querySelectorAll('[data-close]').forEach(btn=>btn.onclick=async()=>{
      const id=btn.getAttribute('data-close');
      const r=await fetch('/api/master/positions/'+encodeURIComponent(id)+'/close',{method:'POST'}).then(r=>r.json());
      pushLog('close '+id+' ok='+r.ok+' '+(r.detail||''));refresh();
    });
    const dec=(s.recent_decisions||[]).slice(0,8);
    decisions.innerHTML=dec.length?dec.map(d=>{
      const detail=d.block_reason||d.execution_detail||'—';
      const opp=d.opportunity_id?' · opp '+String(d.opportunity_id).slice(0,8):'';
      return card(d.kind+(d.executed?' · FILL':''), String(detail).slice(0,48)+opp+(d.ts?' · '+String(d.ts).slice(11,19):''), d.executed?'ok':(d.block_reason?'bad':''));
    }).join(''):card('Decisions','no cycle events yet');
    const te=(s.recent_trades||[]).slice(0,8);
    trades.innerHTML=te.length?te.map(t=>{
      const ev=String(t.event||'').toUpperCase();
      const unproven=(ev==='CLOSE'&&t.pnl==null)||/pnl_unproven|capital_close_pnl_unproven/i.test(String(t.detail||''));
      const pn=unproven?'—':(t.pnl!=null?Number(t.pnl).toFixed(2):'—');
      const fees=!unproven&&t.fees!=null&&t.fees>0?' · fees '+Number(t.fees).toFixed(2):'';
      const opp=t.opportunity_id?' · opp '+String(t.opportunity_id).slice(0,8):'';
      return card(t.event+' · '+t.broker+(t.ok?'':' · FAIL')+(unproven&&t.ok?' · UNPROVEN':''), pn+fees+' · '+String(t.detail||'').slice(0,36)+opp+(t.ts?' · '+String(t.ts).slice(11,19):''), t.ok?(unproven?'':(t.pnl!=null&&t.pnl<0?'bad':'ok')):'bad');
    }).join(''):card('Trades','no trade events yet');
    const j=await fetch('/api/master/journal').then(r=>r.json());
    const traded=(j.opportunities||[]).filter(o=>o.executed&&o.outcome).slice(-8).reverse();
    journal.innerHTML=traded.length?traded.map(o=>{
      const unproven=o.outcome.pnl_proven===false;
      const pn=unproven?'—':Number(o.outcome.pnl).toFixed(2);
      return card(o.decision?.kind+' '+o.epic+(unproven?' · UNPROVEN':''), pn+' · '+String(o.outcome.exit_reason||'').slice(0,40), unproven?'':(Number(o.outcome.pnl)>=0?'ok':'bad'));
    }).join(''):card('Journal','no closed trades yet');
  }catch(e){pushLog('status error '+e)}
}
document.getElementById('btnStart').onclick=async()=>{const s=await fetch('/api/master/status').then(r=>r.json());if(s.capital_live_attached&&((s.open_positions||0)>0||(s.capital_venue_opens||0)>0||s.capital_venue_opens_proven===false)){pushLog('refuse Start PAPER — Flatten all Capital opens first');return;}await fetch('/api/master/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'PAPER'})});const r=await fetch('/api/master/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'PAPER'})}).then(r=>r.json());pushLog('start PAPER ok='+r.ok+' '+(r.detail||''));refresh()};
document.getElementById('btnLive').onclick=async()=>{const s0=await fetch('/api/master/status').then(r=>r.json());if(!s0.owns_pipeline){await fetch('/api/master/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({owns_pipeline:true})});}await fetch('/api/master/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'LIVE'})});const r=await fetch('/api/master/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'LIVE'})}).then(r=>r.json());pushLog('start LIVE ok='+r.ok+' '+(r.detail||'')+' mode='+(r.status&&r.status.mode));refresh()};
document.getElementById('btnStop').onclick=async()=>{const r=await fetch('/api/master/stop',{method:'POST'}).then(r=>r.json());pushLog('stop');refresh()};
document.getElementById('btnRecover').onclick=async()=>{const r=await fetch('/api/master/recover',{method:'POST'}).then(r=>r.json());pushLog('recover positions='+r.positions+' journal='+r.opportunities);refresh()};
document.getElementById('btnKill').onclick=async()=>{kill=!kill;await fetch('/api/master/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kill_switch:kill})});pushLog('kill_switch='+kill);refresh()};
document.getElementById('btnScalp').onclick=async()=>{const r=await fetch('/api/master/config/scalp-preset',{method:'POST'}).then(r=>r.json());pushLog('scalp-preset ok='+r.ok);refresh()};
document.getElementById('btnFlatten').onclick=async()=>{const r=await fetch('/api/master/flatten',{method:'POST'}).then(r=>r.json());pushLog('flatten closed='+r.closed+' failed='+(r.failed||[]).length);refresh()};
document.getElementById('btnAi').onclick=async()=>{const cur=ai||'off';ai=cur==='off'?'advisory':cur==='advisory'?'required':'off';await fetch('/api/master/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ai_mode:ai})});pushLog('ai_mode='+ai);refresh()};
document.getElementById('btnOwns').onclick=async()=>{const s=await fetch('/api/master/status').then(r=>r.json());const on=!s.owns_pipeline;await fetch('/api/master/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({owns_pipeline:on})});pushLog('owns_pipeline='+on);refresh()};
document.getElementById('btnCapital').onclick=async()=>{const r=await fetch('/api/master/broker/capital/probe',{method:'POST'}).then(r=>r.json());pushLog('capital probe '+JSON.stringify(r).slice(0,200));refresh()};
document.getElementById('btnCapitalAttach').onclick=async()=>{const s0=await fetch('/api/master/status').then(r=>r.json());if(!s0.owns_pipeline){await fetch('/api/master/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({owns_pipeline:true})});}const r=await fetch('/api/master/broker/capital/attach',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json());pushLog('capital attach '+JSON.stringify(r).slice(0,200));refresh()};
document.getElementById('btnMt4').onclick=async()=>{const bridge=prompt('MT4 bridge root path','/tmp/vs-mt4-bridge');if(!bridge)return;const r=await fetch('/api/master/broker/mt4',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bridge_root:bridge})}).then(r=>r.json());pushLog('mt4 '+JSON.stringify(r).slice(0,200));refresh()};
refresh();setInterval(refresh,2000);
</script>
</body></html>`;
    return reply.type('text/html').send(html);
  });
}
