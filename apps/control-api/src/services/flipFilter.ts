/** After close: block same direction; after loss force flip longer. Opposite OK immediately. */

export type TradeSide = 'BUY' | 'SELL';

/** Same-direction lock after a green / scratch close. */
export const SAME_DIR_LOCK_MS = 90_000;

/**
 * After Soft/SL / structure loss — do NOT re-open same side quickly.
 * Funds: −£0.09 then another SELL 6–11 min later wiped the morning.
 */
export const SAME_DIR_LOCK_AFTER_LOSS_MS = 12 * 60_000;

export function sameDirLockMs(wasLoss?: boolean | null): number {
  return wasLoss ? SAME_DIR_LOCK_AFTER_LOSS_MS : SAME_DIR_LOCK_MS;
}

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

export type SameDirBlockOpts = {
  wasLoss?: boolean | null;
  lockMs?: number;
};

/**
 * True when signal matches last closed side AND the lock is still active.
 * After a loss, lock is much longer (force flip window).
 */
export function sameDirectionBlocked(
  signal: TradeSide | null | undefined,
  lastClosedSide: TradeSide | null | undefined,
  closedAtMs?: number | null,
  nowMs = Date.now(),
  opts?: SameDirBlockOpts | number
): boolean {
  if (!signal || !lastClosedSide) return false;
  if (signal !== lastClosedSide) return false;
  // Back-compat: 5th arg used to be lockMs number
  const lock =
    typeof opts === 'number'
      ? opts
      : opts?.lockMs ?? sameDirLockMs(opts?.wasLoss);
  return sameDirLockActive(closedAtMs, nowMs, lock);
}

/** Opposite side preferred while lock is active; null when lock expired / no prior close. */
export function requiredFlipSide(
  lastClosedSide: TradeSide | null | undefined,
  closedAtMs?: number | null,
  nowMs = Date.now(),
  opts?: SameDirBlockOpts | number
): TradeSide | null {
  const lock =
    typeof opts === 'number'
      ? opts
      : opts?.lockMs ?? sameDirLockMs(opts?.wasLoss);
  if (!sameDirLockActive(closedAtMs, nowMs, lock)) return null;
  if (lastClosedSide === 'BUY') return 'SELL';
  if (lastClosedSide === 'SELL') return 'BUY';
  return null;
}

export function flipFilterReason(
  signal: TradeSide,
  lastClosedSide: TradeSide,
  leftSec: number,
  wasLoss?: boolean | null
): string {
  const need = lastClosedSide === 'BUY' ? 'SELL' : 'BUY';
  if (wasLoss) {
    return `FLIP AFTER LOSS ${Math.ceil(SAME_DIR_LOCK_AFTER_LOSS_MS / 60_000)}m · last ${lastClosedSide} · ${leftSec}s left · blocked ${signal} · need ${need}`;
  }
  return `FLIP LOCK ${Math.ceil(SAME_DIR_LOCK_MS / 1000)}s · last ${lastClosedSide} · ${leftSec}s left · blocked ${signal} · need ${need}`;
}

/** Exit reasons that mean the thesis died red — same-dir must flip. */
export function exitReasonWasLoss(reason: string | null | undefined): boolean {
  const r = String(reason || '');
  if (/StructureInvalidation|ThesisFailure/i.test(r)) return true;
  // Soft HardInv full loss (not BE-lock scratch near flat)
  if (/HardInvalidation/i.test(r) && !/BE-lock/i.test(r)) return true;
  if (/PeakProtection|Target\s*\/|TimeDecay|BE-lock/i.test(r)) return false;
  return false;
}
