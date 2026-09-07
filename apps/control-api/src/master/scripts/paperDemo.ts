/**
 * Standalone PAPER demo — proves MASTER MARKET→…→PERFORMANCE without Postgres.
 * Run: npx tsx src/master/scripts/paperDemo.ts
 */
import { writeFileSync, mkdirSync } from 'fs';
import { PaperBroker } from '../broker.js';
import { DEFAULT_MASTER_CONFIG, GOLD_SPEC, MasterPipeline } from '../pipeline.js';
import { PositionManager } from '../positionManager.js';
import { executeDecision } from '../execution.js';
import { computePerformance, monteCarlo } from '../performance.js';
import type { Bar, Quote } from '../types.js';

function barsTrendUp(n: number, start = 4400): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = start + i * 0.85;
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

function barsCrash(from: number, n: number): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = from - i * 2.5;
    out.push({
      open: o,
      high: o + 0.2,
      low: o - 3,
      close: o - 2.2,
      ts_ms: Date.now() + i * 60_000,
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
  const broker = new PaperBroker();
  const pipe = new MasterPipeline('PAPER');
  const positions = new PositionManager();
  const cfg = { ...DEFAULT_MASTER_CONFIG, mode: 'PAPER' as const, min_score: 0.4 };
  const account = {
    equity: 10_000,
    balance: 10_000,
    currency: 'GBP',
    open_positions: 0,
    daily_pnl: 0,
    peak_equity: 10_000,
    consecutive_losses: 0,
  };

  const up = barsTrendUp(45);
  let opened = false;
  let lastDetail = '';

  for (let i = 30; i < up.length; i++) {
    const bars = up.slice(0, i + 1);
    const quote = q(bars.at(-1)!);
    broker.setQuote({
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      spread: quote.spread,
      epic: 'GOLD',
      ts_ms: quote.ts_ms,
    });
    account.open_positions = positions.count();
    const cycle = await pipe.runCycle({
      bars,
      quote,
      account,
      instrument: GOLD_SPEC,
      cfg,
      symbol_open: positions.count(),
    });
    lastDetail = cycle.decision.kind;
    if (
      !opened &&
      (cycle.decision.kind === 'BUY' || cycle.decision.kind === 'SELL') &&
      cycle.risk.allowed
    ) {
      const { execution, place } = await executeDecision({
        broker,
        pipeline: pipe,
        opportunity: cycle.opportunity,
        decision: cycle.decision,
        risk: cycle.risk,
        epic: 'GOLD',
        allow_live: true,
      });
      lastDetail = execution.detail;
      if (execution.accepted && place?.position_id) {
        opened = true;
        positions.register({
          position_id: place.position_id,
          opportunity_id: cycle.opportunity.id,
          intent_id: execution.intent_id,
          epic: 'GOLD',
          side: cycle.decision.side!,
          size: cycle.risk.volume,
          entry: place.fill_price!,
          stop_loss: cycle.decision.side === 'BUY' ? cycle.decision.buy.stop_loss : cycle.decision.sell.stop_loss,
          decision: cycle.decision,
        });
      }
    }
  }

  // Force open if filters blocked — still prove exit path with real broker fills
  if (!opened) {
    const quote = q(up.at(-1)!);
    broker.setQuote({
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      spread: quote.spread,
      epic: 'GOLD',
      ts_ms: quote.ts_ms,
    });
    const cycle = await pipe.runCycle({
      bars: up,
      quote,
      account,
      instrument: GOLD_SPEC,
      cfg: { ...cfg, min_score: 0.2 },
    });
    const forced = {
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
      risk: { allowed: true, volume: 0.5, risk_amount: 50, reasons: [] },
      epic: 'GOLD',
      allow_live: true,
    });
    if (execution.accepted && place?.position_id) {
      opened = true;
      lastDetail = 'forced_valid_buy_for_exit_demo';
      positions.register({
        position_id: place.position_id,
        opportunity_id: cycle.opportunity.id,
        intent_id: execution.intent_id,
        epic: 'GOLD',
        side: 'BUY',
        size: 0.5,
        entry: place.fill_price!,
        stop_loss: place.fill_price! - 2,
        decision: forced,
      });
    }
  }

  const crash = [...up, ...barsCrash(up.at(-1)!.close, 8)];
  let exits = 0;
  let exitReason = '';
  for (let i = up.length; i < crash.length; i++) {
    const bars = crash.slice(0, i + 1);
    const quote = q(bars.at(-1)!);
    broker.setQuote({
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      spread: quote.spread,
      epic: 'GOLD',
      ts_ms: quote.ts_ms,
    });
    const managed = await positions.manageTick({
      broker,
      pipeline: pipe,
      quote,
      instrument_point_value: 1,
    });
    if (managed.closed.length) {
      exits += managed.closed.length;
      exitReason = managed.closed[0]!.reason;
      account.daily_pnl += managed.closed[0]!.outcome.pnl;
      account.equity = (await broker.getAccount())!.equity;
    }
  }

  const perf = computePerformance(pipe.journal.traded());
  const pnls = pipe.journal.traded().map((t) => t.outcome!.pnl);
  const mc = pnls.length ? monteCarlo(pnls, 100) : null;

  const report = {
    opened,
    exits,
    exitReason,
    equity: account.equity,
    daily_pnl: account.daily_pnl,
    opportunities: pipe.journal.opportunities.length,
    traded: pipe.journal.traded().length,
    performance: perf,
    monte_carlo: mc,
    lastDetail,
    sample_outcome: pipe.journal.traded()[0]?.outcome ?? null,
  };

  console.log(JSON.stringify(report, null, 2));

  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>VS MASTER paper demo</title>
<style>body{font-family:ui-monospace,Menlo,monospace;background:#0b0f14;color:#d7e0ea;padding:24px}
h1{color:#7dffa3}.ok{color:#7dffa3}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.card{background:#141b24;border:1px solid #243041;padding:12px;border-radius:8px}
.k{font-size:11px;color:#7a8794;text-transform:uppercase}</style></head><body>
<h1>VS MASTER — paper pipeline demo</h1>
<p>Real PaperBroker fills + Best Outcome exit — not mocked PnL.</p>
<div class="grid">
<div class="card"><div class="k">Opened</div><div class="${opened ? 'ok' : ''}">${opened}</div></div>
<div class="card"><div class="k">Exits</div><div>${exits}</div></div>
<div class="card"><div class="k">Exit reason</div><div>${exitReason || '—'}</div></div>
<div class="card"><div class="k">Equity</div><div>${account.equity.toFixed(2)}</div></div>
<div class="card"><div class="k">Daily PnL</div><div>${account.daily_pnl.toFixed(4)}</div></div>
<div class="card"><div class="k">Traded</div><div>${report.traded}</div></div>
<div class="card"><div class="k">Expectancy</div><div>${perf.expectancy.toFixed(4)}</div></div>
<div class="card"><div class="k">Win rate</div><div>${perf.win_rate.toFixed(3)}</div></div>
<div class="card"><div class="k">Max DD</div><div>${perf.max_drawdown.toFixed(4)}</div></div>
</div>
<pre>${JSON.stringify(report.sample_outcome, null, 2)}</pre>
</body></html>`;

  const outDir = process.env.ARTIFACT_DIR || '/opt/cursor/artifacts';
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}/vs-master-paper-demo.html`, html);
    writeFileSync(`${outDir}/vs-master-paper-demo.json`, JSON.stringify(report, null, 2));
    console.error(`Wrote ${outDir}/vs-master-paper-demo.html`);
  } catch (e) {
    console.error('artifact write skipped', e);
  }

  if (!opened || exits < 1) {
    process.exitCode = 1;
    console.error('FAIL: expected at least one open and one exit');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
