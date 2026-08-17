/**
 * Protective stop — market invalidation based, never hardcoded pip distances.
 * 20% of price is emergency ceiling only — exceeding it blocks the trade.
 */
import type { ProtectiveStopPlan } from './types.js';
export type ProtectiveStopInput = {
    direction: 'LONG' | 'SHORT';
    entry: number;
    /** Structure invalidation level (swing high/low). */
    structureLevel?: number | null;
    atr?: number | null;
    atrMultiplier?: number;
    spread?: number | null;
    /** Absolute emergency ceiling as fraction of entry (default 0.20). Not a trading stop. */
    emergencyCeilingPct?: number;
};
/**
 * Prefer structure invalidation; fall back to ATR envelope + spread buffer.
 * If computed distance exceeds emergency ceiling → do not open.
 */
export declare function computeProtectiveStop(input: ProtectiveStopInput): ProtectiveStopPlan;
