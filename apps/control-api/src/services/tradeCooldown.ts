/**
 * After close: 0s pause, but MUST flip side.
 * User: no SELL→SELL / BUY→BUY — next trade must be opposite.
 */

export type ExitSide = 'BUY' | 'SELL';

type EpicCooldown = {
  closedAtMs: number;
  side: ExitSide | null;
  wasLoss: boolean;
};

const byEpic = new Map<string, EpicCooldown>();

/** No time pause after profit. */
export const EPIC_PAUSE_MS = 0;
/** No time pause after loss/scratch. */
export const EPIC_LOSS_PAUSE_MS = 0;
/** @deprecated */
export const EPIC_FLIP_BLOCK_MS = 0;
/** Same side blocked until opposite trade closes. */
export const EPIC_SAME_SIDE_BLOCK_MS = Number.POSITIVE_INFINITY;

function key(epic: string): string {
  return String(epic || '')
    .trim()
    .toUpperCase();
}

export function pauseMsAfterClose(_wasLoss: boolean): number {
  return 0;
}

export function noteEpicTradeClose(
  epic: string,
  side: ExitSide | null | undefined,
  wasLoss: boolean
): void {
  const k = key(epic);
  if (!k) return;
  byEpic.set(k, {
    closedAtMs: Date.now(),
    side: side === 'BUY' || side === 'SELL' ? side : null,
    wasLoss,
  });
}

export function allowEpicReentry(
  epic: string,
  direction: ExitSide
): { ok: boolean; reason: string } {
  const g = byEpic.get(key(epic));
  if (!g || !g.closedAtMs) return { ok: true, reason: 'no recent epic close' };
  // Must flip — last BUY → only SELL next (no BUY→BUY / SELL→SELL)
  if (g.side && g.side === direction) {
    return {
      ok: false,
      reason: `EPIC must flip · last ${g.side} · no ${direction}→${direction}`,
    };
  }
  return { ok: true, reason: 'flip ok · 0s pause' };
}

/** Lookup last close for desk INFO (same epic). */
export function lastEpicClose(
  epic: string
): { closedAtMs: number; wasLoss: boolean; side: ExitSide | null } | null {
  const g = byEpic.get(key(epic));
  if (!g?.closedAtMs) return null;
  return { closedAtMs: g.closedAtMs, wasLoss: g.wasLoss, side: g.side };
}

/** Test helper */
export function resetEpicTradeCooldowns(): void {
  byEpic.clear();
}
