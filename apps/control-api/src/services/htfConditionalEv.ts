/**
 * Conditional EV — expectancy by HTF state × setup × side.
 *
 * Separates descriptive `positive_sample` from `has_edge` (walk-forward /
 * out-of-sample confirmation). Measurement only — does not gate entries.
 */
import {
  bucketFromRows,
  type ExpectancyBucket,
  type ExpectancyTradeRow,
} from './tradeLedger.js';
import { htfExpectancyKey, type HTFMarketStateCompact } from './htfMarketState.js';

export type HtfTaggedTrade = ExpectancyTradeRow & {
  direction?: string | null;
  htf_structure?: string | null;
  htf_phase?: string | null;
  htf_bias?: string | null;
  htf_maturity?: string | null;
  htf_path_status?: string | null;
  htf_state?: HTFMarketStateCompact | null;
  /** ISO / epoch for walk-forward split */
  closed_at?: string | Date | number | null;
  thesis_direction_correct?: boolean | null;
};

export type ConditionalEvBucket = ExpectancyBucket & {
  structure: string;
  phase: string;
  setup: string;
  side: string;
  /**
   * Descriptive only: n >= min_trades and expectancy_pts > 0.
   * NOT a claim of statistical edge.
   */
  positive_sample: boolean;
  /**
   * True only when in-sample and out-of-sample (walk-forward) both show
   * positive expectancy with adequate sample sizes.
   */
  has_edge: boolean;
  /** True when OOS (or full sample if no split) shows negative expectancy at size */
  has_negative_edge: boolean;
  in_sample_trades: number;
  oos_trades: number;
  in_sample_expectancy_pts: number;
  oos_expectancy_pts: number;
  thesis_direction_hit_rate: number | null;
};

export type ConditionalEvReport = {
  window: string;
  since: string | null;
  min_trades: number;
  min_oos_trades: number;
  oos_fraction: number;
  sample_size: number;
  by_htf_setup_side: ConditionalEvBucket[];
  edge_setups: ConditionalEvBucket[];
  positive_samples: ConditionalEvBucket[];
  avoid_setups: ConditionalEvBucket[];
  by_htf_structure: ExpectancyBucket[];
  by_htf_phase: ExpectancyBucket[];
  by_path_status: ExpectancyBucket[];
};

const DEFAULT_MIN = 20;
const DEFAULT_MIN_OOS = 8;
const DEFAULT_OOS_FRAC = 0.3;

function sideOf(t: HtfTaggedTrade): string {
  const d = String(t.direction || '').toUpperCase();
  if (d === 'BUY' || d === 'LONG') return 'BUY';
  if (d === 'SELL' || d === 'SHORT') return 'SELL';
  return 'NONE';
}

function structureOf(t: HtfTaggedTrade): string {
  return String(
    t.htf_structure || t.htf_state?.structure || 'UNKNOWN'
  ).toUpperCase();
}

function phaseOf(t: HtfTaggedTrade): string {
  return String(t.htf_phase || t.htf_state?.phase || 'UNKNOWN').toUpperCase();
}

function pathOf(t: HtfTaggedTrade): string {
  return String(
    t.htf_path_status || t.htf_state?.path_status || 'UNKNOWN'
  ).toUpperCase();
}

function closedAtMs(t: HtfTaggedTrade): number {
  const v = t.closed_at;
  if (v == null) return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const tms = Date.parse(String(v));
  return Number.isFinite(tms) ? tms : 0;
}

function walkForwardSplit(
  rows: HtfTaggedTrade[],
  oosFraction: number
): { is: HtfTaggedTrade[]; oos: HtfTaggedTrade[] } {
  if (rows.length < 2) return { is: rows, oos: [] };
  const sorted = [...rows].sort((a, b) => closedAtMs(a) - closedAtMs(b));
  // If no timestamps, split by index order as proxy
  const cut = Math.max(1, Math.floor(sorted.length * (1 - oosFraction)));
  return { is: sorted.slice(0, cut), oos: sorted.slice(cut) };
}

function directionHitRate(rows: HtfTaggedTrade[]): number | null {
  const scored = rows.filter((r) => typeof r.thesis_direction_correct === 'boolean');
  if (!scored.length) return null;
  const hits = scored.filter((r) => r.thesis_direction_correct === true).length;
  return hits / scored.length;
}

function toConditional(
  key: string,
  rows: HtfTaggedTrade[],
  opts: { min_trades: number; min_oos_trades: number; oos_fraction: number }
): ConditionalEvBucket {
  const parts = key.split('|');
  const structure = parts[0] || 'UNKNOWN';
  const phase = parts[1] || 'UNKNOWN';
  const setup = parts[2] || 'NONE';
  const side = parts[3] || 'NONE';
  const base = bucketFromRows(key, rows);
  const { is, oos } = walkForwardSplit(rows, opts.oos_fraction);
  const isBucket = bucketFromRows(`${key}|IS`, is);
  const oosBucket = bucketFromRows(`${key}|OOS`, oos);
  const positive_sample =
    base.trades >= opts.min_trades && base.expectancy_pts > 0;
  const has_edge =
    is.length >= opts.min_trades &&
    oos.length >= opts.min_oos_trades &&
    isBucket.expectancy_pts > 0 &&
    oosBucket.expectancy_pts > 0;
  const has_negative_edge =
    (oos.length >= opts.min_oos_trades && oosBucket.expectancy_pts < 0) ||
    (oos.length < opts.min_oos_trades &&
      base.trades >= opts.min_trades &&
      base.expectancy_pts < 0);

  return {
    ...base,
    structure,
    phase,
    setup,
    side,
    positive_sample,
    has_edge,
    has_negative_edge,
    in_sample_trades: is.length,
    oos_trades: oos.length,
    in_sample_expectancy_pts: isBucket.expectancy_pts,
    oos_expectancy_pts: oosBucket.expectancy_pts,
    thesis_direction_hit_rate: directionHitRate(rows),
  };
}

export function computeConditionalEv(
  trades: HtfTaggedTrade[],
  opts?: {
    window?: string;
    since?: string | null;
    min_trades?: number;
    min_oos_trades?: number;
    oos_fraction?: number;
  }
): ConditionalEvReport {
  const minTrades = Math.max(1, opts?.min_trades ?? DEFAULT_MIN);
  const minOos = Math.max(1, opts?.min_oos_trades ?? DEFAULT_MIN_OOS);
  const oosFrac = Math.min(0.5, Math.max(0.15, opts?.oos_fraction ?? DEFAULT_OOS_FRAC));
  const byCombo = new Map<string, HtfTaggedTrade[]>();
  const byStructure = new Map<string, HtfTaggedTrade[]>();
  const byPhase = new Map<string, HtfTaggedTrade[]>();
  const byPath = new Map<string, HtfTaggedTrade[]>();

  for (const t of trades) {
    const structure = structureOf(t);
    const phase = phaseOf(t);
    const setup = String(t.setup_type || 'NONE').toUpperCase();
    const side = sideOf(t);
    const key = htfExpectancyKey({ structure, phase, setup, side });
    push(byCombo, key, t);
    push(byStructure, structure, t);
    push(byPhase, phase, t);
    push(byPath, pathOf(t), t);
  }

  const combos = [...byCombo.entries()]
    .map(([k, rows]) =>
      toConditional(k, rows, {
        min_trades: minTrades,
        min_oos_trades: minOos,
        oos_fraction: oosFrac,
      })
    )
    .sort((a, b) => b.expectancy_pts - a.expectancy_pts);

  return {
    window: opts?.window || 'all',
    since: opts?.since ?? null,
    min_trades: minTrades,
    min_oos_trades: minOos,
    oos_fraction: oosFrac,
    sample_size: trades.length,
    by_htf_setup_side: combos,
    edge_setups: combos.filter((c) => c.has_edge),
    positive_samples: combos.filter((c) => c.positive_sample),
    avoid_setups: combos.filter((c) => c.has_negative_edge),
    by_htf_structure: mapBuckets(byStructure),
    by_htf_phase: mapBuckets(byPhase),
    by_path_status: mapBuckets(byPath),
  };
}

function push(m: Map<string, HtfTaggedTrade[]>, key: string, t: HtfTaggedTrade) {
  const list = m.get(key);
  if (list) list.push(t);
  else m.set(key, [t]);
}

function mapBuckets(m: Map<string, HtfTaggedTrade[]>): ExpectancyBucket[] {
  return [...m.entries()]
    .map(([k, rows]) => bucketFromRows(k, rows))
    .sort((a, b) => b.sum_pnl_pts - a.sum_pnl_pts);
}

export function conditionalEvFor(
  report: ConditionalEvReport,
  input: {
    structure?: string | null;
    phase?: string | null;
    setup?: string | null;
    side?: string | null;
  }
): ConditionalEvBucket | null {
  const key = htfExpectancyKey(input);
  return report.by_htf_setup_side.find((b) => b.key === key) ?? null;
}
