/**
 * REAL vs SYNTHETIC bar provenance.
 * Missing provenance is UNKNOWN — not REAL (#14).
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

/** Explicit REAL only — missing provenance is NOT real. */
export function isRealBar(b: { provenance?: DataProvenance } | null | undefined): boolean {
  return b?.provenance === 'REAL';
}

export function isSyntheticBar(b: { provenance?: DataProvenance } | null | undefined): boolean {
  return b?.provenance === 'SYNTHETIC';
}

export function hasKnownProvenance(
  b: { provenance?: DataProvenance } | null | undefined
): boolean {
  return b?.provenance === 'REAL' || b?.provenance === 'SYNTHETIC';
}

/** Structure/entry: only explicit REAL bars. */
export function realBarsOnly<T extends { provenance?: DataProvenance }>(
  bars: T[] | null | undefined
): T[] {
  return (bars ?? []).filter((b) => b.provenance === 'REAL');
}

export function syntheticRatio(bars: { provenance?: DataProvenance }[] | null | undefined): number {
  const all = bars ?? [];
  if (!all.length) return 1; // unknown series → treat as fully untrusted
  const known = all.filter((b) => b.provenance === 'REAL' || b.provenance === 'SYNTHETIC');
  if (!known.length) return 1;
  const syn = known.filter((b) => b.provenance === 'SYNTHETIC').length;
  const missing = all.length - known.length;
  return (syn + missing) / all.length;
}

/** Block LTF microstructure when lookback is synthetic / unknown-dominated. */
export function allowMicrostructureFromBars(
  bars: { provenance?: DataProvenance }[] | null | undefined,
  maxSyntheticRatio = 0.25
): { ok: boolean; reason: string } {
  const all = bars ?? [];
  if (!all.length) return { ok: false, reason: 'no bars' };
  const missing = all.filter((b) => b.provenance !== 'REAL' && b.provenance !== 'SYNTHETIC');
  if (missing.length) {
    return {
      ok: false,
      reason: `UNKNOWN provenance ${missing.length}/${all.length} — no microstructure`,
    };
  }
  const r = syntheticRatio(all);
  if (r > maxSyntheticRatio) {
    return {
      ok: false,
      reason: `SYNTHETIC data ${(r * 100).toFixed(0)}% — no microstructure / BOS / 10s entry`,
    };
  }
  return { ok: true, reason: 'real bars' };
}
