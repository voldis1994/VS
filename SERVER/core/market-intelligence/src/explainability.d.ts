/**
 * Trade explainability — every decision must be reconstructible.
 */
import type { LotPlan, MarketStateVector, ProtectiveStopPlan, SetupRecord, TradeExplanation } from './types.js';
export declare function buildTradeExplanation(input: {
    trade_id: string;
    setup: SetupRecord;
    market: MarketStateVector;
    sl: ProtectiveStopPlan;
    lot: LotPlan;
    tp?: {
        price: number | null;
        method: string | null;
        reason: string;
    };
}): TradeExplanation;
