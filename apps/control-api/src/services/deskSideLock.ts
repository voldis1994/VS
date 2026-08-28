/**
 * Multi-client desk: never hold BUY and SELL on the same epic at once.
 * Capital shows both as separate deals → margin fight + both can lose.
 */

import { SHORT_THESIS_MOVE_PCT } from './microScalpThresholds.js';

export type DeskSide = 'BUY' | 'SELL';

export type DeskOpenUnit = {
  id: string;
  epic: string;
  running: boolean;
  open_side: DeskSide | null;
  display_name?: string;
};

export function deskOpensOnEpic(
  units: Iterable<DeskOpenUnit>,
  epic: string,
  exceptId?: string
): { buys: DeskOpenUnit[]; sells: DeskOpenUnit[] } {
  const want = String(epic || '')
    .trim()
    .toLowerCase();
  const buys: DeskOpenUnit[] = [];
  const sells: DeskOpenUnit[] = [];
  for (const u of units) {
    if (!u.running || !u.open_side) continue;
    if (exceptId && u.id === exceptId) continue;
    if (u.epic.trim().toLowerCase() !== want) continue;
    if (u.open_side === 'BUY') buys.push(u);
    else sells.push(u);
  }
  return { buys, sells };
}

/** PROFIT mode — no desk-side lock; each robot trades freely. */
export function allowDeskSameSide(
  _units: Iterable<DeskOpenUnit>,
  _epic: string,
  _direction: DeskSide,
  _exceptId?: string
): { ok: boolean; reason: string } {
  return { ok: true, reason: 'PROFIT · desk free' };
}

/**
 * Tape move against open side — same thresholds as desk conflict but NO peer requirement.
 * SELL + rally / BUY + dump must exit even with a single position (not only when hedge peers exist).
 */
export function tapeMoveShouldExit(
  openSide: DeskSide,
  shortNetPct: number | null | undefined
): { exit: boolean; reason: string } {
  if (shortNetPct == null || !Number.isFinite(shortNetPct)) {
    return { exit: false, reason: '' };
  }
  if (openSide === 'BUY' && shortNetPct <= -SHORT_THESIS_MOVE_PCT) {
    return {
      exit: true,
      reason: `TapeExit · flatten BUY vs short dump (${(shortNetPct * 100).toFixed(2)}%)`,
    };
  }
  if (openSide === 'SELL' && shortNetPct >= SHORT_THESIS_MOVE_PCT) {
    return {
      exit: true,
      reason: `TapeExit · flatten SELL vs short rally (${(shortNetPct * 100).toFixed(2)}%)`,
    };
  }
  return { exit: false, reason: '' };
}

/**
 * If desk already has both sides open, the unit fighting the short slope must exit.
 * shortNetPct: e.g. -0.004 dump → flatten BUY; +0.004 rally → flatten SELL.
 */
export function deskConflictShouldExit(
  openSide: DeskSide,
  hasOppositePeers: boolean,
  shortNetPct: number | null | undefined
): { exit: boolean; reason: string } {
  if (!hasOppositePeers) return { exit: false, reason: '' };
  return tapeMoveShouldExit(openSide, shortNetPct);
}
