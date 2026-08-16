/**
 * Trade explainability — every decision must be reconstructible.
 */

import type {
  LotPlan,
  MarketStateVector,
  ProtectiveStopPlan,
  SetupRecord,
  TradeExplanation,
} from './types.js';

export function buildTradeExplanation(input: {
  trade_id: string;
  setup: SetupRecord;
  market: MarketStateVector;
  sl: ProtectiveStopPlan;
  lot: LotPlan;
  tp?: { price: number | null; method: string | null; reason: string };
}): TradeExplanation {
  const whyEntry = input.setup.all_pass
    ? `setup ${input.setup.strategy_id} all conditions PASS direction=${input.setup.direction}`
    : `no entry — block=${input.setup.block}`;

  return {
    trade_id: input.trade_id,
    entry: {
      why: whyEntry,
      calculations: {
        conditions: input.setup.conditions,
        entry_reference: input.setup.entry_reference,
        evidence: input.setup.evidence,
      },
    },
    market: input.market,
    strategy: {
      id: input.setup.strategy_id,
      why_selected: input.setup.all_pass
        ? 'measurable conditions satisfied'
        : `blocked: ${input.setup.block}`,
    },
    sl: input.sl,
    lot: input.lot,
    be_events: [],
    tp: input.tp || { price: null, method: null, reason: 'NO_STATIC_TP' },
    management: [],
    exit: { reason: 'OPEN', timestamp: null },
    result: {
      pnl: null,
      mfe: null,
      mae: null,
      peak_captured_pct: null,
      giveback: null,
      slippage: null,
      spread_costs: null,
    },
  };
}
