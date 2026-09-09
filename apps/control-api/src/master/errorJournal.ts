/**
 * Durable MASTER error / cycle-failure journal (Reader error_journal pattern).
 * File-backed under MASTER_STATE_DIR — survives restart for dashboard honesty.
 * Also DualPersist / MemoryPersist / PG primary so a full file wipe heals.
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
import {
  persistErrorJournalState,
  loadErrorJournalFromPersist,
} from './persist.js';
import { embedOperatorMetaPatch } from './operatorMetaEmbed.js';

export type MasterErrorEntry = {
  error_id: string;
  ts: string;
  module: string;
  error_type: string;
  message: string;
  context?: Record<string, unknown> | null;
};

const MAX_LINES = 500;

function journalDir(root?: string): string {
  return (
    root ||
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function journalPath(root?: string): string {
  return join(journalDir(root), 'error_journal.jsonl');
}

function readAllEntries(root?: string): MasterErrorEntry[] {
  try {
    const path = journalPath(root);
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const out: MasterErrorEntry[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as MasterErrorEntry;
        if (e && typeof e === 'object' && e.error_id) out.push(e);
      } catch {
        /* skip corrupt */
      }
    }
    return out.slice(-MAX_LINES);
  } catch {
    return [];
  }
}

function dualWriteEntries(entries: MasterErrorEntry[], root?: string): void {
  const keep = entries.slice(-MAX_LINES);
  embedOperatorMetaPatch(
    { error_journal: { entries: keep } },
    journalDir(root)
  );
  void persistErrorJournalState({
    entries: keep,
    saved_at_ms: Date.now(),
  }).catch(() => {});
}

function rotateIfNeeded(root?: string) {
  const path = journalPath(root);
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
    dualWriteEntries(
      keep
        .map((l) => {
          try {
            return JSON.parse(l) as MasterErrorEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is MasterErrorEntry => !!e && !!e.error_id),
      root
    );
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
    dualWriteEntries(readAllEntries());
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

/**
 * When error_journal.jsonl was wiped but DualPersist/PG primary still holds
 * the singleton payload, rewrite the sidecar before dashboard status reads.
 */
export async function hydrateErrorJournalFromPersist(
  root?: string
): Promise<{ restored: boolean; count: number }> {
  const dir = journalDir(root);
  const path = journalPath(root);
  if (existsSync(path)) return { restored: false, count: 0 };
  try {
    const loaded = await loadErrorJournalFromPersist();
    if (!loaded || typeof loaded !== 'object') {
      return { restored: false, count: 0 };
    }
    const entries = Array.isArray(loaded.entries)
      ? (loaded.entries as MasterErrorEntry[]).filter(
          (e) => e && typeof e === 'object' && !!e.error_id
        )
      : [];
    if (entries.length < 1) return { restored: false, count: 0 };
    mkdirSync(dir, { recursive: true });
    const keep = entries.slice(-MAX_LINES);
    const body = `${keep.map((e) => JSON.stringify(e)).join('\n')}\n`;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, path);
    embedOperatorMetaPatch({ error_journal: { entries: keep } }, dir);
    return { restored: true, count: keep.length };
  } catch {
    return { restored: false, count: 0 };
  }
}
