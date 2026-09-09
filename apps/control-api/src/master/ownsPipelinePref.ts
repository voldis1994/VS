/**
 * Persist MASTER owns-pipeline preference across restart (dashboard toggle).
 * Also DualPersist / MemoryPersist / PG primary so a full file wipe heals.
 */
import { mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { atomicWriteJson } from './atomicIo.js';
import { embedOperatorMetaPatch } from './operatorMetaEmbed.js';
import {
  persistOwnsPipelineState,
  loadOwnsPipelineFromPersist,
} from './persist.js';

function stateDir(root?: string): string {
  return (
    root ||
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function prefPath(root?: string): string {
  return join(stateDir(root), 'owns_pipeline.json');
}

export function saveOwnsPipelinePref(on: boolean, root?: string): boolean {
  try {
    const dir = stateDir(root);
    mkdirSync(dir, { recursive: true });
    const payload = { owns_pipeline: on };
    const ok = atomicWriteJson(prefPath(root), payload);
    if (ok) {
      // Keep operator_meta in sync even when no position write flushes FilePersist
      embedOperatorMetaPatch({ owns_pipeline: on }, dir);
      // DualPersist / MemoryPersist / PG primary — survive full file wipe
      void persistOwnsPipelineState({
        owns_pipeline: on,
        saved_at_ms: Date.now(),
      }).catch(() => {});
    }
    return ok;
  } catch {
    return false;
  }
}

export function loadOwnsPipelinePref(root?: string): boolean | null {
  try {
    if (!existsSync(prefPath(root))) return null;
    const raw = JSON.parse(readFileSync(prefPath(root), 'utf8')) as {
      owns_pipeline?: boolean;
    };
    return typeof raw.owns_pipeline === 'boolean' ? raw.owns_pipeline : null;
  } catch {
    return null;
  }
}

/**
 * When owns_pipeline.json was wiped but DualPersist/PG primary still holds the
 * singleton payload, rewrite the sidecar (+ operator_meta) before disk hydrate.
 */
export async function hydrateOwnsPipelineFromPersist(
  root?: string
): Promise<{ restored: boolean }> {
  const dir = stateDir(root);
  const path = prefPath(root);
  if (existsSync(path)) return { restored: false };
  try {
    const loaded = await loadOwnsPipelineFromPersist();
    if (!loaded || typeof loaded.owns_pipeline !== 'boolean') {
      return { restored: false };
    }
    const on = loaded.owns_pipeline === true;
    mkdirSync(dir, { recursive: true });
    atomicWriteJson(path, { owns_pipeline: on });
    embedOperatorMetaPatch({ owns_pipeline: on }, dir);
    return { restored: true };
  } catch {
    return { restored: false };
  }
}
