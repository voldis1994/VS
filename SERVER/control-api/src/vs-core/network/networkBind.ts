/**
 * Production bind policy — fail closed.
 *
 * NEVER:
 *   WireGuard FAIL → fallback public HTTP
 *   fallback 0.0.0.0
 *   "warn and continue" with management publicly available
 *
 * When VS_PRIVATE_NETWORK=1 and WireGuard is not READY → throw (management NOT READY).
 */

import { networkInterfaces } from 'os';
import { VS_WG_SERVER_IP, VS_WG_INTERFACE_DEFAULT } from './networkConstants.js';

export type BindDecision = {
  host: string;
  reason: string;
  public_management_exposure: 'NONE' | 'DENIED_DEFAULT' | string;
  wireguard_ready: boolean;
};

export function findWireGuardIpv4(ifaceName: string): string | null {
  const ifaces = networkInterfaces();
  const list = ifaces[ifaceName];
  if (!list) return null;
  for (const a of list) {
    if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

export function isWireGuardReady(
  env: NodeJS.ProcessEnv = process.env
): { ready: boolean; ip: string | null; iface: string } {
  const iface = env.VS_WG_INTERFACE || VS_WG_INTERFACE_DEFAULT;
  const ip = findWireGuardIpv4(iface);
  return { ready: Boolean(ip), ip, iface };
}

/**
 * Resolve CONTROL_API listen host.
 * - Default: 127.0.0.1
 * - VS_PRIVATE_NETWORK=1: require WireGuard UP; bind private IP only (no public fallback)
 * - Explicit CONTROL_API_HOST=0.0.0.0 → refuse in production/private-network
 */
export function resolveManagementBind(env: NodeJS.ProcessEnv = process.env): BindDecision {
  const explicit = env.CONTROL_API_HOST;
  const isProd = env.NODE_ENV === 'production';
  const privateNet = env.VS_PRIVATE_NETWORK === '1' || env.VS_PRIVATE_NETWORK === 'true';
  const wg = isWireGuardReady(env);

  if (explicit === '0.0.0.0' || explicit === '::') {
    if (isProd || privateNet) {
      throw new Error(
        'PUBLIC_BIND_DENIED: management API must not bind 0.0.0.0 in production/private-network mode'
      );
    }
    return {
      host: explicit,
      reason: 'DEV_ONLY_PUBLIC_BIND',
      public_management_exposure: 'DEV_OVERRIDE',
      wireguard_ready: wg.ready,
    };
  }

  if (privateNet) {
    // Fail closed: do not fall back to localhost/public when WG is down
    // Tests may set VS_PRIVATE_NETWORK_ALLOW_UNBOUND=1 to exercise registry without iface
    const allowUnbound =
      env.VS_PRIVATE_NETWORK_ALLOW_UNBOUND === '1' ||
      env.NODE_ENV === 'test' ||
      env.VITEST === 'true';

    if (!wg.ready && !allowUnbound) {
      throw new Error(
        'WIREGUARD_NOT_READY: VS_PRIVATE_NETWORK=1 but WireGuard interface is down — management NOT READY (no public HTTP fallback)'
      );
    }

    const host = wg.ip || (allowUnbound ? VS_WG_SERVER_IP : null);
    if (!host) {
      throw new Error('WIREGUARD_NOT_READY: no private address');
    }

    if (explicit && explicit !== '' && explicit !== host && explicit !== VS_WG_SERVER_IP) {
      // Explicit private bind still OK if it's the catalog server IP
      if (explicit === '127.0.0.1' && !allowUnbound) {
        throw new Error(
          'PRIVATE_NETWORK_LOCALHOST_FALLBACK_DENIED: refuse localhost fallback when VS_PRIVATE_NETWORK=1'
        );
      }
    }

    return {
      host: explicit && explicit !== '' ? explicit : host,
      reason: wg.ready ? 'VS_PRIVATE_NETWORK_WG_READY' : 'VS_PRIVATE_NETWORK_TEST_UNBOUND',
      public_management_exposure: 'NONE',
      wireguard_ready: wg.ready,
    };
  }

  if (explicit && explicit !== '') {
    return {
      host: explicit,
      reason: 'EXPLICIT_CONTROL_API_HOST',
      public_management_exposure: 'NONE',
      wireguard_ready: wg.ready,
    };
  }

  return {
    host: '127.0.0.1',
    reason: 'DEFAULT_LOCALHOST',
    public_management_exposure: 'NONE',
    wireguard_ready: wg.ready,
  };
}
