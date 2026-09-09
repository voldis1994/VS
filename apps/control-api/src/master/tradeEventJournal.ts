/**
 * Reader-style append-only trade event journal (OPEN / MODIFY / CLOSE).
 * Covers paper + Capital + MT4 — complements MT4 trade_ack_journal map.
 * Durable under MASTER_STATE_DIR for crash/audit + dashboard tail.
 */
import {
  appendFileSync,
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
import { randomUUID } from 'crypto';
import { loadMirroredTrades, mirrorTradeEvent } from './journalMirror.js';

export type TradeEventKind = 'OPEN' | 'MODIFY' | 'CLOSE';

export type TradeEvent = {
  event_id: string;
  ts: string;
  event: TradeEventKind;
  broker: string;
  epic: string;
  side: string | null;
  volume: number | null;
  price: number | null;
  position_id: string | null;
  intent_id: string | null;
  /** Join key to decision journal / opportunity (Reader decision_id). */
  opportunity_id: string | null;
  ok: boolean;
  detail: string | null;
  pnl: number | null;
  fees: number | null;
};

const MAX_LINES = 2000;

function journalDir(): string {
  return (
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function journalPath(): string {
  return join(journalDir(), 'trade_event_journal.jsonl');
}

function rotateIfNeeded() {
  const path = journalPath();
  if (!existsSync(path)) return;
  try {
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    const keep = lines.slice(-MAX_LINES);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${keep.join('\n')}\n`, 'utf8');
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(`${path}.tmp`);
    } catch {
      /* ignore */
    }
  }
}

export function logTradeEvent(input: {
  event: TradeEventKind;
  broker: string;
  epic?: string | null;
  side?: string | null;
  volume?: number | null;
  price?: number | null;
  position_id?: string | null;
  intent_id?: string | null;
  opportunity_id?: string | null;
  ok: boolean;
  detail?: string | null;
  pnl?: number | null;
  fees?: number | null;
}): TradeEvent {
  const entry: TradeEvent = {
    event_id: randomUUID(),
    ts: new Date().toISOString(),
    event: input.event,
    broker: String(input.broker || 'UNKNOWN').slice(0, 24),
    epic: String(input.epic || '').slice(0, 40),
    side: input.side ? String(input.side).slice(0, 8) : null,
    volume:
      input.volume != null && Number.isFinite(input.volume)
        ? Number(input.volume)
        : null,
    price:
      input.price != null && Number.isFinite(input.price)
        ? Number(input.price)
        : null,
    position_id: input.position_id
      ? String(input.position_id).slice(0, 80)
      : null,
    intent_id: input.intent_id ? String(input.intent_id).slice(0, 80) : null,
    opportunity_id: input.opportunity_id
      ? String(input.opportunity_id).slice(0, 80)
      : null,
    ok: !!input.ok,
    detail: input.detail ? String(input.detail).slice(0, 400) : null,
    pnl:
      input.pnl != null && Number.isFinite(input.pnl) ? Number(input.pnl) : null,
    fees:
      input.fees != null && Number.isFinite(input.fees)
        ? Number(input.fees)
        : null,
  };
  try {
    mkdirSync(journalDir(), { recursive: true });
    appendFileSync(journalPath(), `${JSON.stringify(entry)}\n`);
    try {
      const fd = openSync(journalPath(), 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      /* best-effort */
    }
    rotateIfNeeded();
  } catch {
    /* never break the cycle */
  }
  mirrorTradeEvent(entry);
  return entry;
}

/** Newest-first tail for dashboard / API. */
export function loadTradeEvents(limit = 50): TradeEvent[] {
  try {
    const path = journalPath();
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const out: TradeEvent[] = [];
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        try {
          out.push(JSON.parse(lines[i]!) as TradeEvent);
        } catch {
          /* skip */
        }
      }
      if (out.length) return out;
    }
  } catch {
    /* fall through to DualPersist/FilePersist mirror */
  }
  return loadMirroredTrades(limit);
}
