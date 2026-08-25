/**
 * Multi-client desk: never hold BUY and SELL on the same epic at once.
 * Capital shows both as separate deals → margin fight + both can lose.
 */

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

/** Block opening the opposite side while a peer is already in the trade. */
export function allowDeskSameSide(
  units: Iterable<DeskOpenUnit>,
  epic: string,
  direction: DeskSide,
  exceptId?: string
): { ok: boolean; reason: string } {
  const { buys, sells } = deskOpensOnEpic(units, epic, exceptId);
  if (direction === 'BUY' && sells.length) {
    const who = sells.map((u) => u.display_name || u.id).join(',');
    return { ok: false, reason: `DESK lock · ${who} already SELL · no opposite BUY` };
  }
  if (direction === 'SELL' && buys.length) {
    const who = buys.map((u) => u.display_name || u.id).join(',');
    return { ok: false, reason: `DESK lock · ${who} already BUY · no opposite SELL` };
  }
  return { ok: true, reason: 'desk same-side ok' };
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
  if (shortNetPct == null || !Number.isFinite(shortNetPct)) {
    return { exit: false, reason: '' };
  }
  if (openSide === 'BUY' && shortNetPct <= -0.0015) {
    return {
      exit: true,
      reason: `DESK conflict · flatten BUY vs short dump (${(shortNetPct * 100).toFixed(2)}%)`,
    };
  }
  if (openSide === 'SELL' && shortNetPct >= 0.0015) {
    return {
      exit: true,
      reason: `DESK conflict · flatten SELL vs short rally (${(shortNetPct * 100).toFixed(2)}%)`,
    };
  }
  return { exit: false, reason: '' };
}
