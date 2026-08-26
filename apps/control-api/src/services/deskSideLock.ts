/**
 * Multi-account desk lock — SAME CLIENT only.
 * Different clients must trade independently (own Capital + own 10s OHLC).
 * Within one client: never hold BUY and SELL on the same epic (margin fight).
 */

import { SHORT_THESIS_MOVE_PCT } from './microScalpThresholds.js';

export type DeskSide = 'BUY' | 'SELL';

export type DeskOpenUnit = {
  id: string;
  epic: string;
  running: boolean;
  open_side: DeskSide | null;
  display_name?: string;
  /** Required for isolation — peers without matching client_id are ignored. */
  client_id?: number | null;
};

export function deskOpensOnEpic(
  units: Iterable<DeskOpenUnit>,
  epic: string,
  exceptId?: string,
  clientId?: number | null
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
    // Cross-client isolation: only same client (or unknown client_id legacy)
    if (clientId != null && Number.isFinite(clientId)) {
      if (u.client_id != null && Number(u.client_id) !== Number(clientId)) continue;
    }
    if (u.open_side === 'BUY') buys.push(u);
    else sells.push(u);
  }
  return { buys, sells };
}

/** Block opposite side only vs same-client peers on this epic. */
export function allowDeskSameSide(
  units: Iterable<DeskOpenUnit>,
  epic: string,
  direction: DeskSide,
  exceptId?: string,
  clientId?: number | null
): { ok: boolean; reason: string } {
  const { buys, sells } = deskOpensOnEpic(units, epic, exceptId, clientId);
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
 * If same-client desk already has both sides open, the unit fighting the short slope must exit.
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
  if (openSide === 'BUY' && shortNetPct <= -SHORT_THESIS_MOVE_PCT) {
    return {
      exit: true,
      reason: `DESK conflict · flatten BUY vs short dump (${(shortNetPct * 100).toFixed(2)}%)`,
    };
  }
  if (openSide === 'SELL' && shortNetPct >= SHORT_THESIS_MOVE_PCT) {
    return {
      exit: true,
      reason: `DESK conflict · flatten SELL vs short rally (${(shortNetPct * 100).toFixed(2)}%)`,
    };
  }
  return { exit: false, reason: '' };
}
