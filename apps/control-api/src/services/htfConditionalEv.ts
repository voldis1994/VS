/**
 * Conditional EV — expectancy by HTF state × setup × side.
 *
 * Lets VS measure which setups have edge in a given HTF structure/phase.
 * Measurement only — does not gate entries by itself.
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
};

export type ConditionalEvBucket = ExpectancyBucket & {
  structure: string;
  phase: string;
  setup: string;
  side: string;
  /** True when sample is large enough and expectancy_pts > 0 */
  has_edge: boolean;
  /** True when sample is large enough and expectancy_pts < 0 */
  has_negative_edge: boolean;
};

export type ConditionalEvReport = {
  window: string;
  since: string | null;
  min_trades: number;
  sample_size: number;
  by_htf_setup_side: ConditionalEvBucket[];
  /** Subset with has_edge */
  edge_setups: ConditionalEvBucket[];
  /** Subset with has_negative_edge */
  avoid_setups: ConditionalEvBucket[];
  by_htf_structure: ExpectancyBucket[];
  by_htf_phase: ExpectancyBucket[];
  by_path_status: ExpectancyBucket[];
};

const DEFAULT_MIN = 5;

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

function toConditional(
  key: string,
  rows: HtfTaggedTrade[],
  minTrades: number
): ConditionalEvBucket {
  const parts = key.split('|');
  const structure = parts[0] || 'UNKNOWN';
  const phase = parts[1] || 'UNKNOWN';
  const setup = parts[2] || 'NONE';
  const side = parts[3] || 'NONE';
  const base = bucketFromRows(key, rows);
  const enough = base.trades >= minTrades;
  return {
    ...base,
    structure,
    phase,
    setup,
    side,
    has_edge: enough && base.expectancy_pts > 0,
    has_negative_edge: enough && base.expectancy_pts < 0,
  };
}

/**
 * Pure aggregator — unit-tested without Postgres.
 */
export function computeConditionalEv(
  trades: HtfTaggedTrade[],
  opts?: {
    window?: string;
    since?: string | null;
    min_trades?: number;
  }
): ConditionalEvReport {
  const minTrades = Math.max(1, opts?.min_trades ?? DEFAULT_MIN);
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
    .map(([k, rows]) => toConditional(k, rows, minTrades))
    .sort((a, b) => b.expectancy_pts - a.expectancy_pts);

  return {
    window: opts?.window || 'all',
    since: opts?.since ?? null,
    min_trades: minTrades,
    sample_size: trades.length,
    by_htf_setup_side: combos,
    edge_setups: combos.filter((c) => c.has_edge),
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

/**
 * Lookup helper — does this HTF×setup×side historically show edge?
 * Returns null when under-sampled (never blocks entry by itself).
 */
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
