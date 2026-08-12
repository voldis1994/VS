/**
 * Pipeline bridge runtime state — market-core heartbeats here so Client Panel
 * can distinguish REQUESTED vs CONFIRMED RUNNING.
 */

let lastHeartbeatAt = 0;
let lastEpics: string[] = [];
let lastError: string | null = null;

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
  analyzing_epics: string[];
  last_error: string | null;
} {
  const age = lastHeartbeatAt ? Date.now() - lastHeartbeatAt : Number.POSITIVE_INFINITY;
  const healthy = age < 45_000 && !lastError;
  return {
    healthy,
    last_heartbeat_at: lastHeartbeatAt ? new Date(lastHeartbeatAt).toISOString() : null,
    analyzing_epics: lastEpics,
    last_error: lastError,
  };
}

export function isEpicBeingAnalyzed(epic: string | null | undefined): boolean {
  if (!epic) return false;
  const e = epic.trim().toUpperCase();
  const status = getPipelineBridgeStatus();
  if (!status.healthy) return false;
  return status.analyzing_epics.some((x) => x.toUpperCase() === e);
}

/** Accept admin token OR dedicated pipeline service token. */
export function authorizePipelineRequest(headers: Record<string, unknown>): boolean {
  const admin = process.env.API_ADMIN_TOKEN;
  const pipeline = process.env.PIPELINE_SERVICE_TOKEN || admin;
  const gotAdmin = String(headers['x-admin-token'] || '');
  const gotPipe = String(headers['x-pipeline-token'] || '');

  // Dev: tokens unset / placeholder → allow (same as auth middleware)
  const adminLoose = !admin || admin === 'CHANGE_ME_ADMIN_TOKEN';
  const pipeLoose = !pipeline || pipeline === 'CHANGE_ME_ADMIN_TOKEN';
  if (process.env.NODE_ENV !== 'production' && adminLoose && pipeLoose) return true;

  if (admin && gotAdmin && gotAdmin === admin) return true;
  if (pipeline && gotPipe && gotPipe === pipeline) return true;
  return false;
}
