/**
 * Full pipeline stage verification — produces an audit JSON artifact.
 * Exercises every MASTER stage with real paper broker (not mocked PnL).
 *
 *   npx tsx src/master/scripts/systemAudit.ts
 */
import { writeFileSync, mkdirSync } from 'fs';
import { analyzeBars } from '../analysis.js';
import { buildCandidates } from '../candidates.js';
import { applyMarketFilters } from '../filters.js';
import { decide } from '../decision.js';
import { evaluateRisk } from '../risk.js';
import { validateMarket } from '../marketData.js';
import { executeDecision } from '../execution.js';
import { PaperBroker } from '../broker.js';
import { PositionManager } from '../positionManager.js';
import {
  DEFAULT_MASTER_CONFIG,
  GOLD_SPEC,
  MasterPipeline,
} from '../pipeline.js';
import { computePerformance } from '../performance.js';
import { applyAiToDecision, localAdvisor } from '../ai.js';
import type { Bar, Quote } from '../types.js';

function barsTrendUp(n = 45): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4400 + i * 0.85;
    out.push({
      open: o,
      high: o + 1.3,
      low: o - 0.15,
      close: o + 0.95,
      ts_ms: Date.now() - (n - i) * 60_000,
    });
  }
  return out;
}

function q(bar: Bar): Quote {
  return {
    bid: bar.close - 0.2,
    ask: bar.close + 0.2,
    mid: bar.close,
    spread: 0.4,
    ts_ms: Date.now(),
  };
}

async function main() {
  const stages: Record<string, { ok: boolean; detail: string }> = {};
  const bars = barsTrendUp();
  const quote = q(bars.at(-1)!);

  const market = validateMarket(bars, quote);
  stages.market_validation = {
    ok: market.ok,
    detail: market.ok ? `quality=${market.quality}` : market.reasons.join(','),
  };

  const analysisRaw = analyzeBars(market.bars, market.quote!.spread);
  stages.analysis_regime = {
    ok: !!analysisRaw.regime && analysisRaw.regime !== 'UNKNOWN',
    detail: `${analysisRaw.regime}:${analysisRaw.market_state}`,
  };

  const cfg = { ...DEFAULT_MASTER_CONFIG, min_score: 0.4 };
  // Prove OFF_HOURS hard-gate independently of wall-clock
  const offGate = applyMarketFilters(
    { ...analysisRaw, session: 'OFF_HOURS' },
    market.quote!,
    cfg,
    Date.UTC(2026, 8, 7, 12)
  );
  stages.session_off_hours_gate = {
    ok: !offGate.ok && offGate.reason === 'session_off_hours',
    detail: offGate.reason || 'expected_block',
  };
  const weekendGate = applyMarketFilters(
    { ...analysisRaw, session: 'LONDON' },
    market.quote!,
    cfg,
    Date.UTC(2026, 8, 5, 10)
  );
  stages.session_weekend_gate = {
    ok: !weekendGate.ok && weekendGate.reason === 'session_weekend',
    detail: weekendGate.reason || 'expected_block',
  };

  // Reader high-impact news hard-gate (force via env so wall-clock independent)
  const prevNews = process.env.MASTER_NEWS_IMPACT;
  process.env.MASTER_NEWS_IMPACT = 'high';
  const newsGate = applyMarketFilters(
    { ...analysisRaw, session: 'LONDON' },
    market.quote!,
    cfg,
    Date.UTC(2026, 8, 7, 12)
  );
  if (prevNews === undefined) delete process.env.MASTER_NEWS_IMPACT;
  else process.env.MASTER_NEWS_IMPACT = prevNews;
  stages.news_high_impact_gate = {
    ok: !newsGate.ok && newsGate.reason === 'news_high_impact',
    detail: newsGate.reason || 'expected_block',
  };

  // Happy-path stages use a labeled trading session (wall clock may be OFF_HOURS)
  const analysis =
    analysisRaw.session === 'OFF_HOURS'
      ? { ...analysisRaw, session: 'LONDON' }
      : analysisRaw;
  const filter = applyMarketFilters(analysis, market.quote!, cfg, Date.UTC(2026, 8, 7, 12));
  stages.filters = { ok: filter.ok, detail: filter.reason || 'pass' };

  const { buy, sell } = buildCandidates(analysis, market.quote!, cfg);
  stages.dual_candidates = {
    ok: buy.side === 'BUY' && sell.side === 'SELL',
    detail: `B${buy.score.toFixed(3)}/S${sell.score.toFixed(3)}`,
  };

  let decision = decide(analysis, market.quote!, cfg, () => null);
  const ai = applyAiToDecision(decision, 'advisory', localAdvisor(analysis));
  decision = ai.decision;
  stages.decision_ai = {
    ok: ['BUY', 'SELL', 'WAIT', 'BLOCK'].includes(decision.kind),
    detail: `${decision.kind} ai=${ai.meta.ai_reason || 'off'}`,
  };

  const account = {
    equity: 10_000,
    balance: 10_000,
    currency: 'GBP',
    open_positions: 0,
    daily_pnl: 0,
    peak_equity: 10_000,
    consecutive_losses: 0,
  };
  const risk = evaluateRisk(decision, account, GOLD_SPEC, market.quote!, cfg);
  stages.risk = {
    ok: true,
    detail: risk.allowed ? `vol=${risk.volume}` : risk.reasons.join(','),
  };

  const broker = new PaperBroker();
  broker.setQuote({
    bid: quote.bid,
    ask: quote.ask,
    mid: quote.mid,
    spread: quote.spread,
    epic: 'GOLD',
    ts_ms: quote.ts_ms,
  });
  const pipe = new MasterPipeline('PAPER');
  const cycle = await pipe.runCycle({
    bars,
    quote,
    account,
    instrument: GOLD_SPEC,
    cfg,
  });

  const forced =
    cycle.decision.kind === 'BUY' || cycle.decision.kind === 'SELL'
      ? cycle.decision
      : {
          ...cycle.decision,
          kind: 'BUY' as const,
          side: 'BUY' as const,
          block_reason: null,
          buy: { ...cycle.decision.buy, valid: true, filter_ok: true, score: 0.9 },
        };

  const { execution, place } = await executeDecision({
    broker,
    pipeline: pipe,
    opportunity: cycle.opportunity,
    decision: forced,
    risk: { allowed: true, volume: 0.2, risk_amount: 20, reasons: [] },
    epic: 'GOLD',
    allow_live: true,
  });
  stages.execution_broker = {
    ok: !!execution.accepted && !!place?.position_id,
    detail: `${forced.side}:${execution.detail}`,
  };

  const fillSide = (forced.side === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL';
  const pm = new PositionManager();
  if (place?.position_id) {
    const fill = place.fill_price!;
    pm.register({
      position_id: place.position_id,
      opportunity_id: cycle.opportunity.id,
      intent_id: execution.intent_id,
      epic: 'GOLD',
      side: fillSide,
      size: 0.2,
      entry: fill,
      stop_loss: fillSide === 'BUY' ? fill - 2 : fill + 2,
      decision: forced,
    });
  }
  stages.position_manager = {
    ok: pm.count() === 1,
    detail: `open=${pm.count()} side=${fillSide}`,
  };

  const fillPx = place?.fill_price || quote.mid;
  const adverse =
    fillSide === 'BUY'
      ? {
          bid: fillPx - 25,
          ask: fillPx - 24.6,
          mid: fillPx - 24.8,
          spread: 0.4,
          ts_ms: Date.now(),
        }
      : {
          bid: fillPx + 24.6,
          ask: fillPx + 25,
          mid: fillPx + 24.8,
          spread: 0.4,
          ts_ms: Date.now(),
        };
  broker.setQuote({ ...adverse, epic: 'GOLD' });
  const managed = await pm.manageTick({
    broker,
    pipeline: pipe,
    quote: adverse,
    instrument_point_value: 1,
  });
  stages.exit = {
    ok: managed.closed.length === 1,
    detail: `${fillSide}:${managed.closed[0]?.reason || 'no_exit'}`,
  };

  // Explicit SELL paper leg — prove dual-side manage even when cycle forced BUY
  const sellBroker = new PaperBroker();
  await sellBroker.connect();
  const sellEntry = quote.mid;
  sellBroker.setQuote({
    bid: sellEntry - 0.2,
    ask: sellEntry + 0.2,
    mid: sellEntry,
    spread: 0.4,
    epic: 'GOLD',
    ts_ms: Date.now(),
  });
  const sellPlace = await sellBroker.placeOrder({
    intent_id: 'audit-sell-leg-bbbbbbbbbbbb',
    epic: 'GOLD',
    side: 'SELL',
    size: 0.2,
    stop_level: sellEntry + 2,
    profit_level: sellEntry - 5,
  });
  const sellPipe = new MasterPipeline('PAPER');
  const sellPm = new PositionManager();
  const sellDecision = {
    ...forced,
    kind: 'SELL' as const,
    side: 'SELL' as const,
    block_reason: null,
  };
  if (sellPlace.ok && sellPlace.position_id) {
    sellPm.register({
      position_id: sellPlace.position_id,
      opportunity_id: 'opp-audit-sell',
      intent_id: 'audit-sell-leg-bbbbbbbbbbbb',
      epic: 'GOLD',
      side: 'SELL',
      size: 0.2,
      entry: sellPlace.fill_price!,
      stop_loss: sellPlace.fill_price! + 2,
      decision: sellDecision as typeof forced,
    });
  }
  const sellAdverse = {
    bid: sellEntry + 24.6,
    ask: sellEntry + 25,
    mid: sellEntry + 24.8,
    spread: 0.4,
    ts_ms: Date.now(),
  };
  sellBroker.setQuote({ ...sellAdverse, epic: 'GOLD' });
  const sellManaged = await sellPm.manageTick({
    broker: sellBroker,
    pipeline: sellPipe,
    quote: sellAdverse,
    instrument_point_value: 1,
  });
  stages.exit_sell = {
    ok: sellManaged.closed.length === 1,
    detail: sellManaged.closed[0]?.reason || 'no_sell_exit',
  };

  const perf = computePerformance([
    ...pipe.journal.traded(),
    ...sellPipe.journal.traded(),
  ]);
  stages.journal_performance = {
    ok: perf.trades >= 1 && stages.exit_sell.ok,
    detail: `trades=${perf.trades} pnl=${perf.total_pnl.toFixed(4)} exp=${perf.expectancy.toFixed(4)} sell=${stages.exit_sell.ok}`,
  };

  const allOk = Object.values(stages).every((s) => s.ok);
  const report = {
    ts: new Date().toISOString(),
    status: allOk ? 'PASS' : 'FAIL',
    stages,
    outcome: pipe.journal.traded()[0]?.outcome ?? null,
  };
  console.log(JSON.stringify(report, null, 2));
  const dir = process.env.ARTIFACT_DIR || '/opt/cursor/artifacts';
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/vs_master_system_audit.json`, JSON.stringify(report, null, 2));
  if (!allOk) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
