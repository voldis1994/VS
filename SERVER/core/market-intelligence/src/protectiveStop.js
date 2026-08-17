/**
 * Protective stop — market invalidation based, never hardcoded pip distances.
 * 20% of price is emergency ceiling only — exceeding it blocks the trade.
 */
import { atrStop } from '../../risk/src/stops/atrStop.ts';
/**
 * Prefer structure invalidation; fall back to ATR envelope + spread buffer.
 * If computed distance exceeds emergency ceiling → do not open.
 */
export function computeProtectiveStop(input) {
    const ceiling = input.emergencyCeilingPct ?? 0.2;
    const inputs = {
        entry: input.entry,
        structureLevel: input.structureLevel ?? null,
        atr: input.atr ?? null,
        atrMultiplier: input.atrMultiplier ?? 1.5,
        spread: input.spread ?? null,
        emergencyCeilingPct: ceiling,
    };
    if (!(input.entry > 0)) {
        return { ok: false, block: 'INSUFFICIENT_DATA', reason: 'invalid entry', calculation_inputs: inputs };
    }
    let sl = null;
    let method = 'ATR';
    let reason = '';
    if (input.structureLevel != null &&
        Number.isFinite(input.structureLevel) &&
        input.structureLevel > 0) {
        const structOk = input.direction === 'LONG'
            ? input.structureLevel < input.entry
            : input.structureLevel > input.entry;
        if (structOk) {
            sl = input.structureLevel;
            method = 'STRUCTURE';
            reason = 'structure invalidation level';
        }
    }
    if (sl == null) {
        if (input.atr == null || !(input.atr > 0)) {
            return {
                ok: false,
                block: 'INSUFFICIENT_DATA',
                reason: 'no structure level and no ATR for protective stop',
                calculation_inputs: inputs,
            };
        }
        const mult = input.atrMultiplier ?? 1.5;
        const spreadBuf = input.spread != null && input.spread > 0 ? input.spread : 0;
        const atrPlan = atrStop({
            direction: input.direction,
            entry: input.entry,
            atr: input.atr,
            multiplier: mult,
            minDistance: spreadBuf * 2,
        });
        if ('error' in atrPlan) {
            return {
                ok: false,
                block: 'INSUFFICIENT_DATA',
                reason: atrPlan.error,
                calculation_inputs: inputs,
            };
        }
        sl = atrPlan.stop;
        method = 'ATR';
        reason = `ATR*${mult} + spread buffer`;
    }
    const distance = Math.abs(input.entry - sl);
    const distPct = distance / input.entry;
    if (distPct > ceiling) {
        return {
            ok: false,
            block: 'EMERGENCY_SL_CEILING',
            reason: `computed SL distance ${(distPct * 100).toFixed(2)}% exceeds emergency ceiling ${(ceiling * 100).toFixed(0)}% — trade must not open`,
            calculation_inputs: { ...inputs, sl_price: sl, sl_distance: distance, dist_pct: distPct },
        };
    }
    return {
        ok: true,
        sl_price: sl,
        sl_distance: distance,
        sl_method: method,
        structure_reference: input.structureLevel ?? null,
        volatility_reference: input.atr ?? null,
        calculation_inputs: inputs,
        reason,
        emergency_ceiling_pct: ceiling,
    };
}
