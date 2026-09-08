/**
 * Reader-style INTENT→ACK journal for LIVE crash recovery (Capital + MT4 legacy).
 * Durable rewrite map under MASTER_STATE_DIR — records INTENT before broker OPEN,
 * updates on SUCCESS/FAILED/TIMEOUT, and supplies OPEN SUCCESS rows for adopt.
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

function stateDir(): string {
  return (
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function journalPath(): string {
  return join(stateDir(), 'trade_ack_journal.json');
}

function readAll(): Record<string, TradeAckRecord> {
  try {
    const path = journalPath();
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, TradeAckRecord>;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** Atomic write + fsync so INTENT survives crash before cmd rename. */
function writeAll(map: Record<string, TradeAckRecord>): boolean {
  try {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    const path = journalPath();
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
    return true;
  } catch {
    try {
      unlinkSync(`${journalPath()}.tmp`);
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
