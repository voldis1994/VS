/** Map client budget % of Capital equity → deal size (lots). */

export type BudgetSizeInput = {
  equity: number;
  budgetPct: number;
  mid: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
  /** Margin as fraction of notional (e.g. 0.05 = 5%). From Capital when available. */
  marginFactor?: number | null;
  category?: string | null;
};

export function clampBudgetPct(raw: number): number {
  if (!Number.isFinite(raw)) return 25;
  return Math.min(100, Math.max(1, Math.round(raw * 100) / 100));
}

export function defaultMarginFactor(category?: string | null): number {
  const c = String(category || '').toLowerCase();
  if (c === 'fx') return 0.033; // ~1:30
  if (c === 'crypto') return 0.5;
  if (c === 'indices') return 0.05;
  if (c === 'metals' || c === 'energy' || c === 'commodities') return 0.05;
  return 0.05;
}

function roundToStep(value: number, step: number): number {
  if (!(step > 0)) return value;
  const n = Math.round(value / step) * step;
  const decimals = String(step).includes('.') ? String(step).split('.')[1]!.length : 0;
  return Number(n.toFixed(Math.min(decimals, 8)));
}

/**
 * targetBudget = equity × pct/100 ≈ margin the client wants to commit.
 * size ≈ targetBudget / (mid × marginFactor), clamped to lot rules.
 */
export function sizeFromBudgetPct(input: BudgetSizeInput): {
  size: number;
  target_budget: number;
  margin_factor: number;
  detail: string;
} {
  const equity = Math.max(0, Number(input.equity) || 0);
  const pct = clampBudgetPct(input.budgetPct);
  const mid = Math.abs(Number(input.mid) || 0);
  const minLot = Math.max(Number(input.minLot) || 0.01, 0.0001);
  const maxLot = Math.max(Number(input.maxLot) || minLot, minLot);
  const lotStep = Math.max(Number(input.lotStep) || minLot, 0.0001);
  const factor =
    input.marginFactor != null && Number.isFinite(input.marginFactor) && input.marginFactor > 0
      ? Number(input.marginFactor)
      : defaultMarginFactor(input.category);

  const target = equity * (pct / 100);
  if (!(equity > 0) || !(mid > 0) || !(target > 0)) {
    return {
      size: minLot,
      target_budget: target,
      margin_factor: factor,
      detail: `fallback min lot ${minLot} (equity/mid missing)`,
    };
  }

  const marginPerUnit = mid * factor;
  let size = target / Math.max(marginPerUnit, 1e-9);
  size = roundToStep(size, lotStep);
  if (size < minLot) size = minLot;
  if (size > maxLot) size = maxLot;
  size = roundToStep(size, lotStep);
  if (size < minLot) size = minLot;

  return {
    size,
    target_budget: target,
    margin_factor: factor,
    detail: `equity ${equity.toFixed(2)} · ${pct}% → £${target.toFixed(2)} margin · factor ${(factor * 100).toFixed(1)}% · size ${size}`,
  };
}
