/**
 * Restore decision/trade jsonl (+ JournalMirror) from DualPersist/PG primary
 * when hot sidecars were wiped but SQL audit rows remain.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  loadDecisionEventsFromPersist,
  loadTradeEventsFromPersist,
} from './persist.js';
import { getJournalMirror } from './journalMirror.js';
import type { DecisionEvent } from './decisionJournal.js';
import type { TradeEvent } from './tradeEventJournal.js';

function stateDir(): string {
  return (
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

/**
 * If jsonl missing and persist has audit rows, rewrite sidecars and seed empty mirror.
 * Idempotent; never clears richer local jsonl.
 */
export async function hydrateAuditJournalsFromPersist(): Promise<{
  decisions: number;
  trades: number;
  wrote_jsonl: boolean;
}> {
  const dir = stateDir();
  const decisions = await loadDecisionEventsFromPersist(500);
  const trades = await loadTradeEventsFromPersist(500);
  const decPath = join(dir, 'decision_journal.jsonl');
  const tradePath = join(dir, 'trade_event_journal.jsonl');
  let wrote = false;
  try {
    mkdirSync(dir, { recursive: true });
    if (decisions.length && !existsSync(decPath)) {
      const chrono = [...decisions].reverse();
      writeFileSync(
        decPath,
        `${chrono.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf8'
      );
      wrote = true;
    }
    if (trades.length && !existsSync(tradePath)) {
      const chrono = [...trades].reverse();
      writeFileSync(
        tradePath,
        `${chrono.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf8'
      );
      wrote = true;
    }
  } catch {
    /* best-effort */
  }
  const mirror = getJournalMirror();
  if (mirror) {
    if (mirror.loadDecisions(1).length === 0 && decisions.length) {
      for (const e of [...decisions].reverse()) {
        mirror.appendDecision(e as DecisionEvent);
      }
    }
    if (mirror.loadTrades(1).length === 0 && trades.length) {
      for (const e of [...trades].reverse()) {
        mirror.appendTrade(e as TradeEvent);
      }
    }
  }
  return {
    decisions: decisions.length,
    trades: trades.length,
    wrote_jsonl: wrote,
  };
}
