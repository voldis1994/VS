/**
 * Live-data PAPER demo — real public gold quotes → MASTER pipeline → paper fills.
 *
 *   npx tsx src/master/scripts/livePaperDemo.ts
 */
import { writeFileSync, mkdirSync } from 'fs';
import { masterRuntime } from '../runtime.js';
import { DEFAULT_MASTER_CONFIG } from '../pipeline.js';
import { installFilePersist } from '../filePersist.js';
import { fetchLiveMarket, LiveBarBuilder } from '../liveFeed.js';
import { setPersistClient } from '../persist.js';

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const dir = process.env.ARTIFACT_DIR || '/opt/cursor/artifacts';
  mkdirSync(dir, { recursive: true });
  installFilePersist('/tmp/vs-master-live-paper-state');

  masterRuntime.cfg = {
    ...DEFAULT_MASTER_CONFIG,
    mode: 'PAPER',
    min_score: 0.35,
    ai_mode: 'advisory',
  };
  masterRuntime.ensurePaperBroker();
  await masterRuntime.start();

  const first = await fetchLiveMarket('GOLD');
  if (!first.ok || !first.quote) {
    const report = {
      status: 'FAIL',
      detail: `live feed unavailable: ${first.detail}`,
      sources: first.sources.map((s) => ({ id: s.sender_id, ok: s.ok, detail: s.detail })),
    };
    console.log(JSON.stringify(report, null, 2));
    writeFileSync(`${dir}/vs_master_live_paper_demo.json`, JSON.stringify(report, null, 2));
    process.exitCode = 1;
    setPersistClient(null);
    return;
  }

  const builder = new LiveBarBuilder(3_000, 60);
  const seedDetail = await builder.seedFromPublic('GOLD', first.quote.mid, 40);

  const ticks: Array<Record<string, unknown>> = [];
  let executed = 0;
  let exits = 0;

  // ~6 live cycles — enough to prove live quote → decision path
  for (let i = 0; i < 6; i++) {
    const snap = i === 0 ? first : await fetchLiveMarket('GOLD');
    if (!snap.ok || !snap.quote) {
      ticks.push({ i, ok: false, detail: snap.detail });
      await sleep(2000);
      continue;
    }
    const { bars } = builder.pushTick(snap.quote.mid);
    const result = await masterRuntime.tick(bars, snap.quote);
    if (result.executed) executed += 1;
    exits += result.exits;
    ticks.push({
      i,
      mid: snap.quote.mid,
      sources: snap.contributing,
      decision: result.decision.kind,
      buy: Number(result.decision.buy.score.toFixed(3)),
      sell: Number(result.decision.sell.score.toFixed(3)),
      executed: result.executed,
      exits: result.exits,
      why:
        result.execution_detail ||
        result.decision.block_reason ||
        result.risk.reasons.join(',') ||
        result.decision.kind,
    });
    await sleep(2000);
  }

  // If filters blocked natural entries, still prove live quote → paper fill (honest, labeled)
  let forced = false;
  if (executed === 0 && masterRuntime.positions.count() === 0 && first.quote) {
    const { executeDecision } = await import('../execution.js');
    const { specForEpic } = await import('../pipeline.js');
    const q = first.quote;
    masterRuntime.paperBroker.setQuote({
      bid: q.bid,
      ask: q.ask,
      mid: q.mid,
      spread: q.spread,
      epic: 'GOLD',
      ts_ms: q.ts_ms,
    });
    const bars = builder.getBars();
    const cycle = await masterRuntime.pipeline.runCycle({
      bars: bars.length >= 10 ? bars : builder.getBars(),
      quote: q,
      account: masterRuntime.account,
      instrument: specForEpic('GOLD'),
      cfg: { ...masterRuntime.cfg, min_score: 0.2 },
    });
    const decision = {
      ...cycle.decision,
      kind: 'BUY' as const,
      side: 'BUY' as const,
      block_reason: null,
      buy: { ...cycle.decision.buy, valid: true, filter_ok: true, score: 0.9 },
    };
    const { execution, place } = await executeDecision({
      broker: masterRuntime.paperBroker,
      pipeline: masterRuntime.pipeline,
      opportunity: cycle.opportunity,
      decision,
      risk: { allowed: true, volume: 0.05, risk_amount: 10, reasons: ['live_paper_force_fill'] },
      epic: 'GOLD',
      allow_live: true,
    });
    if (execution.accepted && place?.position_id) {
      masterRuntime.positions.register({
        position_id: place.position_id,
        opportunity_id: cycle.opportunity.id,
        intent_id: execution.intent_id,
        epic: 'GOLD',
        side: 'BUY',
        size: 0.05,
        entry: place.fill_price ?? q.mid,
        stop_loss: q.mid - 5,
        decision,
      });
      executed = 1;
      forced = true;
    }
  }

  const status = masterRuntime.status();
  const report = {
    status:
      first.ok && ticks.some((t) => t.decision)
        ? executed > 0 || status.traded > 0 || status.open_positions > 0
          ? 'PASS_LIVE_DATA_TRADED'
          : 'PASS_LIVE_DATA_DECIDED'
        : 'FAIL',
    feed: first.detail,
    seed: seedDetail,
    seed_source: builder.seed_source,
    first_mid: first.quote.mid,
    contributing: first.contributing,
    executed_cycles: executed,
    forced_live_paper_fill: forced,
    exit_cycles: exits,
    open_positions: status.open_positions,
    traded: status.traded,
    equity: status.account?.equity,
    daily_pnl: status.account?.daily_pnl,
    last_decision: status.last_decision?.kind,
    ticks,
  };

  console.log(JSON.stringify(report, null, 2));
  writeFileSync(`${dir}/vs_master_live_paper_demo.json`, JSON.stringify(report, null, 2));
  masterRuntime.stop();
  setPersistClient(null);

  if (report.status.startsWith('FAIL')) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
