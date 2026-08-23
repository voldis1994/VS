export function roundLot(n: number, step: number): number {
  const s = step > 0 ? step : 0.01;
  return Math.round(n / s) * s;
}

export function fmtLot(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(4).replace(/\.?0+$/, '');
}

export function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(2);
}
