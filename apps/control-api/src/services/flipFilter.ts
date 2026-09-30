import { entryFlipLockEnabled } from './tradeOpenPolicy.js';
import { getBrainGenome } from '../brainSelfImprove/brainGenome.js';
/**
 * After close: block same direction for a while.
 * After Soft/SL loss: longer same-dir block — but do NOT force opposite
 * (that caused BUY↔SELL Soft ping-pong on Funds).
 */

export type TradeSide = 'BUY' | 'SELL';

/** Same-direction lock after a green / scratch close (L≥1 only). Factory = genome. */
export const SAME_DIR_LOCK_MS = 90_000;

/**
 * After Soft/SL loss — legacy L≥1 only (was 12 minutes).
 * Mind robot is L0 OPEN: entryFlipLockEnabled() is false → no block.
 * Shortened so UI never advertises a fake 12m wait.
 */
export const SAME_DIR_LOCK_AFTER_LOSS_MS = 90_000;

export function sameDirLockMs(wasLoss?: boolean | null): number {
  const g = getBrainGenome();
  return wasLoss
    ? g.same_dir_lock_after_loss_ms || SAME_DIR_LOCK_AFTER_LOSS_MS
    : g.same_dir_lock_ms || SAME_DIR_LOCK_MS;
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
  const lockMs = sameDirLockMs(wasLoss);
  if (wasLoss) {
    return `SAME-DIR LOCK after Soft ${Math.ceil(lockMs / 60_000)}m · last ${lastClosedSide} · ${leftSec}s · blocked ${signal} · gaida next-move (ne auto-flip)`;
  }
  const need = lastClosedSide === 'BUY' ? 'SELL' : 'BUY';
  return `FLIP LOCK ${Math.ceil(lockMs / 1000)}s · last ${lastClosedSide} · ${leftSec}s left · blocked ${signal} · need ${need}`;
}

/** Exit reasons that mean Soft/structure loss — block same-dir longer. */
export function exitReasonWasLoss(reason: string | null | undefined): boolean {
  const g = getBrainGenome();
  const r = String(reason || '');
  if (/StructureInvalidation|ThesisFailure/i.test(r)) return true;
  if (/HardInvalidation/i.test(r)) {
    if (!g.exit_loss_include_hardinv) return false;
    if (g.exit_loss_exclude_be_lock && /BE-lock/i.test(r)) return false;
    return true;
  }
  if (/PeakProtection|MindBank|MindCut|Target\s*\/|TimeDecay|BE-lock/i.test(r)) return false;
  // Deprecated Soft BE-lock — genome be_lock_frac kept for legacy exit tagging only
  void (getBrainGenome().be_lock_frac || 0);
  void (getBrainGenome().be_lock_exec_frac || 0);
  return false;
}
