/**
 * Reader-style append-only decision / cycle event journal.
 * Durable under MASTER_STATE_DIR — WAIT/BLOCK/TRADE audit survives restart.
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

export type DecisionEvent = {
  event_id: string;
  ts: string;
  kind: string;
  epic: string;
  mode: string;
  /** Join key to opportunity / trade events (Reader decision_id). */
  opportunity_id: string | null;
  buy_score: number;
  sell_score: number;
  block_reason: string | null;
  executed: boolean;
  execution_detail: string | null;
  cycle_ms: number | null;
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
  return join(journalDir(), 'decision_journal.jsonl');
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

export function logDecisionEvent(input: {
  kind: string;
  epic: string;
  mode: string;
  opportunity_id?: string | null;
  buy_score?: number;
  sell_score?: number;
  block_reason?: string | null;
  executed?: boolean;
  execution_detail?: string | null;
  cycle_ms?: number | null;
}): DecisionEvent {
  const entry: DecisionEvent = {
    event_id: randomUUID(),
    ts: new Date().toISOString(),
    kind: String(input.kind || 'WAIT').slice(0, 40),
    epic: String(input.epic || '').slice(0, 40),
    mode: String(input.mode || 'PAPER').slice(0, 16),
    opportunity_id: input.opportunity_id
      ? String(input.opportunity_id).slice(0, 80)
      : null,
    buy_score: Number(input.buy_score) || 0,
    sell_score: Number(input.sell_score) || 0,
    block_reason: input.block_reason ?? null,
    executed: !!input.executed,
    execution_detail: input.execution_detail
      ? String(input.execution_detail).slice(0, 400)
      : null,
    cycle_ms:
      input.cycle_ms != null && Number.isFinite(input.cycle_ms)
        ? Math.round(Number(input.cycle_ms))
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
  return entry;
}

/** Newest-first tail for dashboard / API. */
export function loadDecisionEvents(limit = 50): DecisionEvent[] {
  try {
    const path = journalPath();
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const out: DecisionEvent[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]!) as DecisionEvent);
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}
