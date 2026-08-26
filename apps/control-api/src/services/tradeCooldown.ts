/**
 * Post-trade gates — user: NO cooldown seconds after any trade.
 * Reentry follows tape immediately (same side allowed).
 */

export type ExitSide = 'BUY' | 'SELL';

type EpicCooldown = {
  closedAtMs: number;
  side: ExitSide | null;
  wasLoss: boolean;
};

const byEpic = new Map<string, EpicCooldown>();

/** No time pause after profit close. */
export const EPIC_PAUSE_MS = 0;
/** No time pause after loss/scratch close. */
export const EPIC_LOSS_PAUSE_MS = 0;
/** @deprecated */
export const EPIC_FLIP_BLOCK_MS = 0;
/** Same-side reopen allowed — no must-flip block. */
export const EPIC_SAME_SIDE_BLOCK_MS = 0;

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
  _direction: ExitSide
): { ok: boolean; reason: string } {
  const g = byEpic.get(key(epic));
  if (!g || !g.closedAtMs) return { ok: true, reason: 'no recent epic close' };
  // User: nekāda cooldown — tape decides immediately
  return { ok: true, reason: 'no cooldown · tape free' };
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
