/**
 * VS Private Network constants — WireGuard addressing.
 * Subnet 10.77.0.0/16:
 *   SERVER  10.77.0.1
 *   ADMIN   10.77.0.0/24  (0.2+)
 *   CLIENT  10.77.10.0/24
 */

export const VS_WG_SUBNET = '10.77.0.0/16';
export const VS_WG_SERVER_IP = '10.77.0.1';
export const VS_WG_ADMIN_POOL_START = 2; // 10.77.0.2 …
export const VS_WG_ADMIN_POOL_END = 254;
export const VS_WG_CLIENT_PREFIX = '10.77.10.';
export const VS_WG_CLIENT_POOL_START = 1;
export const VS_WG_CLIENT_POOL_END = 254;
export const VS_WG_LISTEN_PORT_DEFAULT = 51820;
export const VS_WG_INTERFACE_DEFAULT = 'vs0';

export type DeviceType = 'SERVER' | 'ADMIN' | 'CLIENT';
export type DeviceStatus = 'NEW' | 'PENDING_APPROVAL' | 'ACTIVE' | 'REVOKED';
export type ConnectionState = 'CONNECTED' | 'STALE' | 'DISCONNECTED' | 'REVOKED';

export type VsRole = 'SERVER' | 'OWNER_ADMIN' | 'CLIENT';

export const STALE_AFTER_MS = 30_000;
export const DISCONNECT_AFTER_MS = 90_000;
