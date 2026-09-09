/**
 * DualPersist / FilePersist mirror for Reader-style decision + trade journals.
 * JSONL remains the hot path; master_state.json keeps a durable tail so wipe of
 * sidecar jsonl does not blank Stage·journal / recent_* after restart.
 */
import type { DecisionEvent } from './decisionJournal.js';
import type { TradeEvent } from './tradeEventJournal.js';

export type JournalMirror = {
  appendDecision(entry: DecisionEvent): void;
  appendTrade(entry: TradeEvent): void;
  loadDecisions(limit: number): DecisionEvent[];
  loadTrades(limit: number): TradeEvent[];
};

let mirror: JournalMirror | null = null;

export function setJournalMirror(m: JournalMirror | null) {
  mirror = m;
}

export function getJournalMirror(): JournalMirror | null {
  return mirror;
}

export function mirrorDecisionEvent(entry: DecisionEvent) {
  try {
    mirror?.appendDecision(entry);
  } catch {
    /* never break cycle */
  }
}

export function mirrorTradeEvent(entry: TradeEvent) {
  try {
    mirror?.appendTrade(entry);
  } catch {
    /* never break cycle */
  }
}

export function loadMirroredDecisions(limit: number): DecisionEvent[] {
  try {
    return mirror?.loadDecisions(limit) ?? [];
  } catch {
    return [];
  }
}

export function loadMirroredTrades(limit: number): TradeEvent[] {
  try {
    return mirror?.loadTrades(limit) ?? [];
  } catch {
    return [];
  }
}
