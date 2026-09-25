/**
 * After ACCEPTed .ts patches, schedule a soft API restart when all robots are FLAT.
 * Avoids mid-trade `tsx watch` death (Failed to fetch / LIVE LOG stale).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../');
}

export function brainReloadFlagPath(): string {
  return path.join(repoRoot(), 'data', 'brain-self-improve', 'reload-needed.json');
}

/** Exit code the live-loop treats as “restart me for new BRAIN code”. */
export const BRAIN_RELOAD_EXIT_CODE = 75;

export type BrainReloadRequest = {
  at: string;
  cycle_id: string;
  reason: string;
  files: string[];
};

export function requestBrainCodeReload(input: {
  cycle_id: string;
  reason?: string;
  files?: string[];
}): void {
  const p = brainReloadFlagPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body: BrainReloadRequest = {
    at: new Date().toISOString(),
    cycle_id: input.cycle_id,
    reason: input.reason || 'ACCEPTED trading .ts patches',
    files: input.files || [],
  };
  fs.writeFileSync(p, JSON.stringify(body, null, 2) + '\n', 'utf8');
}

export function clearBrainReloadRequest(): void {
  const p = brainReloadFlagPath();
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

export function hasBrainReloadRequest(): boolean {
  try {
    return fs.existsSync(brainReloadFlagPath());
  } catch {
    return false;
  }
}

/**
 * If reload requested and no open trades, exit so live-loop can restart with new code.
 * Safe to call at end of every robot cycle.
 */
export function maybeExitForBrainCodeReload(opts: {
  anyOpenTrade: boolean;
}): void {
  if (!hasBrainReloadRequest()) return;
  if (opts.anyOpenTrade) return;
  clearBrainReloadRequest();
  console.log(
    `[brain] code reload — all FLAT · exit ${BRAIN_RELOAD_EXIT_CODE} (live-loop restart)`
  );
  setTimeout(() => process.exit(BRAIN_RELOAD_EXIT_CODE), 150);
}
