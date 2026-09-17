/**
 * DEPRECATED — do not use for trading UI or orders.
 * Markets come only from Capital.com `capital_markets` (broker epic 1:1).
 * Kept empty so old imports do not invent EURUSD / XAUUSD / Gold/USD defaults.
 */
export interface InstrumentDef {
  id: number;
  symbol: string;
  display_name: string;
  category: string;
  tick_size: number;
  lot_step: number;
  min_lot: number;
  max_lot: number;
  enabled: boolean;
}

/** Empty on purpose — never seed Control with fake broker names. */
export const INSTRUMENT_CATALOG: InstrumentDef[] = [];

export function getInstrumentById(_id: number): InstrumentDef | undefined {
  return undefined;
}

export function getEnabledInstruments(): InstrumentDef[] {
  return [];
}
