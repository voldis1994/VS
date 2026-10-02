/**
 * After ACCEPTed .ts patches, schedule a soft API restart when all robots are FLAT.
 * Avoids mid-trade `tsx watch` death (Failed to fetch / LIVE LOG stale).
 *
 * CRITICAL: only `process.exit(75)` when CONTROL_API_LIVE_LOOP=1 (VS.bat live-loop).
 * Without the loop, exit 75 kills control-api permanently → empty board / Failed to fetch.
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

export const LIVE_LOOP_ENV = 'CONTROL_API_LIVE_LOOP';

export type BrainReloadRequest = {
  at: string;
  cycle_id: string;
  reason: string;
  files: string[];
};

export function isControlApiLiveLoop(): boolean {
  const v = String(process.env[LIVE_LOOP_ENV] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

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
 * Stale flag after crash / old `npm run dev` must not kill API on boot.
 * Live-loop keeps the flag so FLAT restart can happen; bare API clears it.
 */
export function clearStaleBrainReloadOnBoot(): void {
  if (!hasBrainReloadRequest()) return;
  if (isControlApiLiveLoop()) {
    console.log(
      '[brain] reload-needed present — will soft-restart after trade close or when no robots running (live-loop)'
    );
    return;
  }
  clearBrainReloadRequest();
  console.warn(
    '[brain] cleared stale reload-needed.json (not in live-loop). ' +
      'Use VS.bat / control-api-live-loop so BRAIN .ts reloads do not kill the desk.'
  );
}

/**
 * Soft-reload windows:
 * - Idle desk (no robots running) — heartbeat / STOP
 * - Between trades (`betweenTrades`) — right after a close, then auto-resume
 *
 * NEVER during open trade, and NEVER during SEEDING/ARMED unless betweenTrades.
 */
export function maybeExitForBrainCodeReload(opts: {
  anyOpenTrade: boolean;
  /** True if any robot session is running (even FLAT / ARMED). */
  anyRobotRunning?: boolean;
  /**
   * After a confirmed close — allow exit even if robots still "running".
   * Caller must persist robot-resume.json so boot restarts them.
   */
  betweenTrades?: boolean;
}): void {
  if (!hasBrainReloadRequest()) return;
  if (opts.anyOpenTrade) return;
  if (!opts.betweenTrades && opts.anyRobotRunning) return;
  if (!isControlApiLiveLoop()) {
    // Never process.exit here — that left EMPTY BOARD + Failed to fetch forever
    return;
  }
  clearBrainReloadRequest();
  const why = opts.betweenTrades ? 'after trade close' : 'no robots running';
  console.log(
    `[brain] code reload — ${why} · exit ${BRAIN_RELOAD_EXIT_CODE} (live-loop restart)`
  );
  setTimeout(() => process.exit(BRAIN_RELOAD_EXIT_CODE), 150);
}
