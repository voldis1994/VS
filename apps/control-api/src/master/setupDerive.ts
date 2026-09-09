/** Derive desk sticky SETUP from MASTER bars (VS desk brain consolidation). */
import {
  buildStructure,
  emptySetup,
  emptyStructure,
  updateSetupSticky,
  type MarketSetup,
  type StructureBook,
} from '../services/marketSetup.js';
import type { CapitalPriceCandle } from '../services/capitalCom.js';
import type { Bar } from './types.js';

export function barsToSetupCandles(bars: Bar[]): CapitalPriceCandle[] {
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
 * Optional hour candles restore desk 1h hour_bias (missing → UNKNOWN).
 */
export function advanceMarketSetup(input: {
  bars: Bar[];
  mid?: number | null;
  hours?: CapitalPriceCandle[] | Bar[] | null;
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
  const hoursRaw = input.hours;
  const hours: CapitalPriceCandle[] | null =
    hoursRaw && hoursRaw.length
      ? hoursRaw.map((h) => ({
          open: h.open,
          high: h.high,
          low: h.low,
          close: h.close,
          snapshotTime:
            'snapshotTime' in h &&
            typeof (h as CapitalPriceCandle).snapshotTime === 'string'
              ? (h as CapitalPriceCandle).snapshotTime
              : 'ts_ms' in h &&
                  (h as Bar).ts_ms != null &&
                  Number.isFinite((h as Bar).ts_ms)
                ? new Date((h as Bar).ts_ms!).toISOString()
                : undefined,
        }))
      : null;
  const structure = buildStructure({
    minutes,
    hours,
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
