/**
 * Post-trade gates — anti machine-gun reentry.
 * Same side may reopen after a short pause; zero pause caused open→close loops.
 */

export type ExitSide = 'BUY' | 'SELL';

type EpicCooldown = {
  closedAtMs: number;
  side: ExitSide | null;
  wasLoss: boolean;
};

const byEpic = new Map<string, EpicCooldown>();

/** Minimum pause after any close before same-epic reentry (stop open/close spam). */
export const EPIC_PAUSE_MS = 90_000;
/** Same pause after loss/scratch — machine-gun was worse on scratches. */
export const EPIC_LOSS_PAUSE_MS = 90_000;
/** @deprecated */
export const EPIC_FLIP_BLOCK_MS = 0;
/** Same-side reopen allowed after pause — no must-flip block. */
export const EPIC_SAME_SIDE_BLOCK_MS = 0;

function key(epic: string): string {
  return String(epic || '')
    .trim()
    .toUpperCase();
}

export function pauseMsAfterClose(wasLoss: boolean): number {
  return wasLoss ? EPIC_LOSS_PAUSE_MS : EPIC_PAUSE_MS;
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
  _direction: ExitSide
): { ok: boolean; reason: string } {
  const g = byEpic.get(key(epic));
  if (!g || !g.closedAtMs) return { ok: true, reason: 'no recent epic close' };
  const need = pauseMsAfterClose(g.wasLoss);
  const left = g.closedAtMs + need - Date.now();
  if (left > 0) {
    return {
      ok: false,
      reason: `REENTRY PAUSE · ${Math.ceil(left / 1000)}s left after close · anti machine-gun`,
    };
  }
  return { ok: true, reason: 'pause cleared · tape free' };
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
