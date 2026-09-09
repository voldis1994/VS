/**
 * Relative spread model — Reader update_spread_model / evaluate_spread_filter.
 * z-score of current spread vs lookback history.
 * Also DualPersist / MemoryPersist / PG primary so a full file wipe heals.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  persistSpreadHistoryState,
  loadSpreadHistoryFromPersist,
} from './persist.js';

export type SpreadModelSnapshot = {
  history: number[];
  mean_spread: number;
  std_spread: number;
  median_spread: number;
  current_spread: number;
  relative_spread: number;
};

export type SpreadHistoryDiskPayload = {
  lookback: number;
  history: number[];
  ts: string;
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
  const combined = [
    ...history.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0),
    cur,
  ];
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

function stateDir(root?: string): string {
  return (
    root ||
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function spreadPath(root?: string): string {
  return join(stateDir(root), 'spread_history.json');
}

function normalizeHistory(raw: unknown, lookback: number): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .slice(-Math.max(1, lookback));
}

/** Rolling spread history for LIVE/PAPER runtime. */
export class SpreadHistory {
  private values: number[] = [];
  private persistEvery = 0;

  constructor(private readonly lookback = 20) {}

  push(spread: number): SpreadModelSnapshot {
    const snap = updateSpreadModel(this.values, spread, this.lookback);
    this.values = snap.history;
    // Persist every push once warm (≥3) so restart keeps relative-spread gate
    this.persistEvery += 1;
    if (this.values.length >= 3 && this.persistEvery % 1 === 0) {
      this.save();
    }
    return snap;
  }

  snapshot(currentSpread: number): SpreadModelSnapshot {
    return updateSpreadModel(this.values, currentSpread, this.lookback);
  }

  clear() {
    this.values = [];
  }

  /** Reader recover_spread_model_from_sensor — restore lookback across restart. */
  load(root?: string): number {
    try {
      const path = spreadPath(root);
      if (!existsSync(path)) return 0;
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        history?: unknown;
        lookback?: number;
      };
      const lb =
        typeof raw.lookback === 'number' && Number.isFinite(raw.lookback)
          ? Math.max(1, Math.floor(raw.lookback))
          : this.lookback;
      this.values = normalizeHistory(raw.history, lb);
      return this.values.length;
    } catch {
      return 0;
    }
  }

  save(root?: string): boolean {
    try {
      const dir = stateDir(root);
      mkdirSync(dir, { recursive: true });
      const payload: SpreadHistoryDiskPayload = {
        lookback: this.lookback,
        history: this.values.slice(-Math.max(1, this.lookback)),
        ts: new Date().toISOString(),
      };
      writeFileSync(spreadPath(root), JSON.stringify(payload));
      // DualPersist / MemoryPersist / PG primary — survive full file wipe
      void persistSpreadHistoryState({
        ...payload,
        saved_at_ms: Date.now(),
      }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  size(): number {
    return this.values.length;
  }
}

/**
 * When spread_history.json was wiped but DualPersist/PG primary still holds
 * the singleton payload, rewrite the sidecar before disk load.
 */
export async function hydrateSpreadHistoryFromPersist(
  root?: string
): Promise<{ restored: boolean; count: number }> {
  const dir = stateDir(root);
  const path = spreadPath(root);
  if (existsSync(path)) return { restored: false, count: 0 };
  try {
    const loaded = await loadSpreadHistoryFromPersist();
    if (!loaded || typeof loaded !== 'object') {
      return { restored: false, count: 0 };
    }
    const lookback =
      typeof loaded.lookback === 'number' && Number.isFinite(loaded.lookback)
        ? Math.max(1, Math.floor(loaded.lookback))
        : 20;
    const history = normalizeHistory(loaded.history, lookback);
    if (history.length < 3) return { restored: false, count: 0 };
    const payload: SpreadHistoryDiskPayload = {
      lookback,
      history,
      ts:
        typeof loaded.ts === 'string' && loaded.ts
          ? loaded.ts
          : new Date().toISOString(),
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(payload));
    return { restored: true, count: history.length };
  } catch {
    return { restored: false, count: 0 };
  }
}
