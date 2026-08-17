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
export type LotPolicy = {
    mode: 'FIXED';
    lot: number;
} | {
    mode: 'CLAMP_ONLY';
    lot: number;
};
export declare function computeLotSize(input: {
    policy: LotPolicy;
    instrument: InstrumentLotSpec;
}): LotPlan;
