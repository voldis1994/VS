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

export type DeskExpectancySlice = {
  source: 'setup' | 'move' | 'none';
  setups: number;
  samples: number;
  positive_setups: number;
  /** Sample-weighted mean EV across setup keys in this desk bucket. */
  avg_ev: number;
};

/**
 * Roll up ExpectancyStore snapshots by desk confirm suffix on setupKey
 * (`…|setup` / `…|move` / `…|none`). Legacy keys without suffix → none.
 */
export function expectancyByDeskSource(
  snaps: ExpectancySnapshot[]
): DeskExpectancySlice[] {
  const buckets: Record<'setup' | 'move' | 'none', ExpectancySnapshot[]> = {
    setup: [],
    move: [],
    none: [],
  };
  for (const s of snaps) {
    const parts = String(s.setup_key || '').split('|');
    const last = parts[parts.length - 1] || '';
    const src: 'setup' | 'move' | 'none' =
      last === 'setup' || last === 'move' ? last : 'none';
    buckets[src].push(s);
  }
  return (['setup', 'move', 'none'] as const).map((source) => {
    const list = buckets[source];
    const samples = list.reduce((n, x) => n + x.samples, 0);
    const avg_ev = samples
      ? list.reduce((n, x) => n + x.ev * x.samples, 0) / samples
      : 0;
    return {
      source,
      setups: list.length,
      samples,
      positive_setups: list.filter((x) => x.positive).length,
      avg_ev,
    };
  });
}
