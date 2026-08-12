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

/** Tradable catalog shown in Control Panel. Expand as needed. */
export const INSTRUMENT_CATALOG: InstrumentDef[] = [
  // FX majors
  { id: 1, symbol: 'EURUSD', display_name: 'EUR/USD', category: 'fx', tick_size: 0.00001, lot_step: 0.01, min_lot: 0.01, max_lot: 100, enabled: true },
  { id: 2, symbol: 'GBPUSD', display_name: 'GBP/USD', category: 'fx', tick_size: 0.00001, lot_step: 0.01, min_lot: 0.01, max_lot: 100, enabled: true },
  { id: 3, symbol: 'USDJPY', display_name: 'USD/JPY', category: 'fx', tick_size: 0.001, lot_step: 0.01, min_lot: 0.01, max_lot: 100, enabled: true },
  { id: 4, symbol: 'USDCHF', display_name: 'USD/CHF', category: 'fx', tick_size: 0.00001, lot_step: 0.01, min_lot: 0.01, max_lot: 100, enabled: true },
  { id: 5, symbol: 'AUDUSD', display_name: 'AUD/USD', category: 'fx', tick_size: 0.00001, lot_step: 0.01, min_lot: 0.01, max_lot: 100, enabled: true },
  { id: 6, symbol: 'USDCAD', display_name: 'USD/CAD', category: 'fx', tick_size: 0.00001, lot_step: 0.01, min_lot: 0.01, max_lot: 100, enabled: true },
  { id: 7, symbol: 'NZDUSD', display_name: 'NZD/USD', category: 'fx', tick_size: 0.00001, lot_step: 0.01, min_lot: 0.01, max_lot: 100, enabled: true },
  // FX crosses
  { id: 8, symbol: 'EURGBP', display_name: 'EUR/GBP', category: 'fx', tick_size: 0.00001, lot_step: 0.01, min_lot: 0.01, max_lot: 100, enabled: true },
  { id: 9, symbol: 'EURJPY', display_name: 'EUR/JPY', category: 'fx', tick_size: 0.001, lot_step: 0.01, min_lot: 0.01, max_lot: 100, enabled: true },
  { id: 10, symbol: 'GBPJPY', display_name: 'GBP/JPY', category: 'fx', tick_size: 0.001, lot_step: 0.01, min_lot: 0.01, max_lot: 100, enabled: true },
  // Metals / energy
  { id: 11, symbol: 'XAUUSD', display_name: 'Gold/USD', category: 'metals', tick_size: 0.01, lot_step: 0.01, min_lot: 0.01, max_lot: 50, enabled: true },
  { id: 12, symbol: 'XAGUSD', display_name: 'Silver/USD', category: 'metals', tick_size: 0.001, lot_step: 0.01, min_lot: 0.01, max_lot: 50, enabled: true },
  { id: 13, symbol: 'USOIL', display_name: 'US Oil', category: 'energy', tick_size: 0.01, lot_step: 0.01, min_lot: 0.01, max_lot: 50, enabled: true },
  { id: 14, symbol: 'UKOIL', display_name: 'UK Oil', category: 'energy', tick_size: 0.01, lot_step: 0.01, min_lot: 0.01, max_lot: 50, enabled: true },
  // Indices
  { id: 15, symbol: 'US500', display_name: 'S&P 500', category: 'indices', tick_size: 0.1, lot_step: 0.1, min_lot: 0.1, max_lot: 100, enabled: true },
  { id: 16, symbol: 'US100', display_name: 'Nasdaq 100', category: 'indices', tick_size: 0.1, lot_step: 0.1, min_lot: 0.1, max_lot: 100, enabled: true },
  { id: 17, symbol: 'US30', display_name: 'Dow Jones', category: 'indices', tick_size: 0.1, lot_step: 0.1, min_lot: 0.1, max_lot: 100, enabled: true },
  { id: 18, symbol: 'GER40', display_name: 'Germany 40', category: 'indices', tick_size: 0.1, lot_step: 0.1, min_lot: 0.1, max_lot: 100, enabled: true },
  { id: 19, symbol: 'UK100', display_name: 'UK 100', category: 'indices', tick_size: 0.1, lot_step: 0.1, min_lot: 0.1, max_lot: 100, enabled: true },
  { id: 20, symbol: 'JP225', display_name: 'Japan 225', category: 'indices', tick_size: 1, lot_step: 0.1, min_lot: 0.1, max_lot: 100, enabled: true },
  // Crypto
  { id: 21, symbol: 'BTCUSD', display_name: 'Bitcoin/USD', category: 'crypto', tick_size: 0.1, lot_step: 0.01, min_lot: 0.01, max_lot: 20, enabled: true },
  { id: 22, symbol: 'ETHUSD', display_name: 'Ethereum/USD', category: 'crypto', tick_size: 0.01, lot_step: 0.01, min_lot: 0.01, max_lot: 50, enabled: true },
];

export function getInstrumentById(id: number): InstrumentDef | undefined {
  return INSTRUMENT_CATALOG.find((i) => i.id === id);
}

export function getEnabledInstruments(): InstrumentDef[] {
  return INSTRUMENT_CATALOG.filter((i) => i.enabled);
}
