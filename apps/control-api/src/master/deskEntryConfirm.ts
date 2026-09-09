/**
 * Desk entry confirm for MASTER decide — SETUP ARMED + closed 10s, else 10s MOVE.
 * Consolidates robotDesk decideEntryFromSetup / decideEntryFromTenSecMove.
 */
import {
  decideEntryFromSetup,
  decideEntryFromTenSecMove,
  type MarketSetup,
  type StructureBook,
} from '../services/marketSetup.js';
import type { CapitalPriceCandle } from '../services/capitalCom.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';

export type DeskEntryConfirm = {
  side: 'BUY' | 'SELL';
  source: 'setup' | 'move';
  reason: string;
  setup_kind: string;
  playbook: string | null;
};

/**
 * Resolve desk-style entry from sticky setup + optional closed 10s bar.
 * Returns null when no confirm (caller may WAIT setup_confirm_pending).
 */
export function resolveDeskEntryConfirm(input: {
  setup: MarketSetup | null | undefined;
  structure: StructureBook | null | undefined;
  closed_10s: TenSecBar | null | undefined;
  minutes: CapitalPriceCandle[];
}): DeskEntryConfirm | null {
  const bar = input.closed_10s;
  if (!bar) return null;
  const minutes = input.minutes || [];
  const setup = input.setup;
  if (setup && setup.status === 'ARMED' && setup.side && setup.kind !== 'NONE') {
    const fromSetup = decideEntryFromSetup(setup, bar, minutes);
    if (fromSetup) {
      return {
        side: fromSetup.direction,
        source: 'setup',
        reason: fromSetup.reason,
        setup_kind: fromSetup.setup,
        playbook: fromSetup.playbook,
      };
    }
  }
  const st = input.structure;
  if (st?.ready) {
    const fromMove = decideEntryFromTenSecMove(st, bar, minutes);
    if (fromMove) {
      return {
        side: fromMove.direction,
        source: 'move',
        reason: fromMove.reason,
        setup_kind: fromMove.setup,
        playbook: fromMove.playbook,
      };
    }
  }
  return null;
}
