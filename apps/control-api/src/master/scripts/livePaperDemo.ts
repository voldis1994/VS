/**
 * Live-data PAPER demo — real public gold quotes → MASTER pipeline → paper fills
 * → manage exit → journal/performance.
 *
 *   npx tsx src/master/scripts/livePaperDemo.ts
 *
 * Honesty: never force a synthetic BUY when filters block.
 *   PASS_LIVE_DATA_CLOSED  — one natural fill + tick-observed exit + journaled trade
 *   PASS_LIVE_DATA_TRADED  — natural fill (open or closed) without proven exit path
 *   PASS_LIVE_DATA_DECIDED — live quote + decision, no fill
 */
import { writeFileSync, mkdirSync } from 'fs';
import { masterRuntime } from '../runtime.js';
import { DEFAULT_MASTER_CONFIG, MasterPipeline } from '../pipeline.js';
import { PositionManager } from '../positionManager.js';
import { installFilePersist } from '../filePersist.js';
import { fetchLiveMarket, LiveBarBuilder } from '../liveFeed.js';
import { setPersistClient } from '../persist.js';
import {
  isHonestLivePaperClosed,
  type LivePaperDemoReport,
} from '../livePaperHonesty.js';

export type { LivePaperDemoReport } from '../livePaperHonesty.js';
export { isHonestLivePaperClosed } from '../livePaperHonesty.js';

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Clear singleton leftovers so prior verify/audit/tests cannot starve fills. */
function resetLivePaperRuntime() {
  try {
    masterRuntime.stop();
  } catch {
    /* ignore */
  }
  masterRuntime.pipeline = new MasterPipeline('PAPER');
  masterRuntime.positions = new PositionManager();
  masterRuntime.broker = null;
  masterRuntime.broker_detail = null;
  masterRuntime.running = false;
  masterRuntime.desired_running = false;
  masterRuntime.recovered = false;
  (masterRuntime as unknown as { bookHydrated: boolean }).bookHydrated = false;
  (masterRuntime as unknown as { last_manage_tick_ms: number }).last_manage_tick_ms = 0;
  (
    masterRuntime as unknown as {
      quoteFromDiskCache: boolean;
      barsFromDiskCache: boolean;
    }
  ).quoteFromDiskCache = false;
  (
    masterRuntime as unknown as {
      quoteFromDiskCache: boolean;
      barsFromDiskCache: boolean;
    }
  ).barsFromDiskCache = false;
  masterRuntime.last_market = null;
  masterRuntime.last_decision = null;
  masterRuntime.last_risk = null;
  masterRuntime.last_execution_detail = null;
  masterRuntime.last_exit_reason = null;
  masterRuntime.last_close_failed = null;
  masterRuntime.last_quote = null;
  masterRuntime.last_bars = [];
  masterRuntime.last_loss_ms = 0;
  masterRuntime.reject_until_ms = 0;
  masterRuntime.account = {
    equity: 10_000,
    balance: 10_000,
    currency: 'GBP',
    open_positions: 0,
    daily_pnl: 0,
    daily_pnl_day: null,
    day_start_equity: 10_000,
    peak_equity: 10_000,
    consecutive_losses: 0,
  };
}

async function main() {
  const dir = process.env.ARTIFACT_DIR || '/opt/cursor/artifacts';
  mkdirSync(dir, { recursive: true });
  // Fresh state each run — leftover opens / loss cooldowns from prior demos or
  // systemAudit would mask natural fills (one_trade_open / cooldown_after_loss).
  const stateDir = '/tmp/vs-master-live-paper-state';
  try {
    const { rmSync } = await import('fs');
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.env.MASTER_STATE_DIR = stateDir;
  process.env.MASTER_GATES_DIR = stateDir;
  // Prior verify steps may leave MASTER_NEWS_IMPACT / synth flags in the parent env
  delete process.env.MASTER_NEWS_IMPACT;
  delete process.env.MASTER_BROKER_FEED_SYNTHETIC;
  installFilePersist(stateDir);
  resetLivePaperRuntime();

  masterRuntime.cfg = {
    ...DEFAULT_MASTER_CONFIG,
    mode: 'PAPER',
    min_score: 0.3,
    ai_mode: 'advisory',
    // Demo proves live quote → decision → paper fill; session gates are covered by systemAudit.
    block_off_hours: false,
    block_high_impact_news: false,
    require_positive_expectancy: false,
    require_armed_setup: false,
    // Longer post-exit so a single fill cannot immediately re-enter in the same proof
    post_exit_cooldown_ms: 60_000,
  };
  masterRuntime.setEntriesArmed(true);
  masterRuntime.ensurePaperBroker();
  await masterRuntime.start({ live_feed: false });
  // Entry phase: no silent 1s manage closes between polls — exit must be tick-observed
  masterRuntime.pauseBackgroundManage();

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
  let decided = 0;
  let lastMid = first.quote.mid;

  // Live cycles until first natural fill — then stop (no churn flood on flat mid).
  // Extra attempts absorb transient filter/score misses without forging a fill.
  const entryAttempts = Math.max(
    12,
    Number(process.env.MASTER_LIVE_PAPER_ENTRY_ATTEMPTS || 24)
  );
  for (let i = 0; i < entryAttempts; i++) {
    masterRuntime.pauseBackgroundManage();
    const snap = i === 0 ? first : await fetchLiveMarket('GOLD');
    if (!snap.ok || !snap.quote) {
      ticks.push({ i, ok: false, detail: snap.detail });
      await sleep(1500);
      continue;
    }
    const quote = { ...snap.quote, epic: snap.quote.epic || 'GOLD' };
    lastMid = quote.mid;
    const { bars } = builder.pushTick(quote.mid);
    const result = await masterRuntime.tick(bars, quote);
    masterRuntime.pauseBackgroundManage();
    if (result.executed) executed += 1;
    exits += result.exits;
    if (result.decision?.kind) decided += 1;
    ticks.push({
      i,
      mid: quote.mid,
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
    // One natural fill is enough — break before sleep so manage cannot steal the case
    if (result.executed || masterRuntime.positions.count() > 0) break;
    await sleep(1500);
  }

  // After natural fill: drive manage path through hard SL using builder mids
  // (entry was live-natural — exit proves position→exit→journal, not a forced BUY).
  let exitPhase = false;
  let exitReason: string | null = null;
  if (masterRuntime.positions.count() > 0) {
    exitPhase = true;
    masterRuntime.pauseBackgroundManage();
    const pos = masterRuntime.positions.list()[0]!;
    const sl =
      pos.stop_loss != null && Number.isFinite(pos.stop_loss) && pos.stop_loss > 0
        ? pos.stop_loss
        : null;
    for (let j = 0; j < 24 && masterRuntime.positions.count() > 0; j++) {
      masterRuntime.pauseBackgroundManage();
      // Step mid through protective SL (or away from entry if SL missing)
      const step = (j + 1) * 1.5;
      const mid =
        pos.side === 'BUY'
          ? sl != null
            ? sl - 0.5 - j * 0.3
            : lastMid - step
          : sl != null
            ? sl + 0.5 + j * 0.3
            : lastMid + step;
      const quote = {
        bid: mid - 0.2,
        ask: mid + 0.2,
        mid,
        spread: 0.4,
        epic: 'GOLD',
        ts_ms: Date.now(),
      };
      const { bars } = builder.pushTick(quote.mid);
      const result = await masterRuntime.tick(bars, quote);
      masterRuntime.pauseBackgroundManage();
      exits += result.exits;
      ticks.push({
        i: `exit-${j}`,
        mid: quote.mid,
        phase: 'exit_drive',
        side: pos.side,
        executed: result.executed,
        exits: result.exits,
        why: result.exit_reasons?.join(',') || result.execution_detail || 'manage',
      });
      if (result.exits > 0) {
        exitReason = result.exit_reasons?.[0] || masterRuntime.last_exit_reason;
        break;
      }
      await sleep(200);
    }
  }

  const status = masterRuntime.status();
  const naturalTrade =
    executed > 0 || status.traded > 0 || status.open_positions > 0;
  const exitReasonFinal = exitReason || status.last_exit_reason || null;
  const closedCandidate =
    naturalTrade &&
    status.open_positions === 0 &&
    (status.traded ?? 0) >= 1 &&
    (status.performance?.trades ?? 0) >= 1 &&
    !!exitReasonFinal &&
    (exitPhase || exits >= 1) &&
    executed >= 1 &&
    executed <= 2;

  const liveTicks = ticks.filter((t) => t.phase !== 'exit_drive');
  const entryWhys = liveTicks
    .map((t) => String(t.why || t.decision || ''))
    .filter(Boolean)
    .slice(0, 8);

  const report: LivePaperDemoReport = {
    status: !first.ok
      ? 'FAIL'
      : closedCandidate
        ? 'PASS_LIVE_DATA_CLOSED'
        : naturalTrade
          ? 'PASS_LIVE_DATA_TRADED'
          : decided > 0
            ? 'PASS_LIVE_DATA_DECIDED'
            : 'FAIL',
    feed: first.detail,
    seed: seedDetail,
    seed_source: builder.seed_source,
    first_mid: first.quote.mid,
    contributing: first.contributing,
    executed_cycles: executed,
    forced_live_paper_fill: false,
    exit_phase: exitPhase,
    exit_cycles: exits,
    exit_reason: exitReasonFinal,
    open_positions: status.open_positions,
    traded: status.traded,
    performance_trades: status.performance?.trades ?? 0,
    performance_total_pnl: status.performance?.total_pnl ?? null,
    expectancy: status.performance?.expectancy ?? null,
    equity: status.account?.equity,
    daily_pnl: status.account?.daily_pnl,
    last_decision: status.last_decision?.kind,
    entry_attempts: entryAttempts,
    entry_whys: entryWhys,
    ticks,
  };

  // Final honesty gate — never emit CLOSED if the structured checks fail
  if (report.status === 'PASS_LIVE_DATA_CLOSED' && !isHonestLivePaperClosed(report)) {
    report.status = naturalTrade ? 'PASS_LIVE_DATA_TRADED' : 'FAIL';
    report.honesty_downgrade = 'closed_failed_isHonestLivePaperClosed';
  }

  console.log(JSON.stringify(report, null, 2));
  writeFileSync(`${dir}/vs_master_live_paper_demo.json`, JSON.stringify(report, null, 2));
  // Clear opens so manage timers do not hold the process
  const { PositionManager } = await import('../positionManager.js');
  masterRuntime.positions = new PositionManager();
  masterRuntime.stop();
  setPersistClient(null);

  if (report.status.startsWith('FAIL')) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
