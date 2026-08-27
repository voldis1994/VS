/**
 * REAL vs SYNTHETIC bar provenance.
 * Synthetic (e.g. 1m → 6× identical 10s) must not drive microstructure / BOS / entry.
 */

export type DataProvenance = 'REAL' | 'SYNTHETIC';

export type QualifiedBar = {
  open_time_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  ticks: number;
  provenance: DataProvenance;
  source_tf?: '10s' | '1m' | '5m' | '15m' | '1H' | '4H' | 'SECOND' | 'MINUTE';
};

export function isRealBar(b: { provenance?: DataProvenance } | null | undefined): boolean {
  return !b || b.provenance !== 'SYNTHETIC';
}

export function isSyntheticBar(b: { provenance?: DataProvenance } | null | undefined): boolean {
  return b?.provenance === 'SYNTHETIC';
}

/** Reject structure/entry triggers when series is synthetic-dominated. */
export function realBarsOnly<T extends { provenance?: DataProvenance }>(
  bars: T[] | null | undefined
): T[] {
  return (bars ?? []).filter((b) => b.provenance !== 'SYNTHETIC');
}

export function syntheticRatio(bars: { provenance?: DataProvenance }[] | null | undefined): number {
  const all = bars ?? [];
  if (!all.length) return 0;
  const syn = all.filter((b) => b.provenance === 'SYNTHETIC').length;
  return syn / all.length;
}

/** Block LTF microstructure when lookback is mostly synthetic. */
export function allowMicrostructureFromBars(
  bars: { provenance?: DataProvenance }[] | null | undefined,
  maxSyntheticRatio = 0.25
): { ok: boolean; reason: string } {
  const r = syntheticRatio(bars);
  if (r > maxSyntheticRatio) {
    return {
      ok: false,
      reason: `SYNTHETIC data ${(r * 100).toFixed(0)}% — no microstructure / BOS / 10s entry`,
    };
  }
  return { ok: true, reason: 'real bars' };
}
