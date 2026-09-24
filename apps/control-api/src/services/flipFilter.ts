import { entryFlipLockEnabled } from './tradeOpenPolicy.js';
/**
 * After close: block same direction for a while.
 * After Soft/SL loss: longer same-dir block — but do NOT force opposite
 * (that caused BUY↔SELL Soft ping-pong on Funds).
 */

export type TradeSide = 'BUY' | 'SELL';

/** Same-direction lock after a green / scratch close. */
export const SAME_DIR_LOCK_MS = 90_000;

/**
 * After Soft/SL / structure loss — do not re-open the SAME side quickly.
 * Opposite is allowed only when next-move confirms (robotDesk) — never auto-flip.
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
 * After a loss, same side stays blocked longer — opposite is NOT required.
 */
export function sameDirectionBlocked(
  signal: TradeSide | null | undefined,
  lastClosedSide: TradeSide | null | undefined,
  closedAtMs?: number | null,
  nowMs = Date.now(),
  opts?: SameDirBlockOpts | number
): boolean {
  if (!entryFlipLockEnabled()) return false;
  if (!signal || !lastClosedSide) return false;
  if (signal !== lastClosedSide) return false;
  const lock =
    typeof opts === 'number'
      ? opts
      : opts?.lockMs ?? sameDirLockMs(opts?.wasLoss);
  return sameDirLockActive(closedAtMs, nowMs, lock);
}

/**
 * Preferred flip side while a short win-lock is active (chop stop).
 * After Soft loss we do NOT advertise a forced opposite — that knife-flipped.
 */
export function requiredFlipSide(
  lastClosedSide: TradeSide | null | undefined,
  closedAtMs?: number | null,
  nowMs = Date.now(),
  opts?: SameDirBlockOpts | number
): TradeSide | null {
  const wasLoss =
    typeof opts === 'number' ? false : Boolean(opts?.wasLoss);
  // After loss: no forced flip side — wait for next-move confirm either way
  if (wasLoss) return null;
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
  if (wasLoss) {
    return `SAME-DIR LOCK after Soft ${Math.ceil(SAME_DIR_LOCK_AFTER_LOSS_MS / 60_000)}m · last ${lastClosedSide} · ${leftSec}s · blocked ${signal} · gaida next-move (ne auto-flip)`;
  }
  const need = lastClosedSide === 'BUY' ? 'SELL' : 'BUY';
  return `FLIP LOCK ${Math.ceil(SAME_DIR_LOCK_MS / 1000)}s · last ${lastClosedSide} · ${leftSec}s left · blocked ${signal} · need ${need}`;
}

/** Exit reasons that mean Soft/structure loss — block same-dir longer. */
export function exitReasonWasLoss(reason: string | null | undefined): boolean {
  const r = String(reason || '');
  if (/StructureInvalidation|ThesisFailure/i.test(r)) return true;
  if (/HardInvalidation/i.test(r) && !/BE-lock/i.test(r)) return true;
  if (/PeakProtection|Target\s*\/|TimeDecay|BE-lock/i.test(r)) return false;
  return false;
}
