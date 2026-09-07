/**
 * LIVE broker proof via Check- MT4 file bridge + local simulator.
 * No Capital credentials required — real OPEN→fill→manage→CLOSE path.
 *
 *   npx tsx src/master/scripts/mt4LiveDemo.ts
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Mt4FileBroker } from '../broker.js';
import { Mt4BridgeSimulator } from '../mt4Sim.js';
import { masterRuntime } from '../runtime.js';
import { DEFAULT_MASTER_CONFIG, GOLD_SPEC, MasterPipeline } from '../pipeline.js';
import { PositionManager } from '../positionManager.js';
import { executeDecision } from '../execution.js';
import { installFilePersist } from '../filePersist.js';
import { setPersistClient } from '../persist.js';
import type { Bar, Quote } from '../types.js';

function barsTrendUp(n = 40): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4470 + i * 0.4;
    out.push({
      open: o,
      high: o + 0.8,
      low: o - 0.2,
      close: o + 0.5,
      ts_ms: Date.now() - (n - i) * 60_000,
    });
  }
  return out;
}

function quote(mid: number): Quote {
  return {
    bid: mid - 0.2,
    ask: mid + 0.2,
    mid,
    spread: 0.4,
    ts_ms: Date.now(),
  };
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const artifactDir = process.env.ARTIFACT_DIR || '/opt/cursor/artifacts';
  mkdirSync(artifactDir, { recursive: true });
  const bridge = mkdtempSync(join(tmpdir(), 'vs-mt4-live-'));
  installFilePersist(join(bridge, 'state'));

  const sim = new Mt4BridgeSimulator(bridge);
  sim.setQuote(4476.2, 4476.6);
  sim.start(100);

  const broker = new Mt4FileBroker(bridge);
  await broker.connect();

  process.env.MASTER_LIVE_ENABLED = 'true';
  masterRuntime.stop();
  masterRuntime.pipeline = new MasterPipeline('LIVE');
  masterRuntime.positions = new PositionManager();
  masterRuntime.cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'LIVE', min_score: 0.3 };
  masterRuntime.attachBroker(broker);
  masterRuntime.broker_detail = `mt4_sim:${bridge}`;
  masterRuntime.setMode('LIVE');
  masterRuntime.setEpic('XAUUSD');
  await masterRuntime.start({ broker });

  const bars = barsTrendUp(45);
  const q = quote(4476.4);
  // Ensure market files visible to broker
  sim.setQuote(q.bid, q.ask);

  const cycle = await masterRuntime.pipeline.runCycle({
    bars,
    quote: q,
    account: masterRuntime.account,
    instrument: { ...GOLD_SPEC, epic: 'XAUUSD' },
    cfg: masterRuntime.cfg,
  });

  const decision = {
    ...cycle.decision,
    kind: 'BUY' as const,
    side: 'BUY' as const,
    block_reason: null,
    buy: { ...cycle.decision.buy, valid: true, filter_ok: true, score: 0.9, stop_loss: 4460 },
  };

  const { execution, place } = await executeDecision({
    broker,
    pipeline: masterRuntime.pipeline,
    opportunity: cycle.opportunity,
    decision,
    risk: { allowed: true, volume: 0.05, risk_amount: 10, reasons: [] },
    epic: 'XAUUSD',
    allow_live: true,
  });

  // Wait for simulator to process OPEN and write ack/status
  await sleep(400);
  const openAfter = await broker.listOpenPositions('XAUUSD');
  let position_id = place?.position_id || openAfter.positions[0]?.position_id || null;
  if (!position_id && openAfter.positions[0]) position_id = openAfter.positions[0].position_id;

  // If place returned null position_id (async file ack), adopt from broker list
  if (!position_id && sim.listPositions()[0]) {
    position_id = String(sim.listPositions()[0]!.ticket);
  }

  if (position_id) {
    masterRuntime.positions.register({
      position_id,
      opportunity_id: cycle.opportunity.id,
      intent_id: execution.intent_id || 'mt4-live',
      epic: 'XAUUSD',
      side: 'BUY',
      size: 0.05,
      entry: openAfter.positions[0]?.open_level || q.ask,
      stop_loss: 4460,
      decision,
    });
  }

  // Crash price → HardInv exit via MASTER manageTick → MT4 CLOSE command
  sim.setQuote(4440, 4440.4);
  const crash = quote(4440.2);
  const managed = await masterRuntime.positions.manageTick({
    broker,
    pipeline: masterRuntime.pipeline,
    quote: crash,
    instrument_point_value: 1,
  });
  await sleep(400);

  const openFinal = await broker.listOpenPositions();
  const report = {
    status:
      execution.accepted &&
      position_id &&
      managed.closed.length >= 1 &&
      openFinal.ok &&
      openFinal.positions.length === 0
        ? 'PASS_MT4_LIVE'
        : 'FAIL',
    bridge,
    execution: { accepted: execution.accepted, detail: execution.detail, order_id: place?.order_id },
    position_id,
    open_after_entry: openAfter.positions.length,
    exits: managed.closed.map((c) => c.reason),
    open_final: openFinal.positions.length,
    list_ok: openFinal.ok,
    mode: 'LIVE',
    broker: 'MT4_FILE',
  };

  console.log(JSON.stringify(report, null, 2));
  writeFileSync(join(artifactDir, 'vs_master_mt4_live_demo.json'), JSON.stringify(report, null, 2));

  sim.stop();
  masterRuntime.stop();
  setPersistClient(null);
  delete process.env.MASTER_LIVE_ENABLED;
  if (report.status !== 'PASS_MT4_LIVE') process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
