/**
 * Reader risk.sl_tp — hard SL/TP validation before ALLOW.
 * Distances use instrument.point as pip size.
 */

export type SlTpValidationResult = {
  allowed: boolean;
  reason: string | null;
};

export function computeStopLossDistancePips(
  entry: number,
  stopLoss: number,
  pip: number
): number {
  if (!(pip > 0)) return Number.POSITIVE_INFINITY;
  return Math.abs(entry - stopLoss) / pip;
}

export function validateBuyStopLossPlacement(
  entry: number,
  stopLoss: number,
  swingLow: number
): string | null {
  if (!(stopLoss < entry)) return 'buy_sl_not_below_entry';
  if (swingLow > 0 && !(stopLoss < swingLow)) return 'buy_sl_not_below_swing_low';
  return null;
}

export function validateSellStopLossPlacement(
  entry: number,
  stopLoss: number,
  swingHigh: number
): string | null {
  if (!(stopLoss > entry)) return 'sell_sl_not_above_entry';
  if (swingHigh > 0 && !(stopLoss > swingHigh)) return 'sell_sl_not_above_swing_high';
  return null;
}

export function validateStopLossWithinMaxPips(
  entry: number,
  stopLoss: number,
  pip: number,
  maxStopLossPips: number
): string | null {
  if (!(maxStopLossPips > 0)) return null; // 0 = disabled
  if (!(pip > 0)) return 'invalid_pip';
  const distance = computeStopLossDistancePips(entry, stopLoss, pip);
  if (distance > maxStopLossPips) return 'max_stop_loss_pips';
  return null;
}

export function validateTakeProfitPresent(takeProfit: number | null | undefined): string | null {
  if (takeProfit == null || !(takeProfit > 0)) return 'missing_take_profit';
  return null;
}

export function validateTakeProfitDirection(
  side: 'BUY' | 'SELL',
  entry: number,
  takeProfit: number
): string | null {
  if (side === 'BUY' && !(takeProfit > entry)) return 'buy_tp_not_above_entry';
  if (side === 'SELL' && !(takeProfit < entry)) return 'sell_tp_not_below_entry';
  return null;
}

/** Reader validate_sl_tp — reject bad structure/direction/max distance before risk allow. */
export function validateSlTp(input: {
  side: 'BUY' | 'SELL';
  entry: number;
  stop_loss: number;
  take_profit: number | null | undefined;
  swing_low?: number | null;
  swing_high?: number | null;
  pip: number;
  /** 0 = skip max-pips gate (MASTER default for GOLD-friendly ops) */
  max_stop_loss_pips: number;
}): SlTpValidationResult {
  const swingLow = input.swing_low ?? 0;
  const swingHigh = input.swing_high ?? 0;
  const placement =
    input.side === 'BUY'
      ? validateBuyStopLossPlacement(input.entry, input.stop_loss, swingLow)
      : validateSellStopLossPlacement(input.entry, input.stop_loss, swingHigh);
  if (placement) return { allowed: false, reason: placement };

  const maxPips = validateStopLossWithinMaxPips(
    input.entry,
    input.stop_loss,
    input.pip,
    input.max_stop_loss_pips
  );
  if (maxPips) return { allowed: false, reason: maxPips };

  const tpPresent = validateTakeProfitPresent(input.take_profit);
  if (tpPresent) return { allowed: false, reason: tpPresent };

  const tpDir = validateTakeProfitDirection(
    input.side,
    input.entry,
    input.take_profit as number
  );
  if (tpDir) return { allowed: false, reason: tpDir };

  return { allowed: true, reason: null };
}
