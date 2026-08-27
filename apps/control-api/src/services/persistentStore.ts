/**
 * File-backed persistence for BO / pending execution / risk window (#27/#28).
 * Survives process crash within the data directory.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIR =
  process.env.VS_LIVE_STATE_DIR ||
  path.join(process.cwd(), '.vs-live-state');

function ensureDir(dir = DEFAULT_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._:-]/g, '_');
}

export function persistJson(namespace: string, key: string, value: unknown): void {
  const dir = ensureDir(path.join(DEFAULT_DIR, namespace));
  const file = path.join(dir, `${safeKey(key)}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 0), 'utf8');
  fs.renameSync(tmp, file);
}

export function loadJson<T = unknown>(namespace: string, key: string): T | null {
  const file = path.join(DEFAULT_DIR, namespace, `${safeKey(key)}.json`);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function deleteJson(namespace: string, key: string): void {
  const file = path.join(DEFAULT_DIR, namespace, `${safeKey(key)}.json`);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

export function listJsonKeys(namespace: string): string[] {
  const dir = path.join(DEFAULT_DIR, namespace);
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/** Test helper — wipe namespace. */
export function resetPersistNamespace(namespace: string): void {
  const dir = path.join(DEFAULT_DIR, namespace);
  try {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch {
    /* ignore */
  }
}

export function persistRootDir(): string {
  return ensureDir();
}
