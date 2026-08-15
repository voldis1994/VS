/**
 * Role authorization — WireGuard alone is never enough.
 */

import type { VsRole } from './networkConstants.js';
import type { DeviceRecord } from './deviceRegistry.js';

export type NetworkService =
  | 'ADMIN_SERVICE'
  | 'CLIENT_SERVICE'
  | 'DEVICE_HEARTBEAT'
  | 'NETWORK_DIAGNOSTICS'
  | 'DEVICE_MANAGEMENT';

const ALLOW: Record<VsRole, NetworkService[]> = {
  SERVER: [
    'ADMIN_SERVICE',
    'CLIENT_SERVICE',
    'DEVICE_HEARTBEAT',
    'NETWORK_DIAGNOSTICS',
    'DEVICE_MANAGEMENT',
  ],
  OWNER_ADMIN: [
    'ADMIN_SERVICE',
    'CLIENT_SERVICE', // admin may manage client accounts via admin APIs
    'DEVICE_HEARTBEAT',
    'NETWORK_DIAGNOSTICS',
    'DEVICE_MANAGEMENT',
  ],
  CLIENT: ['CLIENT_SERVICE', 'DEVICE_HEARTBEAT'],
};

export function roleAllows(role: VsRole, service: NetworkService): boolean {
  return ALLOW[role]?.includes(service) === true;
}

export function assertServiceAccess(
  device: DeviceRecord | null | undefined,
  service: NetworkService
): { ok: true } | { ok: false; code: string; reason: string } {
  if (!device) {
    return { ok: false, code: 'UNKNOWN_DEVICE', reason: 'Device not registered' };
  }
  if (device.status === 'REVOKED') {
    return { ok: false, code: 'DEVICE_REVOKED', reason: 'Device revoked' };
  }
  if (device.status !== 'ACTIVE') {
    return { ok: false, code: 'DEVICE_NOT_ACTIVE', reason: `status=${device.status}` };
  }
  if (!roleAllows(device.role, service)) {
    return {
      ok: false,
      code: 'ROLE_DENIED',
      reason: `${device.role} cannot access ${service}`,
    };
  }
  return { ok: true };
}

/** CLIENT A cannot access CLIENT B scope. */
export function assertClientScope(
  device: DeviceRecord,
  targetClientId: number
): { ok: true } | { ok: false; code: string; reason: string } {
  if (device.role === 'OWNER_ADMIN' || device.role === 'SERVER') return { ok: true };
  if (device.role !== 'CLIENT') {
    return { ok: false, code: 'ROLE_DENIED', reason: 'Not a client device' };
  }
  if (device.client_id == null || device.client_id !== targetClientId) {
    return { ok: false, code: 'CLIENT_ISOLATION', reason: 'Cross-client access denied' };
  }
  return { ok: true };
}
