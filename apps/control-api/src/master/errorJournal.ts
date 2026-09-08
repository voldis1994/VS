/**
 * Durable MASTER error / cycle-failure journal (Reader error_journal pattern).
 * File-backed under MASTER_STATE_DIR — survives restart for dashboard honesty.
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

export type MasterErrorEntry = {
  error_id: string;
  ts: string;
  module: string;
  error_type: string;
  message: string;
  context?: Record<string, unknown> | null;
};

const MAX_LINES = 500;

function journalDir(): string {
  return (
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function journalPath(): string {
  return join(journalDir(), 'error_journal.jsonl');
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

export function logMasterError(input: {
  module: string;
  error_type: string;
  message: string;
  context?: Record<string, unknown> | null;
}): MasterErrorEntry {
  const entry: MasterErrorEntry = {
    error_id: randomUUID(),
    ts: new Date().toISOString(),
    module: String(input.module || 'master').slice(0, 80),
    error_type: String(input.error_type || 'error').slice(0, 80),
    message: String(input.message || '').slice(0, 800),
    context: input.context ?? null,
  };
  try {
    mkdirSync(journalDir(), { recursive: true });
    appendFileSync(journalPath(), `${JSON.stringify(entry)}\n`);
    // Reader: fsync so last cycle error survives crash
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
    // Never throw from error journal — logging must not break the cycle
  }
  return entry;
}

/** Newest-first tail of durable errors (for dashboard / status). */
export function loadMasterErrors(limit = 50): MasterErrorEntry[] {
  try {
    const path = journalPath();
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const out: MasterErrorEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]!) as MasterErrorEntry);
      } catch {
        /* skip corrupt */
      }
    }
    return out;
  } catch {
    return [];
  }
}
