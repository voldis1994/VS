/**
 * Application session auth layered on top of WireGuard identity.
 * Reconnect restores session metadata only — never re-issues trading commands.
 */

import { randomUUID } from 'crypto';
import type { DeviceRegistry, DeviceRecord } from './deviceRegistry.js';
import { assertServiceAccess, type NetworkService } from './networkRoles.js';

export type AppSession = {
  session_id: string;
  device_id: string;
  role: string;
  client_id: number | null;
  account_id: number | null;
  created_at: string;
  last_seen: string;
};

const sessions = new Map<string, AppSession>();

export function clearAppSessionsForTests(): void {
  sessions.clear();
}

export function invalidateDeviceSessions(deviceId: string): number {
  let n = 0;
  for (const [id, s] of sessions) {
    if (s.device_id === deviceId) {
      sessions.delete(id);
      n += 1;
    }
  }
  return n;
}

export function authenticateDevice(
  registry: DeviceRegistry,
  input: { device_id: string; device_token: string }
):
  | { ok: true; session: AppSession; device: DeviceRecord }
  | { ok: false; code: string; reason: string } {
  const device = registry.get(input.device_id);
  if (!device) return { ok: false, code: 'UNKNOWN_DEVICE', reason: 'not registered' };
  if (device.status === 'REVOKED') {
    return { ok: false, code: 'DEVICE_REVOKED', reason: 'revoked' };
  }
  if (device.status !== 'ACTIVE') {
    return { ok: false, code: 'DEVICE_NOT_ACTIVE', reason: device.status };
  }
  if (!registry.verifyDeviceToken(input.device_id, input.device_token)) {
    return { ok: false, code: 'INVALID_KEY', reason: 'device token mismatch' };
  }
  const session_id = randomUUID();
  const now = new Date().toISOString();
  const session: AppSession = {
    session_id,
    device_id: device.device_id,
    role: device.role,
    client_id: device.client_id,
    account_id: device.account_id,
    created_at: now,
    last_seen: now,
  };
  sessions.set(session_id, session);
  registry.heartbeat(device.device_id, { session_id, latency_ms: null });
  return { ok: true, session, device };
}

export function resolveSession(sessionId: string | undefined | null): AppSession | null {
  if (!sessionId) return null;
  return sessions.get(sessionId) || null;
}

export function touchSession(sessionId: string): AppSession | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.last_seen = new Date().toISOString();
  return s;
}

export function authorizeSession(
  registry: DeviceRegistry,
  sessionId: string | undefined | null,
  service: NetworkService
):
  | { ok: true; session: AppSession; device: DeviceRecord }
  | { ok: false; code: string; reason: string } {
  const session = resolveSession(sessionId);
  if (!session) return { ok: false, code: 'EXPIRED_SESSION', reason: 'no session' };
  const device = registry.get(session.device_id);
  if (!device) return { ok: false, code: 'UNKNOWN_DEVICE', reason: 'gone' };
  if (device.status === 'REVOKED') {
    invalidateDeviceSessions(device.device_id);
    return { ok: false, code: 'DEVICE_REVOKED', reason: 'revoked' };
  }
  const access = assertServiceAccess(device, service);
  if (!access.ok) return access;
  touchSession(session.session_id);
  return { ok: true, session, device };
}

/**
 * Reconnect: refresh heartbeat/session liveness WITHOUT emitting trading commands.
 * Returns reconnect metadata only.
 */
export function reconnectSession(
  registry: DeviceRegistry,
  sessionId: string
):
  | { ok: true; session: AppSession; trading_commands_replayed: false }
  | { ok: false; code: string; reason: string } {
  const session = resolveSession(sessionId);
  if (!session) return { ok: false, code: 'EXPIRED_SESSION', reason: 'reconnect requires valid session' };
  const device = registry.get(session.device_id);
  if (!device || device.status !== 'ACTIVE') {
    return { ok: false, code: 'DEVICE_NOT_ACTIVE', reason: 'cannot reconnect' };
  }
  touchSession(sessionId);
  registry.heartbeat(device.device_id, { session_id: sessionId });
  return { ok: true, session, trading_commands_replayed: false };
}
