/**
 * Production bind policy — never default to public 0.0.0.0.
 * Management services listen on localhost and/or VS WireGuard interface only.
 */

import { networkInterfaces } from 'os';
import { VS_WG_SERVER_IP, VS_WG_INTERFACE_DEFAULT } from './networkConstants.js';

export type BindDecision = {
  host: string;
  reason: string;
  public_management_exposure: 'NONE' | 'DENIED_DEFAULT' | string;
};

/**
 * Resolve CONTROL_API listen host.
 * - Default: 127.0.0.1
 * - VS_PRIVATE_NETWORK=1: prefer WireGuard IP if present, else 127.0.0.1
 * - Explicit CONTROL_API_HOST=0.0.0.0 in production → refuse (FAIL CLOSED)
 */
export function resolveManagementBind(env: NodeJS.ProcessEnv = process.env): BindDecision {
  const explicit = env.CONTROL_API_HOST;
  const isProd = env.NODE_ENV === 'production';
  const privateNet = env.VS_PRIVATE_NETWORK === '1' || env.VS_PRIVATE_NETWORK === 'true';

  if (explicit === '0.0.0.0' || explicit === '::') {
    if (isProd || privateNet) {
      throw new Error(
        'PUBLIC_BIND_DENIED: management API must not bind 0.0.0.0 in production/private-network mode'
      );
    }
    // Dev-only allowance with explicit warning marker
    return {
      host: explicit,
      reason: 'DEV_ONLY_PUBLIC_BIND',
      public_management_exposure: 'DEV_OVERRIDE',
    };
  }

  if (explicit && explicit !== '') {
    return {
      host: explicit,
      reason: 'EXPLICIT_CONTROL_API_HOST',
      public_management_exposure: 'NONE',
    };
  }

  if (privateNet) {
    const wgIp = findWireGuardIpv4(env.VS_WG_INTERFACE || VS_WG_INTERFACE_DEFAULT) || VS_WG_SERVER_IP;
    // Bind all VS private interface addresses via specific IP when available
    return {
      host: wgIp,
      reason: 'VS_PRIVATE_NETWORK',
      public_management_exposure: 'NONE',
    };
  }

  return {
    host: '127.0.0.1',
    reason: 'DEFAULT_LOCALHOST',
    public_management_exposure: 'NONE',
  };
}

export function findWireGuardIpv4(ifaceName: string): string | null {
  const ifaces = networkInterfaces();
  const list = ifaces[ifaceName];
  if (!list) return null;
  for (const a of list) {
    if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}
