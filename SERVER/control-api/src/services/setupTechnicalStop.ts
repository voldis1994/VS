/**
 * Setup-specific technical stop for tick/10s EntryReady.
 *
 * ENTRY and SL are one setup. Never use far regime range LOW/HIGH
 * (regimeEntryPlan.invalidation) as the trade SL just because it exists.
 *
 * If the structurally correct SL is TOO_WIDE vs local ATR → NO_TRADE.
 * Never artificially pull SL closer to allow a trade.
 */

import type { EntryKind } from './entryStateMachine.js';
import type { TickMicroMetrics } from './tickMicroEngine.js';

export type PlanBar = {
  open: number;
  high: number;
  low: number;
  close: number;
};

export type SetupStopBlock =
  | 'STOP_TOO_WIDE'
  | 'NO_STRUCTURE'
  | 'BAD_SIDE'
  | 'SPREAD'
  | 'RR_TOO_LOW'
  | 'INSUFFICIENT_DATA'
  | null;

export type SetupStopSource =
  | 'IGNITION_ORIGIN'
  | 'IGNITION_10S_STRUCTURE'
  | 'FIRST_PULLBACK_SWING'
  | 'BREAKOUT_RETEST'
  | 'RANGE_EDGE'
  | 'FAILED_BREAKOUT_EXTREME'
  | 'CONTINUATION_RELOAD_SWING'
  | 'NONE';

export type SetupStopPlan = {
  ok: boolean;
  block: SetupStopBlock;
  /** ASK for BUY, BID for SELL — execution economics */
  entry_price: number | null;
  technical_stop: number | null;
  stop_distance: number | null;
  stop_distance_atr: number | null;
  risk_reward: number | null;
  /** Suggested size from actual SL distance (never above baseLot) */
  position_size: number | null;
  sl_source: SetupStopSource;
  local_atr: number | null;
  max_stop_distance: number | null;
  reason: string;
};

/** Max stop distance in local ATR units — beyond this = STOP_TOO_WIDE / NO_TRADE. */
export const MAX_STOP_ATR = 2.5;

/** Minimum acceptable reward / risk using structure target. */
export const MIN_RISK_REWARD = 0.6;

export type ComputeSetupStopInput = {
  side: 'BUY' | 'SELL';
  kind: EntryKind;
  /** Mid for structure context */
  mid: number | null;
  bid?: number | null;
  ask?: number | null;
  spread?: number | null;
  bars10s: PlanBar[];
  micro: TickMicroMetrics;
  /** Tick/micro impulse origin — preferred for IGNITION */
  move_start_mid?: number | null;
  /** Plan levels — used only when they are NEAR structure, never as far regime SL alone */
  plan_entry?: number | null;
  plan_invalidation?: number | null;
  range_high?: number | null;
  range_low?: number | null;
  break_level?: number | null;
  confirm_level?: number | null;
  /** Operator lot — position_size never exceeds this */
  baseLot?: number;
  /** Optional equity for risk sizing (default 10_000) */
  equity?: number;
  riskFraction?: number;
  maxStopAtr?: number;
  minRr?: number;
};

function atrFromBars(bars: PlanBar[], n = 14): number | null {
  const w = bars.filter((b) => b && Number.isFinite(b.high) && Number.isFinite(b.low)).slice(-n);
  if (w.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < w.length; i++) {
    const cur = w[i]!;
    const prev = w[i - 1]!;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    sum += tr;
  }
  const atr = sum / (w.length - 1);
  return atr > 0 && Number.isFinite(atr) ? atr : null;
}

function localAtr(bars: PlanBar[], micro: TickMicroMetrics, mid: number): number {
  const fromBars = atrFromBars(bars, 14);
  const microVol = micro.micro_volatility_5s;
  const fromMicro =
    microVol != null && Number.isFinite(microVol) && mid > 0 ? microVol * mid : null;
  const candidates = [fromBars, fromMicro].filter((x): x is number => x != null && x > 0);
  // Gold 10s floor — micro vol alone is too small and collapses MAX_STOP into noise
  const floor = mid >= 1000 ? 1.2 : mid >= 100 ? 0.08 : mid * 0.00025;
  if (!candidates.length) return floor;
  return Math.max(Math.max(...candidates), floor);
}

/** Last swing low: pivot low in recent 10s window (not full regime range). */
export function recentSwingLow(bars: PlanBar[], lookback = 10): number | null {
  const w = bars.filter((b) => b && Number.isFinite(b.low)).slice(-Math.max(lookback, 5));
  if (w.length < 3) {
    if (!w.length) return null;
    return Math.min(...w.map((b) => b.low));
  }
  let best: number | null = null;
  for (let i = 1; i < w.length - 1; i++) {
    const a = w[i - 1]!;
    const b = w[i]!;
    const c = w[i + 1]!;
    if (b.low <= a.low && b.low <= c.low) {
      if (best == null || b.low < best) best = b.low;
    }
  }
  if (best != null) return best;
  return Math.min(...w.slice(-5).map((b) => b.low));
}

export function recentSwingHigh(bars: PlanBar[], lookback = 10): number | null {
  const w = bars.filter((b) => b && Number.isFinite(b.high)).slice(-Math.max(lookback, 5));
  if (w.length < 3) {
    if (!w.length) return null;
    return Math.max(...w.map((b) => b.high));
  }
  let best: number | null = null;
  for (let i = 1; i < w.length - 1; i++) {
    const a = w[i - 1]!;
    const b = w[i]!;
    const c = w[i + 1]!;
    if (b.high >= a.high && b.high >= c.high) {
      if (best == null || b.high > best) best = b.high;
    }
  }
  if (best != null) return best;
  return Math.max(...w.slice(-5).map((b) => b.high));
}

function volBuffer(atr: number, spread: number | null | undefined): number {
  const sp = spread != null && Number.isFinite(spread) && spread > 0 ? spread : 0;
  return Math.max(atr * 0.15, sp * 1.5, atr * 0.05);
}

/**
 * Prefer candidate only if on correct side of entry and within maxDist.
 * Far regime invalidation is rejected here — never auto-promoted to trade SL.
 */
function pickStructureLevel(
  side: 'BUY' | 'SELL',
  entry: number,
  candidates: Array<{ level: number | null | undefined; source: SetupStopSource }>,
  maxDist: number
): { level: number; source: SetupStopSource } | null {
  let best: { level: number; source: SetupStopSource; dist: number } | null = null;
  for (const c of candidates) {
    const lvl = c.level;
    if (lvl == null || !Number.isFinite(lvl)) continue;
    const okSide = side === 'BUY' ? lvl < entry : lvl > entry;
    if (!okSide) continue;
    const dist = Math.abs(entry - lvl);
    if (!(dist > 0)) continue;
    if (dist > maxDist) continue; // too far for this candidate — skip (do not use)
    if (!best || dist < best.dist) best = { level: lvl, source: c.source, dist };
  }
  return best ? { level: best.level, source: best.source } : null;
}

function executionEntry(
  side: 'BUY' | 'SELL',
  mid: number,
  bid?: number | null,
  ask?: number | null
): number {
  if (side === 'BUY') {
    return ask != null && Number.isFinite(ask) && ask > 0 ? ask : mid;
  }
  return bid != null && Number.isFinite(bid) && bid > 0 ? bid : mid;
}

function structureTarget(
  side: 'BUY' | 'SELL',
  entry: number,
  atr: number,
  confirm?: number | null,
  breakLevel?: number | null,
  rangeHigh?: number | null,
  rangeLow?: number | null
): number {
  // Reward estimate: nearest favorable structure / 1.5 ATR — for RR check only
  if (side === 'BUY') {
    const cands = [confirm, breakLevel, rangeHigh].filter(
      (x): x is number => x != null && Number.isFinite(x) && x > entry
    );
    if (cands.length) return Math.min(...cands);
    return entry + atr * 1.5;
  }
  const cands = [confirm, breakLevel, rangeLow].filter(
    (x): x is number => x != null && Number.isFinite(x) && x < entry
  );
  if (cands.length) return Math.max(...cands);
  return entry - atr * 1.5;
}

/**
 * Compute setup-specific technical stop. Does not place orders.
 */
export function computeSetupTechnicalStop(input: ComputeSetupStopInput): SetupStopPlan {
  const fail = (
    block: SetupStopBlock,
    reason: string,
    partial?: Partial<SetupStopPlan>
  ): SetupStopPlan => ({
    ok: false,
    block,
    entry_price: partial?.entry_price ?? null,
    technical_stop: partial?.technical_stop ?? null,
    stop_distance: partial?.stop_distance ?? null,
    stop_distance_atr: partial?.stop_distance_atr ?? null,
    risk_reward: partial?.risk_reward ?? null,
    position_size: null,
    sl_source: partial?.sl_source ?? 'NONE',
    local_atr: partial?.local_atr ?? null,
    max_stop_distance: partial?.max_stop_distance ?? null,
    reason,
  });

  if (!input.kind) {
    return fail('INSUFFICIENT_DATA', 'no entry kind');
  }
  const mid = input.mid;
  if (mid == null || !(mid > 0)) {
    return fail('INSUFFICIENT_DATA', 'no mid');
  }

  const atr = localAtr(input.bars10s, input.micro, mid);
  const maxAtrMult = input.maxStopAtr ?? MAX_STOP_ATR;
  const maxDist = atr * maxAtrMult;
  const buf = volBuffer(atr, input.spread);
  const entry = executionEntry(input.side, mid, input.bid, input.ask);

  const swingLow = recentSwingLow(input.bars10s, 10);
  const swingHigh = recentSwingHigh(input.bars10s, 10);
  const lastFew = input.bars10s.slice(-6);
  const recentLow = lastFew.length
    ? Math.min(...lastFew.map((b) => b.low))
    : null;
  const recentHigh = lastFew.length
    ? Math.max(...lastFew.map((b) => b.high))
    : null;

  const candidates: Array<{ level: number | null | undefined; source: SetupStopSource }> = [];

  switch (input.kind) {
    case 'IGNITION_ENTRY': {
      // Origin of micro impulse, else last valid 10s structure extreme
      if (input.move_start_mid != null && Number.isFinite(input.move_start_mid)) {
        const origin =
          input.side === 'BUY'
            ? input.move_start_mid - buf
            : input.move_start_mid + buf;
        candidates.push({ level: origin, source: 'IGNITION_ORIGIN' });
      }
      candidates.push({
        level:
          input.side === 'BUY'
            ? swingLow != null
              ? swingLow - buf
              : recentLow != null
                ? recentLow - buf
                : null
            : swingHigh != null
              ? swingHigh + buf
              : recentHigh != null
                ? recentHigh + buf
                : null,
        source: 'IGNITION_10S_STRUCTURE',
      });
      break;
    }
    case 'FIRST_PULLBACK': {
      candidates.push({
        level:
          input.side === 'BUY'
            ? swingLow != null
              ? swingLow - buf
              : recentLow != null
                ? recentLow - buf
                : null
            : swingHigh != null
              ? swingHigh + buf
              : recentHigh != null
                ? recentHigh + buf
                : null,
        source: 'FIRST_PULLBACK_SWING',
      });
      break;
    }
    case 'BREAKOUT_RETEST': {
      // Retest extreme / break invalidation — NOT far regime range
      const retest =
        input.side === 'BUY'
          ? recentLow != null
            ? recentLow - buf
            : input.break_level != null
              ? input.break_level - buf
              : null
          : recentHigh != null
            ? recentHigh + buf
            : input.break_level != null
              ? input.break_level + buf
              : null;
      candidates.push({ level: retest, source: 'BREAKOUT_RETEST' });
      if (input.confirm_level != null) {
        candidates.push({
          level:
            input.side === 'BUY' ? input.confirm_level - buf : input.confirm_level + buf,
          source: 'BREAKOUT_RETEST',
        });
      }
      break;
    }
    case 'RANGE_REJECTION': {
      // Specific nearby range edge — far regime LOW/HIGH filtered by maxDist in pickStructureLevel
      candidates.push({
        level:
          input.side === 'BUY'
            ? swingLow != null
              ? swingLow - buf
              : recentLow != null
                ? recentLow - buf
                : null
            : swingHigh != null
              ? swingHigh + buf
              : recentHigh != null
                ? recentHigh + buf
                : null,
        source: 'RANGE_EDGE',
      });
      if (input.side === 'BUY' && input.range_low != null) {
        candidates.push({ level: input.range_low - buf, source: 'RANGE_EDGE' });
      }
      if (input.side === 'SELL' && input.range_high != null) {
        candidates.push({ level: input.range_high + buf, source: 'RANGE_EDGE' });
      }
      break;
    }
    case 'FAILED_BREAKOUT': {
      const extreme =
        input.side === 'BUY'
          ? recentLow != null
            ? recentLow - buf
            : swingLow != null
              ? swingLow - buf
              : null
          : recentHigh != null
            ? recentHigh + buf
            : swingHigh != null
              ? swingHigh + buf
              : null;
      candidates.push({ level: extreme, source: 'FAILED_BREAKOUT_EXTREME' });
      break;
    }
    case 'CONTINUATION_RELOAD': {
      candidates.push({
        level:
          input.side === 'BUY'
            ? swingLow != null
              ? swingLow - buf
              : recentLow != null
                ? recentLow - buf
                : null
            : swingHigh != null
              ? swingHigh + buf
              : recentHigh != null
                ? recentHigh + buf
                : null,
        source: 'CONTINUATION_RELOAD_SWING',
      });
      break;
    }
    default:
      return fail('INSUFFICIENT_DATA', `unknown kind ${input.kind}`, {
        entry_price: entry,
        local_atr: atr,
        max_stop_distance: maxDist,
      });
  }

  // Explicitly DO NOT add plan_invalidation as a candidate when it is the far regime LOW/HIGH.
  // Only allow it if it already sits within maxDist (near structure).
  if (input.plan_invalidation != null && Number.isFinite(input.plan_invalidation)) {
    const invDist = Math.abs(entry - input.plan_invalidation);
    if (invDist <= maxDist) {
      // Near enough — may reinforce, but prefer dedicated sources (pickStructure takes nearest)
      candidates.push({
        level: input.plan_invalidation,
        source: candidates[0]?.source ?? 'NONE',
      });
    }
    // If far — intentionally ignored (test: must not become trade SL)
  }

  const picked = pickStructureLevel(input.side, entry, candidates, maxDist);
  if (!picked) {
    // Check if any candidate existed but all were too far → STOP_TOO_WIDE
    const anyFar = candidates.some((c) => {
      if (c.level == null || !Number.isFinite(c.level)) return false;
      const okSide = input.side === 'BUY' ? c.level < entry : c.level > entry;
      return okSide && Math.abs(entry - c.level) > maxDist;
    });
    if (anyFar) {
      const far = candidates.find((c) => c.level != null && Number.isFinite(c.level))!;
      const dist = Math.abs(entry - far.level!);
      return fail('STOP_TOO_WIDE', `NO_TRADE STOP_TOO_WIDE · structural SL ${dist.toFixed(2)} > max ${maxDist.toFixed(2)} (${maxAtrMult}×ATR)`, {
        entry_price: entry,
        technical_stop: far.level!,
        stop_distance: dist,
        stop_distance_atr: atr > 0 ? dist / atr : null,
        sl_source: far.source,
        local_atr: atr,
        max_stop_distance: maxDist,
      });
    }
    return fail('NO_STRUCTURE', 'NO_TRADE · no setup structure for SL', {
      entry_price: entry,
      local_atr: atr,
      max_stop_distance: maxDist,
    });
  }

  let stop = picked.level;
  // Spread: BUY stop must clear bid-side noise — already buffered; ensure stop is beyond spread from entry
  const sp = input.spread != null && input.spread > 0 ? input.spread : 0;
  if (input.side === 'BUY' && entry - stop < sp) {
    return fail('SPREAD', 'NO_TRADE · stop inside spread', {
      entry_price: entry,
      technical_stop: stop,
      stop_distance: entry - stop,
      sl_source: picked.source,
      local_atr: atr,
      max_stop_distance: maxDist,
    });
  }
  if (input.side === 'SELL' && stop - entry < sp) {
    return fail('SPREAD', 'NO_TRADE · stop inside spread', {
      entry_price: entry,
      technical_stop: stop,
      stop_distance: stop - entry,
      sl_source: picked.source,
      local_atr: atr,
      max_stop_distance: maxDist,
    });
  }

  const stop_distance = Math.abs(entry - stop);
  const stop_distance_atr = atr > 0 ? stop_distance / atr : null;

  if (stop_distance > maxDist) {
    return fail(
      'STOP_TOO_WIDE',
      `NO_TRADE STOP_TOO_WIDE · SL dist ${stop_distance.toFixed(2)} > max ${maxDist.toFixed(2)} (${maxAtrMult}×ATR=${atr.toFixed(3)})`,
      {
        entry_price: entry,
        technical_stop: stop,
        stop_distance,
        stop_distance_atr,
        sl_source: picked.source,
        local_atr: atr,
        max_stop_distance: maxDist,
      }
    );
  }

  const target = structureTarget(
    input.side,
    entry,
    atr,
    input.confirm_level,
    input.break_level,
    input.range_high,
    input.range_low
  );
  const reward = Math.abs(target - entry);
  const risk_reward = stop_distance > 0 ? reward / stop_distance : null;
  const minRr = input.minRr ?? MIN_RISK_REWARD;
  if (risk_reward != null && risk_reward < minRr) {
    return fail(
      'RR_TOO_LOW',
      `NO_TRADE · RR ${risk_reward.toFixed(2)} < min ${minRr}`,
      {
        entry_price: entry,
        technical_stop: stop,
        stop_distance,
        stop_distance_atr,
        risk_reward,
        sl_source: picked.source,
        local_atr: atr,
        max_stop_distance: maxDist,
      }
    );
  }

  const baseLot = input.baseLot != null && input.baseLot > 0 ? input.baseLot : 1;
  const equity = input.equity != null && input.equity > 0 ? input.equity : 10_000;
  const riskFrac = input.riskFraction != null && input.riskFraction > 0 ? input.riskFraction : 0.005;
  // Size from actual SL distance; never above operator lot
  const rawSize = (equity * riskFrac) / stop_distance;
  const position_size = Math.min(baseLot, Math.max(0.01, Math.round(rawSize * 100) / 100));

  return {
    ok: true,
    block: null,
    entry_price: entry,
    technical_stop: stop,
    stop_distance,
    stop_distance_atr,
    risk_reward,
    position_size,
    sl_source: picked.source,
    local_atr: atr,
    max_stop_distance: maxDist,
    reason: `SL ${picked.source} · dist ${stop_distance.toFixed(2)} · ${stop_distance_atr?.toFixed(2)} ATR · RR ${risk_reward?.toFixed(2)}`,
  };
}

/** True when a level is the far regime invalidation pattern (should not be trade SL). */
export function isFarRegimeInvalidation(
  entry: number,
  invalidation: number | null | undefined,
  localAtr: number,
  maxStopAtr = MAX_STOP_ATR
): boolean {
  if (invalidation == null || !Number.isFinite(invalidation) || !(localAtr > 0)) return false;
  return Math.abs(entry - invalidation) > localAtr * maxStopAtr;
}
