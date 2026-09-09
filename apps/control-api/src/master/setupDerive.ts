/** Derive desk sticky SETUP from MASTER bars (VS desk brain consolidation). */
import {
  buildStructure,
  emptySetup,
  emptyStructure,
  updateSetupSticky,
  type MarketSetup,
  type StructureBook,
} from '../services/marketSetup.js';
import type { Bar } from './types.js';

export function barsToSetupCandles(bars: Bar[]) {
  return bars.map((b) => ({
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    snapshotTime:
      b.ts_ms != null && Number.isFinite(b.ts_ms)
        ? new Date(b.ts_ms).toISOString()
        : undefined,
  }));
}

/**
 * Advance sticky structure + setup from OHLC bars.
 * Call once per cycle so ARMED side is stable across ticks (desk rule).
 */
export function advanceMarketSetup(input: {
  bars: Bar[];
  mid?: number | null;
  prevStructure?: StructureBook | null;
  prevSetup?: MarketSetup | null;
}): { structure: StructureBook; setup: MarketSetup } {
  const minutes = barsToSetupCandles(input.bars);
  if (minutes.length < 20) {
    return {
      structure: emptyStructure(`need ≥20 minute bars · have ${minutes.length}`),
      setup: emptySetup(`need ≥20 bars · have ${minutes.length}`),
    };
  }
  const structure = buildStructure({
    minutes,
    mid: input.mid ?? null,
    prev: input.prevStructure ?? null,
  });
  const setup = updateSetupSticky(
    input.prevSetup ?? null,
    structure,
    minutes
  );
  return { structure, setup };
}
