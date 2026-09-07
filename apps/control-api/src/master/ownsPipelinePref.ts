/**
 * Persist MASTER owns-pipeline preference across restart (dashboard toggle).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

function stateDir(): string {
  return (
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function prefPath(): string {
  return join(stateDir(), 'owns_pipeline.json');
}

export function saveOwnsPipelinePref(on: boolean): boolean {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(prefPath(), JSON.stringify({ owns_pipeline: on }));
    return true;
  } catch {
    return false;
  }
}

export function loadOwnsPipelinePref(): boolean | null {
  try {
    if (!existsSync(prefPath())) return null;
    const raw = JSON.parse(readFileSync(prefPath(), 'utf8')) as {
      owns_pipeline?: boolean;
    };
    return typeof raw.owns_pipeline === 'boolean' ? raw.owns_pipeline : null;
  } catch {
    return null;
  }
}
