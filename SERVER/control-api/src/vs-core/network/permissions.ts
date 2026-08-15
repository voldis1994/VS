/**
 * Application authorization — WireGuard alone is never enough.
 * Default DENY. Roles: OWNER_ADMIN | CLIENT.
 */

import type { VsRole } from './networkConstants.js';
import type { DeviceRecord } from './deviceRegistry.js';

export type Permission =
  // OWNER_ADMIN
  | 'server.read'
  | 'server.manage'
  | 'network.manage'
  | 'devices.manage'
  | 'clients.manage'
  | 'accounts.manage'
  | 'trading.manage'
  | 'orders.read'
  | 'positions.read'
  | 'incidents.manage'
  | 'logs.read'
  | 'backup.manage'
  | 'updates.manage'
  | 'terminal.admin'
  // CLIENT (own scope only)
  | 'own.profile.read'
  | 'own.account.read'
  | 'own.market.read'
  | 'own.market.change'
  | 'own.lot.read'
  | 'own.lot.change'
  | 'own.trading.start'
  | 'own.trading.stop'
  | 'own.positions.read'
  | 'own.history.read';

export const OWNER_ADMIN_PERMISSIONS: readonly Permission[] = [
  'server.read',
  'server.manage',
  'network.manage',
  'devices.manage',
  'clients.manage',
  'accounts.manage',
  'trading.manage',
  'orders.read',
  'positions.read',
  'incidents.manage',
  'logs.read',
  'backup.manage',
  'updates.manage',
  'terminal.admin',
] as const;

export const CLIENT_PERMISSIONS: readonly Permission[] = [
  'own.profile.read',
  'own.account.read',
  'own.market.read',
  'own.market.change',
  'own.lot.read',
  'own.lot.change',
  'own.trading.start',
  'own.trading.stop',
  'own.positions.read',
  'own.history.read',
] as const;

/** Explicit denials for CLIENT (documentation + hard checks). */
export const CLIENT_FORBIDDEN: readonly string[] = [
  'server.manage',
  'network.manage',
  'devices.manage',
  'strategy.config',
  'risk.config',
  'other.clients',
  'admin',
  'capital.credentials',
  'terminal.admin',
] as const;

export function permissionsForRole(role: VsRole): readonly Permission[] {
  if (role === 'OWNER_ADMIN' || role === 'SERVER') return OWNER_ADMIN_PERMISSIONS;
  if (role === 'CLIENT') return CLIENT_PERMISSIONS;
  return [];
}

export function hasPermission(
  role: VsRole,
  permission: Permission,
  granted?: readonly Permission[] | null
): boolean {
  const set = granted && granted.length > 0 ? granted : permissionsForRole(role);
  return set.includes(permission);
}

export function assertPermission(
  device: DeviceRecord | null | undefined,
  permission: Permission
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
  if (!hasPermission(device.role, permission, device.permissions)) {
    return {
      ok: false,
      code: 'PERMISSION_DENIED',
      reason: `${device.role} lacks ${permission}`,
    };
  }
  return { ok: true };
}

/** CLIENT A never sees CLIENT B — scope from authenticated identity only. */
export function assertResourceScope(
  device: DeviceRecord,
  resource: { client_id?: number | null; account_id?: number | null }
): { ok: true } | { ok: false; code: string; reason: string } {
  if (device.role === 'OWNER_ADMIN' || device.role === 'SERVER') return { ok: true };
  if (device.role !== 'CLIENT') {
    return { ok: false, code: 'ROLE_DENIED', reason: 'Not a client device' };
  }
  if (resource.client_id != null) {
    if (device.client_id == null || device.client_id !== resource.client_id) {
      return { ok: false, code: 'CLIENT_ISOLATION', reason: 'Cross-client access denied' };
    }
  }
  if (resource.account_id != null && device.account_id != null) {
    if (device.account_id !== resource.account_id) {
      return { ok: false, code: 'CLIENT_ISOLATION', reason: 'Cross-account access denied' };
    }
  }
  return { ok: true };
}
