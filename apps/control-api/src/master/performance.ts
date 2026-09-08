/** Performance analytics from journaled trade outcomes. */
import type { OpportunityRecord, TradeOutcome } from './types.js';

export type PerformanceReport = {
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  average_win: number;
  average_loss: number;
  expectancy: number;
  expectancy_r: number;
  profit_factor: number;
  max_drawdown: number;
  sharpe: number;
  sortino: number;
  recovery_factor: number;
  avg_mae: number;
  avg_mfe: number;
  longest_losing_streak: number;
  total_pnl: number;
  /** Sum of outcome.fees (model commission when mark-priced). */
  total_fees: number;
};

export function computePerformance(records: OpportunityRecord[]): PerformanceReport {
  const outcomes = records
    .map((r) => r.outcome)
    .filter((o): o is TradeOutcome => !!o);
  return fromOutcomes(outcomes);
}

export function fromOutcomes(outcomes: TradeOutcome[]): PerformanceReport {
  const empty: PerformanceReport = {
    trades: 0,
    wins: 0,
    losses: 0,
    win_rate: 0,
    average_win: 0,
    average_loss: 0,
    expectancy: 0,
    expectancy_r: 0,
    profit_factor: 0,
    max_drawdown: 0,
    sharpe: 0,
    sortino: 0,
    recovery_factor: 0,
    avg_mae: 0,
    avg_mfe: 0,
    longest_losing_streak: 0,
    total_pnl: 0,
    total_fees: 0,
  };
  // Unproven Capital closes (often pnl=0) must not score as flat losses
  const proven = outcomes.filter((o) => o.pnl_proven !== false);
  if (!proven.length) return empty;

  const wins = proven.filter((o) => o.pnl > 0);
  const losses = proven.filter((o) => o.pnl <= 0);
  const total_pnl = proven.reduce((s, o) => s + o.pnl, 0);
  const total_fees = proven.reduce((s, o) => s + Math.max(0, Number(o.fees) || 0), 0);
  const average_win = wins.length ? wins.reduce((s, o) => s + o.pnl, 0) / wins.length : 0;
  const average_loss = losses.length
    ? Math.abs(losses.reduce((s, o) => s + o.pnl, 0) / losses.length)
    : 0;
  const win_rate = wins.length / proven.length;
  const expectancy = win_rate * average_win - (1 - win_rate) * average_loss;
  const avg_r =
    proven.reduce((s, o) => s + o.r_multiple, 0) / proven.length;
  const grossWin = wins.reduce((s, o) => s + o.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, o) => s + o.pnl, 0));
  const profit_factor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  let equity = 0;
  let peak = 0;
  let max_drawdown = 0;
  let streak = 0;
  let longest = 0;
  const rets: number[] = [];
  for (const o of proven) {
    equity += o.pnl;
    rets.push(o.pnl);
    peak = Math.max(peak, equity);
    max_drawdown = Math.max(max_drawdown, peak - equity);
    if (o.pnl <= 0) {
      streak += 1;
      longest = Math.max(longest, streak);
    } else streak = 0;
  }

  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance =
    rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const std = Math.sqrt(variance);
  const downside = rets.filter((r) => r < 0);
  const downVar =
    downside.length > 1
      ? downside.reduce((s, r) => s + r ** 2, 0) / (downside.length - 1)
      : 0;
  const sharpe = std > 0 ? mean / std : 0;
  const sortino = downVar > 0 ? mean / Math.sqrt(downVar) : 0;
  const recovery_factor = max_drawdown > 0 ? total_pnl / max_drawdown : total_pnl > 0 ? Infinity : 0;

  return {
    trades: proven.length,
    wins: wins.length,
    losses: losses.length,
    win_rate,
    average_win,
    average_loss,
    expectancy,
    expectancy_r: avg_r,
    profit_factor: Number.isFinite(profit_factor) ? profit_factor : 0,
    max_drawdown,
    sharpe,
    sortino,
    recovery_factor: Number.isFinite(recovery_factor) ? recovery_factor : 0,
    avg_mae: proven.reduce((s, o) => s + o.mae, 0) / proven.length,
    avg_mfe: proven.reduce((s, o) => s + o.mfe, 0) / proven.length,
    longest_losing_streak: longest,
    total_pnl,
    total_fees,
  };
}

/** Monte Carlo drawdown / streak from reshuffled trade PnLs (empirical outcomes only). */
export function monteCarlo(
  pnls: number[],
  runs = 500
): {
  drawdown_p50: number;
  drawdown_p95: number;
  losing_streak_p95: number;
  equity_p05: number;
  equity_p50: number;
  equity_p95: number;
} {
  if (!pnls.length) {
    return {
      drawdown_p50: 0,
      drawdown_p95: 0,
      losing_streak_p95: 0,
      equity_p05: 0,
      equity_p50: 0,
      equity_p95: 0,
    };
  }
  const dds: number[] = [];
  const streaks: number[] = [];
  const finals: number[] = [];
  for (let r = 0; r < runs; r++) {
    const seq = shuffle(pnls);
    let eq = 0;
    let peak = 0;
    let dd = 0;
    let st = 0;
    let maxSt = 0;
    for (const p of seq) {
      eq += p;
      peak = Math.max(peak, eq);
      dd = Math.max(dd, peak - eq);
      if (p <= 0) {
        st += 1;
        maxSt = Math.max(maxSt, st);
      } else st = 0;
    }
    dds.push(dd);
    streaks.push(maxSt);
    finals.push(eq);
  }
  dds.sort((a, b) => a - b);
  streaks.sort((a, b) => a - b);
  finals.sort((a, b) => a - b);
  return {
    drawdown_p50: pct(dds, 0.5),
    drawdown_p95: pct(dds, 0.95),
    losing_streak_p95: pct(streaks, 0.95),
    equity_p05: pct(finals, 0.05),
    equity_p50: pct(finals, 0.5),
    equity_p95: pct(finals, 0.95),
  };
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function pct(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[i]!;
}
