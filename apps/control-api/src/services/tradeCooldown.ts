/**
 * Post-trade close notes — per robot (client+epic), NO reentry pause.
 * Each client gets its own signal path; nothing blocks the next 5m entry.
 */

export type ExitSide = 'BUY' | 'SELL';

type CloseNote = {
  closedAtMs: number;
  side: ExitSide | null;
  wasLoss: boolean;
};

const byRobot = new Map<string, CloseNote>();

/** Cooldown disabled — always immediate reentry allowed. */
export const EPIC_PAUSE_MS = 0;
/** @deprecated */
export const EPIC_LOSS_PAUSE_MS = 0;
/** @deprecated */
export const EPIC_FLIP_BLOCK_MS = 0;
/** @deprecated */
export const EPIC_SAME_SIDE_BLOCK_MS = 0;

function robotKey(clientId: number | string | null | undefined, epic: string): string {
  const c = clientId != null ? String(clientId).trim() : '';
  const e = String(epic || '')
    .trim()
    .toUpperCase();
  return c && e ? `${c}:${e}` : e;
}

export function pauseMsAfterClose(_wasLoss: boolean): number {
  return EPIC_PAUSE_MS;
}

export function noteEpicTradeClose(
  epic: string,
  side: ExitSide | null | undefined,
  wasLoss: boolean,
  clientId?: number | string | null
): void {
  const k = robotKey(clientId, epic);
  if (!k) return;
  byRobot.set(k, {
    closedAtMs: Date.now(),
    side: side === 'BUY' || side === 'SELL' ? side : null,
    wasLoss,
  });
}

export function allowEpicReentry(
  epic: string,
  direction: ExitSide,
  _clientId?: number | string | null
): { ok: boolean; reason: string } {
  void epic;
  void direction;
  return { ok: true, reason: 'no cooldown · 5m entry free' };
}

/** Lookup last close for desk INFO (per robot when clientId given). */
export function lastEpicClose(
  epic: string,
  clientId?: number | string | null
): { closedAtMs: number; wasLoss: boolean; side: ExitSide | null } | null {
  const g = byRobot.get(robotKey(clientId, epic));
  if (!g?.closedAtMs) return null;
  return { closedAtMs: g.closedAtMs, wasLoss: g.wasLoss, side: g.side };
}

/** Test helper */
export function resetEpicTradeCooldowns(): void {
  byRobot.clear();
}
