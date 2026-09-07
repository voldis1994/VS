/**
 * Persist post-loss / reject cooldowns across restart.
 * File-backed (MASTER_STATE_DIR) — works for standalone and as dual mirror for API.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

export type RuntimeGates = {
  last_loss_ms: number;
  reject_until_ms: number;
};

function gatesDir(): string {
  return (
    process.env.MASTER_STATE_DIR ||
    process.env.MASTER_GATES_DIR ||
    join(process.cwd(), '.master-state')
  );
}

function gatesPath(): string {
  return join(gatesDir(), 'runtime_gates.json');
}

export function saveRuntimeGates(gates: RuntimeGates): boolean {
  try {
    mkdirSync(gatesDir(), { recursive: true });
    writeFileSync(gatesPath(), JSON.stringify(gates));
    return true;
  } catch {
    return false;
  }
}

export function loadRuntimeGates(): RuntimeGates | null {
  try {
    const path = gatesPath();
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as RuntimeGates;
    return {
      last_loss_ms: Number(raw.last_loss_ms) || 0,
      reject_until_ms: Number(raw.reject_until_ms) || 0,
    };
  } catch {
    return null;
  }
}
