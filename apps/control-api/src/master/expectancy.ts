/** Expectancy from historical setup outcomes — never invent probabilities. */
import type { ExpectancySnapshot, TradeOutcome } from './types.js';

export type SetupOutcome = {
  setup_key: string;
  pnl: number;
  costs: number;
};

export class ExpectancyStore {
  private readonly bySetup = new Map<string, SetupOutcome[]>();

  record(setup_key: string, outcome: TradeOutcome) {
    // Capital LIVE unproven closes must not poison setup EV / win rate
    if (outcome.pnl_proven === false) return;
    // outcome.pnl is already net of model fees (or broker-net). Fees here are
    // metadata for avg costs only — never re-subtracted from EV. Slippage is a
    // price distance, not money, so it is excluded from costs.
    const costs = Math.max(0, Number(outcome.fees) || 0);
    const list = this.bySetup.get(setup_key) || [];
    list.push({ setup_key, pnl: outcome.pnl, costs });
    this.bySetup.set(setup_key, list);
  }

  lookup(setup_key: string): ExpectancySnapshot | null {
    const list = this.bySetup.get(setup_key);
    if (!list?.length) return null;
    const wins = list.filter((x) => x.pnl > 0);
    const losses = list.filter((x) => x.pnl <= 0);
    const p_win = wins.length / list.length;
    const p_loss = 1 - p_win;
    const avg_win = wins.length ? wins.reduce((s, x) => s + x.pnl, 0) / wins.length : 0;
    const avg_loss = losses.length
      ? Math.abs(losses.reduce((s, x) => s + x.pnl, 0) / losses.length)
      : 0;
    const costs = list.reduce((s, x) => s + x.costs, 0) / list.length;
    // Mean net pnl ≡ p_win*avg_win − p_loss*avg_loss when avg_* use signed nets.
    // Do not subtract costs again (fees already in pnl).
    const ev = p_win * avg_win - p_loss * avg_loss;
    return {
      setup_key,
      samples: list.length,
      p_win,
      avg_win,
      avg_loss,
      costs,
      ev,
      positive: ev > 0,
    };
  }

  all(): ExpectancySnapshot[] {
    return [...this.bySetup.keys()]
      .map((k) => this.lookup(k))
      .filter((x): x is ExpectancySnapshot => !!x);
  }

  /** Restart hydration — rebuild from durable outcomes. */
  hydrate(rows: Array<{ setup_key: string; outcome: TradeOutcome }>) {
    this.bySetup.clear();
    for (const r of rows) {
      if (!r.setup_key || !r.outcome) continue;
      this.record(r.setup_key, r.outcome);
    }
  }
}
