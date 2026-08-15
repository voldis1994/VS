/**
 * VS Private Network — product addressing + internal service catalog.
 *
 * User-facing identity is SERVER_ID (e.g. VS-CORE-01).
 * Ports/paths are INTERNAL implementation detail — Connection Manager resolves them.
 *
 * Addressing:
 *   SERVER INFRASTRUCTURE  10.77.0.0/24
 *   VS SERVER              10.77.0.1
 *   ADMIN DEVICES          10.77.1.0/24
 *   CLIENT DEVICES         10.77.10.0/20
 */

export const VS_WG_SUPERNET = '10.77.0.0/16';
export const VS_WG_SUBNET = VS_WG_SUPERNET; // AllowedIPs for peers (full VS private space)
export const VS_WG_SERVER_INFRA = '10.77.0.0/24';
export const VS_WG_SERVER_IP = '10.77.0.1';
export const VS_WG_ADMIN_NET = '10.77.1.0/24';
export const VS_WG_CLIENT_NET = '10.77.10.0/20';

export const VS_WG_ADMIN_POOL_START = 1; // 10.77.1.1 …
export const VS_WG_ADMIN_POOL_END = 254;
export const VS_WG_CLIENT_POOL_START = 1; // 10.77.10.1 … through 10.77.25.254 (/20)
export const VS_WG_CLIENT_POOL_END = 4094; // 16*256 - 2 usable host slots in /20 (practical counter)

export const VS_WG_LISTEN_PORT_DEFAULT = 51820;
export const VS_WG_INTERFACE_DEFAULT = 'vs0';

/** Default SERVER identity — not a hostname users type as IP:PORT. */
export const VS_DEFAULT_SERVER_ID = 'VS-CORE-01';

/**
 * Internal service catalog — never shown as ":3000" for end users to type.
 * Connection Manager resolves these from SERVER_ID + network readiness.
 */
export const VS_INTERNAL_SERVICES = {
  CONTROL_API: {
    id: 'CONTROL_API',
    private_host: VS_WG_SERVER_IP,
    private_port: 3000,
    path_prefix: '/api/v1',
  },
  NETWORK_AUTHORITY: {
    id: 'NETWORK_AUTHORITY',
    private_host: VS_WG_SERVER_IP,
    private_port: 3000,
    path_prefix: '/api/v1/network',
  },
  ADMIN_SERVICE: {
    id: 'ADMIN_SERVICE',
    private_host: VS_WG_SERVER_IP,
    private_port: 3000,
    path_prefix: '/api/v1/admin',
  },
  CLIENT_SERVICE: {
    id: 'CLIENT_SERVICE',
    private_host: VS_WG_SERVER_IP,
    private_port: 3000,
    path_prefix: '/api/v1',
  },
} as const;

export type DeviceType = 'SERVER' | 'ADMIN' | 'CLIENT';
export type DeviceStatus = 'NEW' | 'PENDING_APPROVAL' | 'ACTIVE' | 'REVOKED';
export type ConnectionState = 'CONNECTED' | 'STALE' | 'DISCONNECTED' | 'REVOKED';

export type VsRole = 'SERVER' | 'OWNER_ADMIN' | 'CLIENT';

export const STALE_AFTER_MS = 30_000;
export const DISCONNECT_AFTER_MS = 90_000;

/** Enrollment tokens: short-lived (default 30 minutes). */
export const ENROLLMENT_TTL_MS = 30 * 60 * 1000;

/** Convert linear client host index (1..) → 10.77.10.0/20 address. */
export function clientHostIndexToIp(index: number): string {
  if (index < 1 || index > VS_WG_CLIENT_POOL_END) {
    throw new Error('CLIENT_IP_POOL_EXHAUSTED');
  }
  // 10.77.10.0/20 → third octet 10..25, fourth 0..255; skip network .0 and broadcast of last
  const offset = index; // 1 → 10.77.10.1
  const third = 10 + Math.floor(offset / 256);
  const fourth = offset % 256;
  if (third > 25) throw new Error('CLIENT_IP_POOL_EXHAUSTED');
  return `10.77.${third}.${fourth}`;
}

export function adminHostIndexToIp(index: number): string {
  if (index < VS_WG_ADMIN_POOL_START || index > VS_WG_ADMIN_POOL_END) {
    throw new Error('ADMIN_IP_POOL_EXHAUSTED');
  }
  return `10.77.1.${index}`;
}
