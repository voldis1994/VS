/**
 * Persist per-epic sticky SETUP + cycle evidence so GOLD↔SILVER desk ticks
 * survive restart (not memory-only Maps).
 * Embeds into master_state.json operator_meta for DualPersist / sidecar heal.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteJson } from './atomicIo.js';
import { embedOperatorMetaPatch } from './operatorMetaEmbed.js';
import type { MarketSetup, StructureBook } from '../services/marketSetup.js';

export type EpicSetupSnap = {
  setup: MarketSetup | null;
  structure: StructureBook | null;
};

export type EpicCycleRow = {
  at: string;
  market_setup: {
    kind: string;
    side: 'BUY' | 'SELL' | null;
    status: string;
    reason: string;
    confirm: number;
  } | null;
  last_market: {
    ok: boolean;
    quality: number;
    reasons: string[];
    bars_in: number;
    bars_out: number;
  } | null;
  decision_kind: string | null;
  buy_score: number | null;
  sell_score: number | null;
};

export type EpicCycleStashState = {
  at: string;
  setups_by_epic: Record<string, EpicSetupSnap>;
  cycles_by_epic: Record<string, EpicCycleRow>;
  saved_at_ms: number;
};

function stashPath(root: string) {
  return join(root, 'epic_cycle_stash.json');
}

export function epicCycleStashDir(root?: string): string {
  return (
    root ||
    process.env.MASTER_STATE_DIR ||
    join(process.cwd(), '.master-state')
  );
}

export function embedEpicCycleStashInOperatorMeta(
  state: EpicCycleStashState,
  root?: string
): boolean {
  return embedOperatorMetaPatch({ epic_cycle_stash: state }, root);
}

export function saveEpicCycleStash(
  input: {
    setups_by_epic: Record<string, EpicSetupSnap>;
    cycles_by_epic: Record<string, EpicCycleRow>;
  },
  root?: string
): boolean {
  try {
    const dir = epicCycleStashDir(root);
    const setups = input.setups_by_epic || {};
    const cycles = input.cycles_by_epic || {};
    if (!Object.keys(setups).length && !Object.keys(cycles).length) return false;
    const state: EpicCycleStashState = {
      at: new Date().toISOString(),
      setups_by_epic: setups,
      cycles_by_epic: cycles,
      saved_at_ms: Date.now(),
    };
    atomicWriteJson(stashPath(dir), state);
    embedEpicCycleStashInOperatorMeta(state, dir);
    return true;
  } catch {
    return false;
  }
}

export function loadEpicCycleStash(root?: string): EpicCycleStashState | null {
  try {
    const path = stashPath(epicCycleStashDir(root));
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as EpicCycleStashState;
    if (!raw || typeof raw !== 'object') return null;
    const setups =
      raw.setups_by_epic && typeof raw.setups_by_epic === 'object'
        ? raw.setups_by_epic
        : {};
    const cycles =
      raw.cycles_by_epic && typeof raw.cycles_by_epic === 'object'
        ? raw.cycles_by_epic
        : {};
    if (!Object.keys(setups).length && !Object.keys(cycles).length) return null;
    return {
      at: String(raw.at || ''),
      setups_by_epic: setups,
      cycles_by_epic: cycles,
      saved_at_ms: Number(raw.saved_at_ms) || 0,
    };
  } catch {
    return null;
  }
}
