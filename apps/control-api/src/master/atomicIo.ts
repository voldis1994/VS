/**
 * Reader-style atomic JSON / text IO — tmp + fsync + rename.
 * Used for durable MASTER state so crash mid-write cannot truncate recovery.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname } from 'path';

/** Write UTF-8 text atomically (tmp → fsync → rename → fsync dest). */
export function atomicWriteText(path: string, body: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, body, 'utf8');
    try {
      const fd = openSync(tmp, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      /* best-effort fsync */
    }
    renameSync(tmp, path);
    try {
      const fd = openSync(path, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      /* best-effort fsync */
    }
    return true;
  } catch {
    try {
      unlinkSync(`${path}.tmp`);
    } catch {
      /* ignore */
    }
    return false;
  }
}

export function atomicWriteJson(path: string, value: unknown): boolean {
  return atomicWriteText(path, JSON.stringify(value, null, 2));
}

/**
 * Stable bridge read — refuse while sibling `.tmp` exists or size/mtime churns
 * (Reader atomic_read_text). Returns null on torn / missing / unstable.
 */
export function stableReadText(path: string, retries = 3): string | null {
  const tmp = `${path}.tmp`;
  for (let i = 0; i < retries; i++) {
    if (existsSync(tmp)) continue;
    if (!existsSync(path)) return null;
    try {
      const a = statSync(path);
      const body = readFileSync(path, 'utf8');
      const b = statSync(path);
      if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) continue;
      return body;
    } catch {
      /* retry */
    }
  }
  return null;
}

export function stableReadJson(path: string): unknown | null {
  const body = stableReadText(path);
  if (body == null) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
