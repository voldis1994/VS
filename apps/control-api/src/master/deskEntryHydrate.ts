/** Backfill desk_entry_source onto open positions after restart / hydrate. */
import {
  normalizeDeskConfirmSource,
  type DeskConfirmSource,
} from './decision.js';
import type { MasterDecision } from './types.js';

export type DeskEntryBackfillPos = {
  opportunity_id: string;
  decision: MasterDecision;
};

export type DeskEntryBackfillSources = {
  opportunities?: Array<{
    id: string;
    decision?: { desk_entry_source?: string | null } | null;
  }>;
  decisions?: Array<{
    opportunity_id: string | null;
    desk_entry_source?: string | null;
  }>;
};

function sourceFromRaw(raw?: string | null): DeskConfirmSource | null {
  if (raw === 'setup' || raw === 'move' || raw === 'none') return raw;
  if (raw == null || raw === '') return null;
  return normalizeDeskConfirmSource(raw);
}

/**
 * Resolve confirm provenance for an open position.
 * Prefer already-stamped decision, then opportunity.decision, then DecisionEvent.
 * Returns null when unknown (caller must not invent setup/move).
 */
export function resolveDeskEntrySourceForPosition(
  pos: DeskEntryBackfillPos,
  sources: DeskEntryBackfillSources
): DeskConfirmSource | null {
  const stamped = sourceFromRaw(pos.decision?.desk_entry_source);
  if (stamped) return stamped;

  const oppId = String(pos.opportunity_id || '');
  if (oppId) {
    const opp = (sources.opportunities || []).find(
      (o) => String(o.id) === oppId
    );
    const fromOpp = sourceFromRaw(opp?.decision?.desk_entry_source);
    if (fromOpp) return fromOpp;

    for (const d of sources.decisions || []) {
      if (String(d.opportunity_id || '') !== oppId) continue;
      const fromEv = sourceFromRaw(d.desk_entry_source);
      if (fromEv && fromEv !== 'none') return fromEv;
    }
    for (const d of sources.decisions || []) {
      if (String(d.opportunity_id || '') !== oppId) continue;
      const fromEv = sourceFromRaw(d.desk_entry_source);
      if (fromEv) return fromEv;
    }
  }
  return null;
}

/** Mutate positions missing desk_entry_source; returns count updated. */
export function backfillDeskEntrySources(
  positions: DeskEntryBackfillPos[],
  sources: DeskEntryBackfillSources
): number {
  let n = 0;
  for (const pos of positions) {
    if (!pos.decision) continue;
    const existing = sourceFromRaw(pos.decision.desk_entry_source);
    if (existing) {
      if (pos.decision.desk_entry_source !== existing) {
        pos.decision = { ...pos.decision, desk_entry_source: existing };
        n += 1;
      }
      continue;
    }
    const resolved = resolveDeskEntrySourceForPosition(pos, sources);
    if (!resolved) continue;
    pos.decision = { ...pos.decision, desk_entry_source: resolved };
    n += 1;
  }
  return n;
}
