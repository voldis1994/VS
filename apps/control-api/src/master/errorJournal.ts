/**
 * Durable MASTER error / cycle-failure journal (Reader error_journal pattern).
 * File-backed under MASTER_STATE_DIR — survives restart for dashboard honesty.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
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
