/** After close: block same direction for 3 minutes (all regimes). Opposite OK immediately. */

export type TradeSide = 'BUY' | 'SELL';

/** Same-direction lock after each close — then same side may trade again. */
export const SAME_DIR_LOCK_MS = 3 * 60_000;

export function sameDirLockActive(
  closedAtMs: number | null | undefined,
  nowMs = Date.now(),
  lockMs = SAME_DIR_LOCK_MS
): boolean {
  if (closedAtMs == null || !Number.isFinite(closedAtMs) || closedAtMs <= 0) return false;
  return nowMs - closedAtMs < lockMs;
}

/** Seconds left on the same-direction lock (0 when expired / inactive). */
export function sameDirLockLeftSec(
  closedAtMs: number | null | undefined,
  nowMs = Date.now(),
  lockMs = SAME_DIR_LOCK_MS
): number {
  if (!sameDirLockActive(closedAtMs, nowMs, lockMs)) return 0;
  return Math.ceil((lockMs - (nowMs - (closedAtMs as number))) / 1000);
}

/**
 * True when signal matches last closed side AND the 3 min lock is still active.
 * After the lock expires, same direction is allowed again.
 */
export function sameDirectionBlocked(
  signal: TradeSide | null | undefined,
  lastClosedSide: TradeSide | null | undefined,
  closedAtMs?: number | null,
  nowMs = Date.now(),
  lockMs = SAME_DIR_LOCK_MS
): boolean {
  if (!signal || !lastClosedSide) return false;
  if (signal !== lastClosedSide) return false;
  return sameDirLockActive(closedAtMs, nowMs, lockMs);
}

/** Opposite side preferred while lock is active; null when lock expired / no prior close. */
export function requiredFlipSide(
  lastClosedSide: TradeSide | null | undefined,
  closedAtMs?: number | null,
  nowMs = Date.now(),
  lockMs = SAME_DIR_LOCK_MS
): TradeSide | null {
  if (!sameDirLockActive(closedAtMs, nowMs, lockMs)) return null;
  if (lastClosedSide === 'BUY') return 'SELL';
  if (lastClosedSide === 'SELL') return 'BUY';
  return null;
}

export function flipFilterReason(
  signal: TradeSide,
  lastClosedSide: TradeSide,
  leftSec: number
): string {
  return `FLIP LOCK ${Math.ceil(SAME_DIR_LOCK_MS / 60_000)}m · last ${lastClosedSide} · ${leftSec}s left · blocked ${signal} · need ${
    lastClosedSide === 'BUY' ? 'SELL' : 'BUY'
  }`;
}
