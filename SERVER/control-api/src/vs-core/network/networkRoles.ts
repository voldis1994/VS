/**
 * Role + service gates — delegates fine-grained checks to permissions.ts.
 * WireGuard alone is never enough.
 */

import type { VsRole } from './networkConstants.js';
import type { DeviceRecord } from './deviceRegistry.js';
import { assertPermission, assertResourceScope, type Permission } from './permissions.js';

export type NetworkService =
  | 'ADMIN_SERVICE'
  | 'CLIENT_SERVICE'
  | 'DEVICE_HEARTBEAT'
  | 'NETWORK_DIAGNOSTICS'
  | 'DEVICE_MANAGEMENT';

const SERVICE_PERMISSION: Record<NetworkService, Permission | null> = {
  ADMIN_SERVICE: 'server.read',
  CLIENT_SERVICE: 'own.profile.read',
  DEVICE_HEARTBEAT: null, // any ACTIVE device
  NETWORK_DIAGNOSTICS: 'network.manage',
  DEVICE_MANAGEMENT: 'devices.manage',
};

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
    'CLIENT_SERVICE',
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
  const perm = SERVICE_PERMISSION[service];
  if (perm) {
    // CLIENT_SERVICE uses own.profile.read which CLIENT has; ADMIN has server.read for ADMIN_SERVICE
    if (service === 'CLIENT_SERVICE' && (device.role === 'OWNER_ADMIN' || device.role === 'SERVER')) {
      return { ok: true };
    }
    if (service === 'ADMIN_SERVICE') {
      return assertPermission(device, 'server.read');
    }
    return assertPermission(device, perm);
  }
  return { ok: true };
}

/** CLIENT A cannot access CLIENT B scope. */
export function assertClientScope(
  device: DeviceRecord,
  targetClientId: number
): { ok: true } | { ok: false; code: string; reason: string } {
  return assertResourceScope(device, { client_id: targetClientId });
}

export { assertPermission, assertResourceScope };
export type { Permission };
