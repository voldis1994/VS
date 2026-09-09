/**
 * Reader-style INTENT→ACK journal for LIVE crash recovery (Capital + MT4 legacy).
 * Durable rewrite map under MASTER_STATE_DIR — records INTENT before broker OPEN,
 * updates on SUCCESS/FAILED/TIMEOUT, and supplies OPEN SUCCESS rows for adopt.
 * Also DualPersist / MemoryPersist / PG primary so a full file wipe heals.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import type { Side } from './types.js';
import {
  persistTradeAckJournalState,
  loadTradeAckJournalFromPersist,
} from './persist.js';

export type TradeAckStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'TIMEOUT';

export type TradeAckRecord = {
  command_id: string;
  intent_id: string;
  action: 'OPEN' | 'CLOSE' | 'MODIFY';
  side: Side | null;
  volume: number;
  epic: string;
  ack_status: TradeAckStatus;
  ticket: string | null;
  fill_price: number | null;
  sl: number | null;
  tp: number | null;
  reason: string;
  ts_intent: string;
  ts_ack: string | null;
};

function stateDir(root?: string): string {
  return (
    root ||
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function journalPath(root?: string): string {
  return join(stateDir(root), 'trade_ack_journal.json');
}

function readAll(root?: string): Record<string, TradeAckRecord> {
  try {
    const path = journalPath(root);
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      TradeAckRecord
    >;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** Atomic write + fsync so INTENT survives crash before cmd rename. */
function writeAll(
  map: Record<string, TradeAckRecord>,
  root?: string
): boolean {
  try {
    const dir = stateDir(root);
    mkdirSync(dir, { recursive: true });
    const path = journalPath(root);
    const tmp = `${path}.tmp`;
    const body = JSON.stringify(map, null, 2);
    writeFileSync(tmp, body, 'utf8');
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    const fd2 = openSync(path, 'r+');
    try {
      fsyncSync(fd2);
    } finally {
      closeSync(fd2);
    }
    // DualPersist / MemoryPersist / PG primary — survive full file wipe
    void persistTradeAckJournalState({
      records: map,
      saved_at_ms: Date.now(),
    }).catch(() => {});
    return true;
  } catch {
    try {
      unlinkSync(`${journalPath(root)}.tmp`);
    } catch {
      /* ignore */
    }
    return false;
  }
}

export function logTradeIntent(
  input: Omit<TradeAckRecord, 'ack_status' | 'ticket' | 'fill_price' | 'ts_ack' | 'ts_intent'> & {
    ticket?: string | null;
    fill_price?: number | null;
  }
): boolean {
  const map = readAll();
  const rec: TradeAckRecord = {
    command_id: input.command_id,
    intent_id: input.intent_id,
    action: input.action,
    side: input.side,
    volume: input.volume,
    epic: input.epic,
    ack_status: 'PENDING',
    ticket: input.ticket ?? null,
    fill_price: input.fill_price ?? null,
    sl: input.sl,
    tp: input.tp,
    reason: input.reason || 'INTENT',
    ts_intent: new Date().toISOString(),
    ts_ack: null,
  };
  map[input.command_id] = rec;
  return writeAll(map);
}

export function updateTradeAck(
  command_id: string,
  patch: {
    ack_status: TradeAckStatus;
    ticket?: string | null;
    fill_price?: number | null;
    detail?: string;
  }
): boolean {
  const map = readAll();
  const prev = map[command_id];
  if (!prev) return false;
  map[command_id] = {
    ...prev,
    ack_status: patch.ack_status,
    ticket: patch.ticket !== undefined ? patch.ticket : prev.ticket,
    fill_price: patch.fill_price !== undefined ? patch.fill_price : prev.fill_price,
    reason: patch.detail || prev.reason,
    ts_ack: new Date().toISOString(),
  };
  return writeAll(map);
}

export function loadTradeAckJournal(): TradeAckRecord[] {
  return Object.values(readAll());
}

/** OPEN SUCCESS with ticket not yet in local book — crash between ack and register. */
export function findOpenSuccessUnbooked(
  bookedIds: Set<string>
): TradeAckRecord[] {
  return loadTradeAckJournal().filter(
    (r) =>
      r.action === 'OPEN' &&
      r.ack_status === 'SUCCESS' &&
      !!r.ticket &&
      r.side != null &&
      r.volume > 0 &&
      !bookedIds.has(r.ticket)
  );
}

/**
 * Reader-style republish guard — refuse OPEN when INTENT already PENDING/SUCCESS
 * for the same intent_id (survives process restart; memory Set alone does not).
 */
export function findOpenIntentBlocker(intentId: string): TradeAckRecord | null {
  if (!intentId) return null;
  const hit = loadTradeAckJournal().find(
    (r) =>
      r.action === 'OPEN' &&
      r.intent_id === intentId &&
      (r.ack_status === 'PENDING' || r.ack_status === 'SUCCESS')
  );
  return hit ?? null;
}

/** Test helper — wipe journal file. */
export function clearTradeAckJournalForTest(): void {
  writeAll({});
}

/**
 * When trade_ack_journal.json was wiped but DualPersist/PG primary still holds
 * the singleton payload, rewrite the sidecar before adopt/load.
 */
export async function hydrateTradeAckJournalFromPersist(
  root?: string
): Promise<{ restored: boolean; count: number }> {
  const dir = stateDir(root);
  const path = journalPath(root);
  if (existsSync(path)) return { restored: false, count: 0 };
  try {
    const loaded = await loadTradeAckJournalFromPersist();
    if (!loaded || typeof loaded !== 'object') {
      return { restored: false, count: 0 };
    }
    const recordsRaw =
      loaded.records && typeof loaded.records === 'object'
        ? (loaded.records as Record<string, unknown>)
        : null;
    if (!recordsRaw) return { restored: false, count: 0 };
    const map: Record<string, TradeAckRecord> = {};
    for (const [k, v] of Object.entries(recordsRaw)) {
      if (!v || typeof v !== 'object') continue;
      const rec = v as TradeAckRecord;
      if (!rec.command_id || !rec.action) continue;
      map[k] = rec;
    }
    if (Object.keys(map).length < 1) return { restored: false, count: 0 };
    mkdirSync(dir, { recursive: true });
    // Write sidecar only — do not re-INSERT (would no-op / race); primary already has it
    const body = JSON.stringify(map, null, 2);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
    return { restored: true, count: Object.keys(map).length };
  } catch {
    return { restored: false, count: 0 };
  }
}
