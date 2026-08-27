/**
 * Universal risk-based position sizing (#31).
 * equity → risk/trade → structural stop distance → instrument value → quantity.
 * Critical UNKNOWN → null (NO TRADE).
 */

import type { InstrumentMeta } from './volatilityNorm.js';
import { instrumentFloor } from './volatilityNorm.js';

export type PositionSizeInput = {
  equity: number;
  /** Fraction of equity to risk per trade (e.g. 0.01 = 1%) */
  risk_per_trade: number;
  entry: number;
  structural_sl: number;
  side: 'BUY' | 'SELL';
  /** Value per 1.0 price move per 1.0 quantity (instrument contract value) */
  value_per_point?: number | null;
  meta?: InstrumentMeta | null;
  lot_step?: number | null;
  min_lot?: number | null;
  max_lot?: number | null;
};

export type PositionSizeResult = {
  ok: boolean;
  quantity: number | null;
  risk_cash: number | null;
  stop_distance: number | null;
  detail: string;
};

export function computeRiskPositionSize(input: PositionSizeInput): PositionSizeResult {
  if (!(input.equity > 0) || !(input.risk_per_trade > 0 && input.risk_per_trade <= 0.1)) {
    return { ok: false, quantity: null, risk_cash: null, stop_distance: null, detail: 'INVALID equity/risk' };
  }
  if (!(input.entry > 0) || !Number.isFinite(input.structural_sl)) {
    return { ok: false, quantity: null, risk_cash: null, stop_distance: null, detail: 'INVALID entry/SL' };
  }

  const stopDist =
    input.side === 'BUY'
      ? input.entry - input.structural_sl
      : input.structural_sl - input.entry;
  if (!(stopDist > 0)) {
    return {
      ok: false,
      quantity: null,
      risk_cash: null,
      stop_distance: null,
      detail: 'INVALID stop distance',
    };
  }

  const tick = instrumentFloor(input.meta ?? null);
  const vpp = input.value_per_point;
  if ((vpp == null || !(vpp > 0)) && tick == null) {
    return {
      ok: false,
      quantity: null,
      risk_cash: input.equity * input.risk_per_trade,
      stop_distance: stopDist,
      detail: 'UNKNOWN instrument value/tick — cannot size',
    };
  }

  const riskCash = input.equity * input.risk_per_trade;
  // Prefer explicit value_per_point; else approximate 1 unit = 1 currency per point
  const valuePerPoint = vpp != null && vpp > 0 ? vpp : 1;
  const rawQty = riskCash / (stopDist * valuePerPoint);
  if (!(rawQty > 0) || !Number.isFinite(rawQty)) {
    return {
      ok: false,
      quantity: null,
      risk_cash: riskCash,
      stop_distance: stopDist,
      detail: 'computed quantity invalid',
    };
  }

  const step = input.lot_step != null && input.lot_step > 0 ? input.lot_step : tick ?? 0.01;
  const minLot = input.min_lot != null && input.min_lot > 0 ? input.min_lot : step;
  const maxLot = input.max_lot != null && input.max_lot > 0 ? input.max_lot : Infinity;

  let qty = Math.floor(rawQty / step) * step;
  if (qty < minLot) {
    return {
      ok: false,
      quantity: null,
      risk_cash: riskCash,
      stop_distance: stopDist,
      detail: `qty ${rawQty.toFixed(6)} < min_lot ${minLot}`,
    };
  }
  if (qty > maxLot) qty = maxLot;

  return {
    ok: true,
    quantity: qty,
    risk_cash: riskCash,
    stop_distance: stopDist,
    detail: `size ${qty} · risk ${riskCash.toFixed(2)} · stopDist ${stopDist.toFixed(6)}`,
  };
}
