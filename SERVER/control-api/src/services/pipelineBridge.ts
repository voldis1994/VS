/**
 * Pipeline bridge runtime state — market-core heartbeats here so Client Panel
 * can distinguish REQUESTED vs CONFIRMED RUNNING.
 *
 * Auth: internal service only via x-pipeline-token.
 * Secret: PIPELINE_TOKEN or PIPELINE_SERVICE_TOKEN (never admin / never client).
 */

import { timingSafeEqual } from 'node:crypto';

let lastHeartbeatAt = 0;
let lastEpics: string[] = [];
let lastError: string | null = null;

/** Freshness window for Market Core alive. */
export const PIPELINE_HEARTBEAT_STALE_MS = 45_000;

const PLACEHOLDERS = new Set([
  '',
  'CHANGE_ME',
  'CHANGE_ME_ADMIN_TOKEN',
  'CHANGE_ME_PIPELINE_TOKEN',
]);

/** Shared Market Core ↔ Control API secret from environment (no hardcoded values). */
export function getPipelineServiceSecret(): string | null {
  const raw =
    process.env.PIPELINE_TOKEN ||
    process.env.PIPELINE_SERVICE_TOKEN ||
    '';
  const v = String(raw).trim();
  if (!v || PLACEHOLDERS.has(v)) return null;
  return v;
}

export function isPipelineSecretConfigured(): boolean {
  return getPipelineServiceSecret() != null;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Authorize internal pipeline requests.
 * - Only x-pipeline-token (not client session, not admin browser token).
 * - Production: missing secret → reject (fail closed).
 * - Dev without secret: allow only when NODE_ENV !== 'production' (local DX).
 */
export function authorizePipelineRequest(headers: Record<string, unknown>): boolean {
  const expected = getPipelineServiceSecret();
  const got = String(headers['x-pipeline-token'] || '').trim();

  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      return false; // fail closed — never open pipeline without secret
    }
    // Non-production + unset secret: allow local bridge without token
    return true;
  }

  if (!got) return false;
  return safeEqual(got, expected);
}

export function notePipelineHeartbeat(epics: string[]): void {
  lastHeartbeatAt = Date.now();
  lastEpics = [...new Set(epics.map((e) => e.trim()).filter(Boolean))];
  lastError = null;
}

export function notePipelineBridgeError(error: string): void {
  lastError = error;
}

/** Test helper — clear in-memory bridge state. */
export function resetPipelineBridgeForTests(): void {
  lastHeartbeatAt = 0;
  lastEpics = [];
  lastError = null;
}

export function getPipelineBridgeStatus(): {
  healthy: boolean;
  last_heartbeat_at: string | null;
  last_market_core_heartbeat: string | null;
  analyzing_epics: string[];
  last_error: string | null;
  age_ms: number | null;
} {
  const age = lastHeartbeatAt ? Date.now() - lastHeartbeatAt : null;
  const healthy =
    age != null && age < PIPELINE_HEARTBEAT_STALE_MS && !lastError;
  const iso = lastHeartbeatAt ? new Date(lastHeartbeatAt).toISOString() : null;
  return {
    healthy,
    last_heartbeat_at: iso,
    last_market_core_heartbeat: iso,
    analyzing_epics: lastEpics,
    last_error: lastError,
    age_ms: age,
  };
}

export function isEpicBeingAnalyzed(epic: string | null | undefined): boolean {
  if (!epic) return false;
  const e = epic.trim().toUpperCase();
  const status = getPipelineBridgeStatus();
  if (!status.healthy) return false;
  return status.analyzing_epics.some((x) => x.toUpperCase() === e);
}
