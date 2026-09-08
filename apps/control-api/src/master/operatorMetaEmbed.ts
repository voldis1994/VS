/**
 * Best-effort merge into master_state.json operator_meta.
 * Sidecar saves (gates/manage/owns/market_cache) call this so a wipe between
 * write and the next FilePersist flush cannot drop durable operator knobs.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { atomicWriteJson } from './atomicIo.js';

export function operatorMetaStateDir(root?: string): string {
  return (
    root ||
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

/** Merge fields into master_state.json operator_meta (best-effort). */
export function embedOperatorMetaPatch(
  patch: Record<string, unknown>,
  root?: string
): boolean {
  try {
    const dir = operatorMetaStateDir(root);
    const statePath = join(dir, 'master_state.json');
    if (!existsSync(statePath)) return false;
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as {
      operator_meta?: Record<string, unknown> | null;
      [k: string]: unknown;
    };
    raw.operator_meta = {
      ...(raw.operator_meta && typeof raw.operator_meta === 'object'
        ? raw.operator_meta
        : {}),
      ...patch,
    };
    return atomicWriteJson(statePath, raw);
  } catch {
    return false;
  }
}
