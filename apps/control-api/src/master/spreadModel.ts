/**
 * Relative spread model — Reader update_spread_model / evaluate_spread_filter.
 * z-score of current spread vs lookback history.
 */
export type SpreadModelSnapshot = {
  history: number[];
  mean_spread: number;
  std_spread: number;
  median_spread: number;
  current_spread: number;
  relative_spread: number;
};

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function pstdev(values: number[], mean: number): number {
  if (values.length <= 1) return 0;
  const varSum = values.reduce((acc, v) => acc + (v - mean) ** 2, 0);
  return Math.sqrt(varSum / values.length);
}

/** Append current spread and compute z-score relative to lookback window. */
export function updateSpreadModel(
  history: number[],
  currentSpread: number,
  lookbackBars = 20
): SpreadModelSnapshot {
  const lookback = Math.max(1, lookbackBars);
  const cur = Math.max(0, Number(currentSpread) || 0);
  const combined = [...history.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0), cur];
  const trimmed = combined.slice(-lookback);
  const mean = trimmed.reduce((s, n) => s + n, 0) / trimmed.length;
  const std = pstdev(trimmed, mean);
  let relative = 0;
  if (std > 0) relative = (cur - mean) / std;
  else if (trimmed.length < 2) relative = 1.0;
  else relative = 0;

  return {
    history: trimmed,
    mean_spread: mean,
    std_spread: std,
    median_spread: median(trimmed),
    current_spread: cur,
    relative_spread: relative,
  };
}

export function relativeSpreadAcceptable(
  relativeSpread: number,
  threshold: number
): boolean {
  if (!(threshold > 0)) return true;
  return relativeSpread <= threshold;
}

/** Rolling spread history for LIVE/PAPER runtime. */
export class SpreadHistory {
  private values: number[] = [];

  constructor(private readonly lookback = 20) {}

  push(spread: number): SpreadModelSnapshot {
    const snap = updateSpreadModel(this.values, spread, this.lookback);
    this.values = snap.history;
    return snap;
  }

  snapshot(currentSpread: number): SpreadModelSnapshot {
    return updateSpreadModel(this.values, currentSpread, this.lookback);
  }

  clear() {
    this.values = [];
  }
}
