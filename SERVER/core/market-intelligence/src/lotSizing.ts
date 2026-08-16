/**
 * Deterministic lot sizing from configured policy + instrument bounds.
 * No arbitrary daily-loss % / account risk % unless explicitly configured.
 */

import type { LotPlan } from './types.js';

export type InstrumentLotSpec = {
  min_lot: number;
  max_lot: number;
  lot_step: number;
  contract_size?: number | null;
};

export type LotPolicy =
  | { mode: 'FIXED'; lot: number }
  | { mode: 'CLAMP_ONLY'; lot: number };

function roundToStep(lot: number, step: number): number {
  if (!(step > 0)) return lot;
  return Math.round(lot / step) * step;
}

export function computeLotSize(input: {
  policy: LotPolicy;
  instrument: InstrumentLotSpec;
}): LotPlan {
  const inputs: Record<string, number | string | null> = {
    mode: input.policy.mode,
    requested: input.policy.lot,
    min_lot: input.instrument.min_lot,
    max_lot: input.instrument.max_lot,
    lot_step: input.instrument.lot_step,
  };

  if (!(input.policy.lot > 0)) {
    return { ok: false, reason: 'LOT_NON_POSITIVE', inputs };
  }
  if (!(input.instrument.min_lot > 0) || !(input.instrument.lot_step > 0)) {
    return { ok: false, reason: 'INSTRUMENT_SPEC_INVALID', inputs };
  }
  if (input.instrument.max_lot < input.instrument.min_lot) {
    return { ok: false, reason: 'INSTRUMENT_BOUNDS_INVALID', inputs };
  }

  let lot = roundToStep(input.policy.lot, input.instrument.lot_step);
  lot = Math.max(input.instrument.min_lot, Math.min(input.instrument.max_lot, lot));
  // Re-step after clamp
  lot = roundToStep(lot, input.instrument.lot_step);
  if (lot < input.instrument.min_lot) {
    return { ok: false, reason: 'LOT_BELOW_MIN_AFTER_STEP', inputs: { ...inputs, lot } };
  }

  return {
    ok: true,
    lot,
    method: input.policy.mode === 'FIXED' ? 'CONFIGURED_LOT' : 'INSTRUMENT_BOUNDS',
    inputs: { ...inputs, lot },
  };
}
