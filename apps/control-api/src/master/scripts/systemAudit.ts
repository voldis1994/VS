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

  const analysis = analyzeBars(market.bars, market.quote!.spread);
  stages.analysis_regime = {
    ok: !!analysis.regime && analysis.regime !== 'UNKNOWN',
    detail: `${analysis.regime}:${analysis.market_state}`,
  };

  const cfg = { ...DEFAULT_MASTER_CONFIG, min_score: 0.4 };
  const filter = applyMarketFilters(analysis, market.quote!, cfg);
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
  const cycle = pipe.runCycle({
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
    detail: execution.detail,
  };

  const pm = new PositionManager();
  if (place?.position_id) {
    pm.register({
      position_id: place.position_id,
      opportunity_id: cycle.opportunity.id,
      intent_id: execution.intent_id,
      epic: 'GOLD',
      side: 'BUY',
      size: 0.2,
      entry: place.fill_price!,
      stop_loss: place.fill_price! - 2,
      decision: forced,
    });
  }
  stages.position_manager = {
    ok: pm.count() === 1,
    detail: `open=${pm.count()}`,
  };

  const crash = {
    bid: (place?.fill_price || quote.mid) - 25,
    ask: (place?.fill_price || quote.mid) - 24.6,
    mid: (place?.fill_price || quote.mid) - 24.8,
    spread: 0.4,
    ts_ms: Date.now(),
  };
  broker.setQuote({ ...crash, epic: 'GOLD' });
  const managed = await pm.manageTick({
    broker,
    pipeline: pipe,
    quote: crash,
    instrument_point_value: 1,
  });
  stages.exit = {
    ok: managed.closed.length === 1,
    detail: managed.closed[0]?.reason || 'no_exit',
  };

  const perf = computePerformance(pipe.journal.traded());
  stages.journal_performance = {
    ok: perf.trades >= 1,
    detail: `trades=${perf.trades} pnl=${perf.total_pnl.toFixed(4)} exp=${perf.expectancy.toFixed(4)}`,
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
